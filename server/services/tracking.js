// Live tracking: follow each job's BL / booking / container / AWB with the configured provider,
// move the job to departed / arrived on its own, email milestones and ETA changes, and serve the public tracking page.
import crypto from 'node:crypto';
import { q, one, currentTenant } from '../db.js';
import { getProvider, providerList } from './trackingProviders/index.js';
import { milestoneFrom, bestEta, hoursBetween, EVENT_CODES } from '../engines/tracking.js';
import { getSetting, getTrackingConfig } from './settings.js';
import { mailRequester, mailBookingAgent } from './requesterMail.js';
import { milestoneEmail } from './templates.js';
import { appUrl } from './systemMail.js';
import { audit } from './audit.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
export { providerList };

// ---------------- public link ----------------
export async function trackToken(jobId) {
  const j = await one('SELECT track_token FROM jobs WHERE id=$1', [jobId]);
  if (j?.track_token) return j.track_token;
  const token = `${currentTenant().id}.${crypto.randomBytes(18).toString('base64url')}`;
  await q('UPDATE jobs SET track_token=$1 WHERE id=$2', [token, jobId]);
  return token;
}
export const trackUrlFor = async (jobId) => `${appUrl()}/track/${await trackToken(jobId)}`;
export const tenantOfToken = (token) => Number(String(token || '').split('.')[0]) || null;

/** New link: the old one stops working. */
export async function resetTrackLink(jobId) {
  await q('UPDATE jobs SET track_token=NULL WHERE id=$1', [jobId]);
  return trackToken(jobId);
}

// ---------------- what to track ----------------
/** BL / booking / container numbers (sea) or AWB (air) from the main-freight bookings. */
async function identifiers(job) {
  const rfq = await one('SELECT mode FROM rfqs WHERE id=$1', [job.rfq_id]);
  const air = rfq?.mode === 'AIR';
  const bookings = await q("SELECT * FROM bookings WHERE job_id=$1 AND status<>'cancelled' AND 'freight' = ANY(legs)", [job.id]);
  const out = [];
  // a house in a consol is tracked on the consol's master AWB / BL
  const consol = job.consol_id ? await one('SELECT mawb FROM consols WHERE id=$1', [job.consol_id]) : null;
  if (consol?.mawb) out.push({ booking_id: null, mode: air ? 'air' : 'sea', number: air ? consol.mawb.replace(/\s+/g, '') : consol.mawb.trim(), number_type: air ? 'AWB' : 'BL' });
  for (const b of bookings) {
    if (air) {
      if (b.mbl_awb) out.push({ booking_id: b.id, mode: 'air', number: b.mbl_awb.replace(/\s+/g, ''), number_type: 'AWB' });
    } else if (b.mbl_awb) out.push({ booking_id: b.id, mode: 'sea', number: b.mbl_awb.trim(), number_type: 'BL' });
    else if (b.booking_no) out.push({ booking_id: b.id, mode: 'sea', number: b.booking_no.trim(), number_type: 'BK' });
    else for (const c of b.container_nos || []) if (c) out.push({ booking_id: b.id, mode: 'sea', number: c.replace(/\s+/g, ''), number_type: 'CT' });
  }
  return out;
}

/** Create tracking rows for numbers we know but don't track yet. */
export async function ensureTracking(jobId) {
  const cfg = await getTrackingConfig();
  if (!cfg.enabled || !getProvider(cfg.provider)) return 0;
  const job = await one('SELECT * FROM jobs WHERE id=$1', [jobId]);
  if (!job.track_enabled) return 0;
  let n = 0;
  for (const idf of await identifiers(job)) {
    const r = await one('INSERT INTO tracking(job_id,booking_id,provider,mode,number,number_type) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (job_id, number) DO NOTHING RETURNING id', [jobId, idf.booking_id, cfg.provider, idf.mode, idf.number, idf.number_type]);
    if (r) n++;
  }
  return n;
}

/** Add a number by hand (e.g. a container the agent mentioned by phone). */
export async function addTrackingNumber(jobId, { number, number_type, mode }) {
  const cfg = await getTrackingConfig();
  if (!number) throw err('Enter a number');
  await q('INSERT INTO tracking(job_id,provider,mode,number,number_type) VALUES($1,$2,$3,$4,$5) ON CONFLICT (job_id, number) DO UPDATE SET active=true, next_poll_at=now()', [jobId, cfg.provider, mode === 'air' ? 'air' : 'sea', String(number).trim(), number_type || null]);
}

export async function removeTracking(trackingId) {
  const t = await one('DELETE FROM tracking WHERE id=$1 RETURNING job_id', [trackingId]);
  return t?.job_id;
}

