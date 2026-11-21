// Delay prediction for open jobs (engines/delayRisk.js): runs after each tracking update and on a
// schedule (so "not departed yet" is noticed without new tracking news). Results are kept on the
// job; the desk sees shipments at risk and can warn the customer before they ask.
import { q, one, currentTenant } from '../db.js';
import { predictDelay, lanePunctuality } from '../engines/delayRisk.js';
import { laneOf } from '../engines/agentRank.js';
import { bestEta } from '../engines/tracking.js';
import { getTrackingConfig } from './settings.js';
import { notifyMilestone } from './tracking.js';
import { audit } from './audit.js';

const OPEN = "('booking_requested','booked','departed')";
const cache = new Map();

/** How punctual each lane / carrier was on finished jobs (cached 1 hour). */
async function punctuality() {
  const t = currentTenant();
  const hit = cache.get(t?.id);
  if (hit && Date.now() - hit.at < 3600e3) return hit.p;
  const rows = await q(`SELECT j.first_eta, j.ata AS arrived_at, r.mode, r.pol, r.pod,
      (SELECT carrier FROM bookings b WHERE b.job_id=j.id AND 'freight' = ANY(b.legs) ORDER BY b.id LIMIT 1) AS carrier
    FROM jobs j JOIN rfqs r ON r.id=j.rfq_id WHERE j.ata IS NOT NULL AND j.first_eta IS NOT NULL AND j.ata > now() - interval '2 years'`);
  const p = lanePunctuality(rows.map((r) => ({ lane: laneOf(r), carrier: r.carrier, first_eta: r.first_eta, arrived_at: r.arrived_at })));
  cache.set(t?.id, { at: Date.now(), p });
  return p;
}

/** Predict the delay of one job and keep the result on it. */
export async function assessJob(jobId) {
  const job = await one('SELECT j.*, r.mode AS rfq_mode, r.pol, r.pod FROM jobs j JOIN rfqs r ON r.id=j.rfq_id WHERE j.id=$1', [jobId]);
  if (!job) return null;
  const plan = (await one("SELECT etd, eta, vessel, flight_no, carrier FROM bookings WHERE job_id=$1 AND 'freight' = ANY(legs) AND status<>'cancelled' ORDER BY id LIMIT 1", [jobId])) || {};
  const tracks = await q('SELECT snapshot FROM tracking WHERE job_id=$1 AND last_polled_at IS NOT NULL ORDER BY id', [jobId]);
  const snap = tracks.map((t) => t.snapshot).sort((a, b) => String(bestEta(b) || '').localeCompare(String(bestEta(a) || '')))[0] || {};
  const events = await q('SELECT code, at, actual, location, vessel FROM tracking_events WHERE job_id=$1', [jobId]);
  const r = predictDelay({
    job: { mode: job.rfq_mode === 'AIR' ? 'air' : 'sea', status: job.status, lane: laneOf({ mode: job.rfq_mode, pol: job.pol, pod: job.pod }), carrier: plan.carrier || snap.carrier },
    plan: { etd: plan.etd ? String(plan.etd instanceof Date ? plan.etd.toISOString() : plan.etd).slice(0, 10) : null, eta: plan.eta ? String(plan.eta instanceof Date ? plan.eta.toISOString() : plan.eta).slice(0, 10) : null, vessel: plan.vessel, flight: plan.flight_no },
    snap, events, punctuality: await punctuality(),
  });
  const before = job.delay_risk || {};
  const result = { ...r, assessed_at: new Date().toISOString(), warned_at: before.warned_at || null, warned_eta: before.warned_eta || null };
  await q('UPDATE jobs SET delay_risk=$1 WHERE id=$2', [JSON.stringify(result), jobId]);
  // the first time it turns risky, note it in the job history
  if (['at_risk', 'late'].includes(r.risk) && before.risk !== r.risk) {
    await audit(null, `Delay ${r.risk === 'late' ? 'confirmed' : 'predicted'}`, { entity: 'job', entityId: jobId, rfqId: job.rfq_id, jobId, summary: `${job.ref}: ${r.signals[0]?.text || ''}${r.expected_eta ? ` Expected ${r.expected_eta}.` : ''}` });
    const cfg = await getTrackingConfig();
    if (cfg.auto_delay_email) await warnCustomer(jobId).catch((e) => console.error('delay mail', e.message));
  }
  return result;
}

/** Email the customer about the expected delay (at most once per expected arrival). */
export async function warnCustomer(jobId, user = null) {
  const job = await one('SELECT id, ref, rfq_id, delay_risk FROM jobs WHERE id=$1', [jobId]);
  const r = job?.delay_risk;
  if (!r || !['at_risk', 'late'].includes(r.risk)) throw Object.assign(new Error('No delay expected for this job'), { status: 400 });
  if (r.warned_eta === r.expected_eta) throw Object.assign(new Error('The customer was already told about this arrival date'), { status: 400 });
  let sent;
  try {
    sent = await notifyMilestone(jobId, 'delay', { eta: r.expected_eta, previous_eta: r.eta, reason: r.signals[0]?.text });
  } catch (e) {
    throw Object.assign(new Error(`The email could not be sent: ${e.message}. Check the mailbox in Settings → RFQ mailboxes.`), { status: 502 });
  }
  if (!sent) throw Object.assign(new Error('Milestone emails are switched off in Settings → Tracking'), { status: 400 });
  await q("UPDATE jobs SET delay_risk = delay_risk || jsonb_build_object('warned_at', now()::text, 'warned_eta', $1::text) WHERE id=$2", [r.expected_eta, jobId]);
  await audit(user, 'Customer warned of delay', { entity: 'job', entityId: jobId, rfqId: job.rfq_id, jobId, summary: `${job.ref}: expected ${r.expected_eta}` });
  return assessJob(jobId);
}

/** Background: re-assess every open job (no tracking calls; cheap). */
export async function delaySweep() {
  const jobs = await q(`SELECT id FROM jobs WHERE status IN ${OPEN}`);
  for (const j of jobs) await assessJob(j.id).catch((e) => console.error('delay', j.id, e.message));
  return jobs.length;
}

/** Open jobs at risk or late, worst first. */
export const jobsAtRisk = () => q(`SELECT j.id, j.ref, j.status, j.delay_risk, a.company AS customer, r.mode, r.pol, r.pod
  FROM jobs j JOIN rfqs r ON r.id=j.rfq_id LEFT JOIN agents a ON a.id=j.requester_id
  WHERE j.status IN ${OPEN} AND j.delay_risk->>'risk' IN ('at_risk','late')
  ORDER BY (j.delay_risk->>'risk')='late' DESC, (j.delay_risk->>'probability')::numeric DESC NULLS LAST LIMIT 100`);