// ---------------- polling ----------------
export async function refreshTracking(trackingId) {
  const t = await one('SELECT * FROM tracking WHERE id=$1', [trackingId]);
  const cfg = await getTrackingConfig();
  const provider = getProvider(t.provider);
  if (!provider) throw err(`Unknown tracking provider ${t.provider}`);
  if (!cfg.key) throw err(`No ${provider.name} API key. Add it in Settings → Tracking.`);
  try {
    const snap = await provider.track({ number: t.number, type: t.number_type === 'AWB' ? null : t.number_type, mode: t.mode, key: cfg.key });
    const { events, ...rest } = snap;
    // estimates are replaced by each new answer; actual events are kept
    await q('DELETE FROM tracking_events WHERE tracking_id=$1 AND actual=false', [t.id]);
    for (const e of events || []) {
      await q(
        'INSERT INTO tracking_events(job_id,tracking_id,code,description,location,at,actual,container,vessel,voyage) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING',
        [t.job_id, t.id, e.code, e.description, e.location, e.at, e.actual, e.container, e.vessel, e.voyage]
      );
    }
    const done = snap.status === 'delivered';
    await q(
      `UPDATE tracking SET snapshot=$1, status=$2, last_polled_at=now(), last_error=NULL, active=$3,
         next_poll_at=now() + ($4 || ' hours')::interval WHERE id=$5`,
      [JSON.stringify({ ...rest, events_count: events?.length || 0 }), snap.status, !done, String(Math.max(1, Number(cfg.poll_hours) || 6)), t.id]
    );
    return snap;
  } catch (e) {
    // back off on errors so a wrong number does not burn the quota
    await q("UPDATE tracking SET last_error=$1, last_polled_at=now(), next_poll_at=now() + interval '12 hours' WHERE id=$2", [e.message.slice(0, 500), t.id]);
    throw e;
  }
}

/** Use the latest snapshots: move the job forward, email milestones and ETA changes. */
export async function applyTracking(jobId) {
  const cfg = await getTrackingConfig();
  const job = await one('SELECT * FROM jobs WHERE id=$1', [jobId]);
  const rows = await q('SELECT t.*, (SELECT json_agg(e ORDER BY e.at) FROM tracking_events e WHERE e.tracking_id=t.id) AS events FROM tracking t WHERE t.job_id=$1 AND t.last_polled_at IS NOT NULL', [jobId]);
  if (!rows.length) return null;
  const snaps = rows.map((r) => ({ ...r.snapshot, events: r.events || [] }));
  if (cfg.auto_milestones) {
    const m = milestoneFrom(job.status, snaps);
    if (m) {
      await applyMilestone(jobId, m.status, m.date);
      await audit(null, `Job ${m.status} (from live tracking)`, { entity: 'job', entityId: jobId, rfqId: job.rfq_id, jobId, summary: job.ref });
      await notifyMilestone(jobId, m.status).catch((e) => console.error('milestone mail', e.message));
    }
  }
  // ETA moved by more than the threshold since we last told the customer
  const eta = snaps.map(bestEta).filter(Boolean).sort().pop();
  if (eta) await q('UPDATE jobs SET first_eta=coalesce(first_eta,$1) WHERE id=$2', [eta, jobId]); // to learn lane punctuality
  import('./delay.js').then((m) => m.assessJob(jobId)).catch((e) => console.error('delay assess', e.message));
  const last = job.last_notified?.eta_value;
  if (eta && last && Math.abs(hoursBetween(last, eta)) >= Number(cfg.eta_change_hours || 24) && !['arrived', 'completed', 'cancelled'].includes((await one('SELECT status FROM jobs WHERE id=$1', [jobId])).status)) {
    await notifyMilestone(jobId, 'eta', { previous_eta: last }).catch((e) => console.error('eta mail', e.message));
  } else if (eta && !last) {
    await q("UPDATE jobs SET last_notified = coalesce(last_notified,'{}'::jsonb) || jsonb_build_object('eta_value', $1::text) WHERE id=$2", [eta, jobId]);
  }
  return true;
}

/** Background: jobs that are booked or moving. */
export async function trackingSweep() {
  const cfg = await getTrackingConfig();
  if (!cfg.enabled || !cfg.key) return 0;
  const jobs = await q("SELECT id FROM jobs WHERE status IN ('booked','booking_requested','departed','arrived') AND track_enabled");
  let n = 0;
  for (const j of jobs) {
    await ensureTracking(j.id);
    const due = await q('SELECT id FROM tracking WHERE job_id=$1 AND active AND next_poll_at <= now()', [j.id]);
    for (const t of due) {
      try { await refreshTracking(t.id); n++; } catch (e) { console.error('tracking', t.id, e.message); }
    }
    if (due.length) await applyTracking(j.id).catch((e) => console.error('apply tracking', e.message));
  }
  return n;
}

/** "Refresh now" on the job page. */
export async function refreshJob(jobId) {
  await ensureTracking(jobId);
  const rows = await q('SELECT id FROM tracking WHERE job_id=$1', [jobId]);
  if (!rows.length) throw err('Nothing to track yet: add the BL / booking / container number (or AWB) to the main-freight booking, or add a number here.');
  const errors = [];
  for (const t of rows) {
    try { await refreshTracking(t.id); } catch (e) { errors.push(e.message); }
  }
  await applyTracking(jobId);
  if (errors.length === rows.length) throw err(errors[0]);
  return errors;
}

// ---------------- milestones ----------------
/** Set a milestone on the job (shared by people and tracking). */
export async function applyMilestone(jobId, status, date, { override = false } = {}) {
  const d = date || new Date().toISOString().slice(0, 10);
  const set = (col) => (override ? '$2::date' : `coalesce(${col},$2::date)`);
  await q(
    `UPDATE jobs SET status=$1,
       atd=CASE WHEN $1='departed' THEN ${set('atd')} ELSE atd END,
       ata=CASE WHEN $1='arrived' THEN ${set('ata')} ELSE ata END,
       closed_at=CASE WHEN $1 IN ('completed','cancelled') THEN now() ELSE closed_at END
     WHERE id=$3`,
    [status, d, jobId]
  );
}

async function milestoneInfo(job, rfq) {
  const snaps = (await q('SELECT snapshot FROM tracking WHERE job_id=$1 AND last_polled_at IS NOT NULL', [job.id])).map((r) => r.snapshot);
  const freight = await one("SELECT * FROM bookings WHERE job_id=$1 AND 'freight' = ANY(legs) AND status<>'cancelled' ORDER BY id LIMIT 1", [job.id]);
  const s = snaps[0] || {};
  const eta = snaps.map(bestEta).filter(Boolean).sort().pop() || freight?.eta || null;
  return {
    pol: s.pol || freight?.pol || rfq.pol, pod: s.pod || freight?.pod || rfq.pod,
    vessel: s.vessel || freight?.vessel, voyage: s.voyage || freight?.voyage, flight: s.flight || freight?.flight_no,
    atd: s.etd?.actual ? s.etd.at : job.atd, eta: s.eta?.actual ? s.eta.at : eta, arrived: !!s.eta?.actual || ['arrived', 'completed'].includes(job.status),
    bl: freight?.mbl_awb,
  };
}

/** Email the requester (and, if switched on for the job, the partner agents) about a milestone. Once per milestone. */
export async function notifyMilestone(jobId, kind, extra = {}) {
  const cfg = await getTrackingConfig();
  const job = await one('SELECT * FROM jobs WHERE id=$1', [jobId]);
  if (!cfg.email_milestones || !job.rfq_id) return false;
  if (!['eta', 'delay'].includes(kind) && job.last_notified?.[kind]) return false;
  const rfq = await one('SELECT * FROM rfqs WHERE id=$1', [job.rfq_id]);
  const info = { ...(await milestoneInfo(job, rfq)), ...extra };
  const trackUrl = job.track_enabled ? await trackUrlFor(jobId) : null;
  await mailRequester(job.rfq_id, (c) => milestoneEmail({ ...c, job, kind, info, trackUrl }), { kind: `milestone_${kind}`, refSuffix: job.ref, jobId });
  if (job.notify_agents) {
    for (const b of await q("SELECT id FROM bookings WHERE job_id=$1 AND source<>'own' AND status<>'cancelled'", [jobId])) {
      await mailBookingAgent(b.id, (c) => milestoneEmail({ ...c, customer: c.agent, job, kind, info, toAgent: true }), { kind: `milestone_${kind}` }).catch((e) => console.error('agent milestone', e.message));
    }
  }
  const patch = { [kind]: new Date().toISOString(), ...(info.eta ? { eta_value: String(info.eta).replace('T', ' ').slice(0, 16) } : {}) };
  await q("UPDATE jobs SET last_notified = coalesce(last_notified,'{}'::jsonb) || $1::jsonb WHERE id=$2", [JSON.stringify(patch), jobId]);
  return true;
}

// ---------------- views ----------------
export async function trackingState(jobId) {
  const cfg = await getTrackingConfig();
  const rows = await q('SELECT id, booking_id, provider, mode, number, number_type, active, status, snapshot, last_polled_at, next_poll_at, last_error FROM tracking WHERE job_id=$1 ORDER BY id', [jobId]);
  const events = await q('SELECT * FROM tracking_events WHERE job_id=$1 ORDER BY at DESC NULLS LAST, id DESC LIMIT 200', [jobId]);
  const job = await one('SELECT track_token, track_enabled, notify_agents, last_notified FROM jobs WHERE id=$1', [jobId]);
  return {
    configured: !!(cfg.enabled && cfg.key && getProvider(cfg.provider)),
    provider: getProvider(cfg.provider)?.name || cfg.provider,
    rows, events,
    url: job.track_token ? `${appUrl()}/track/${job.track_token}` : null,
    enabled: job.track_enabled, notify_agents: job.notify_agents, last_notified: job.last_notified || {},
  };
}

export async function setJobTracking(jobId, { track_enabled, notify_agents }) {
  if (track_enabled !== undefined) await q('UPDATE jobs SET track_enabled=$1 WHERE id=$2', [!!track_enabled, jobId]);
  if (notify_agents !== undefined) await q('UPDATE jobs SET notify_agents=$1 WHERE id=$2', [!!notify_agents, jobId]);
}

const STEPS = ['booked', 'departed', 'arrived', 'completed'];

/** What the public page shows: no costs, no agents, no internal notes. */
export async function publicTracking(token) {
  const job = await one('SELECT * FROM jobs WHERE track_token=$1', [token]);
  if (!job || !job.track_enabled) return null;
  const rfq = await one('SELECT mode, pol, pod, pickup_place, delivery_place, commodity, containers, packages, gross_weight_kg, volume_cbm FROM rfqs WHERE id=$1', [job.rfq_id]);
  const company = await getSetting('company');
  const bookings = await q("SELECT legs, status, carrier, booking_no, vessel, voyage, flight_no, mbl_awb, pol, pod, etd, eta, cutoffs, container_nos FROM bookings WHERE job_id=$1 AND status<>'cancelled' ORDER BY id", [job.id]);
  const freight = bookings.find((b) => (b.legs || []).includes('freight')) || bookings[0] || {};
  const rows = await q('SELECT mode, number, number_type, status, snapshot, last_polled_at FROM tracking WHERE job_id=$1 ORDER BY id', [job.id]);
  const events = await q('SELECT code, description, location, at, actual, container, vessel, voyage FROM tracking_events WHERE job_id=$1 ORDER BY at NULLS LAST, id', [job.id]);
  const s = rows.find((r) => r.snapshot?.pol)?.snapshot || {};
  const step = job.status === 'cancelled' ? null : Math.max(0, STEPS.indexOf(['open', 'booking_requested'].includes(job.status) ? 'booked' : job.status));
  return {
    company: { name: company.name, logo: company.logo || null, phone: company.phone, email: company.email },
    ref: job.ref, customer_ref: job.customer_ref, status: job.status, step, steps: STEPS,
    mode: rfq?.mode, route: { from: rfq?.pickup_place || null, pol: s.pol || freight.pol || rfq?.pol, pod: s.pod || freight.pod || rfq?.pod, to: rfq?.delivery_place || null },
    carrier: s.carrier || freight.carrier || null,
    vessel: s.vessel || freight.vessel || null, voyage: s.voyage || freight.voyage || null, flight: s.flight || freight.flight_no || null,
    bl_no: job.bl_no || freight.mbl_awb || null, booking_no: freight.booking_no || null,
    etd: s.etd || (freight.etd ? { at: freight.etd, actual: !!job.atd } : null),
    eta: s.eta || (freight.eta ? { at: freight.eta, actual: !!job.ata } : null),
    predicted_eta: s.predicted_eta || null,
    atd: job.atd, ata: job.ata,
    position: s.position || null, path: s.path || [],
    containers: s.containers?.length ? s.containers : (freight.container_nos || []).map((n) => ({ number: n })),
    cargo: { commodity: rfq?.commodity, packages: rfq?.packages, weight: rfq?.gross_weight_kg, cbm: rfq?.volume_cbm, containers: rfq?.containers },
    cutoffs: ['booked', 'booking_requested', 'open'].includes(job.status) ? freight.cutoffs || {} : {},
    events: events.map((e) => ({ ...e, label: EVENT_CODES[e.code] })),
    live: rows.length > 0,
    updated_at: rows.map((r) => r.last_polled_at).filter(Boolean).sort().pop() || null,
  };
}
