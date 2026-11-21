// Delay prediction (pure). Carriers update their ETA late; the signs of a delay show up earlier
// in the tracking events. This reads those signs, plus how this lane and carrier performed on past
// jobs, and predicts the arrival, the delay and how likely it is, with the reasons.
//
// Signals (each with a probability and an expected slip):
//  - ETA already passed with no arrival            → late by now − ETA
//  - not departed some hours after the planned ETD → slips by the same amount
//  - cargo rolled (vessel / flight changed)        → typical next sailing / flight
//  - carrier ETA later than the booked ETA         → already late
//  - long stop at a transshipment port             → slip by the extra wait
//  - no tracking news for a long time              → uncertain
//  - this lane / carrier is usually late           → median slip from past jobs

const H = 3600e3;
const parse = (v) => {
  if (!v) return null;
  const s = String(v);
  const t = Date.parse(s.length <= 10 ? `${s}T12:00Z` : `${s.replace(' ', 'T').slice(0, 16)}Z`);
  return Number.isFinite(t) ? t : null;
};
const fmt = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const days = (h) => (Math.abs(h) >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} h`);

/** Defaults per mode: how long a transshipment stop is normal, how long tracking may stay quiet, a typical roll-over. */
const NORMS = {
  sea: { tsHours: 96, quietHours: 10 * 24, rollHours: 7 * 24, departGraceHours: 24 },
  air: { tsHours: 24, quietHours: 36, rollHours: 24, departGraceHours: 6 },
};

/**
 * Learn lane / carrier punctuality from finished jobs. jobs: [{ lane, carrier, first_eta, arrived_at }].
 * Returns { [key]: { n, median, late } } with keys `lane` and `lane|carrier`.
 */
export function lanePunctuality(jobs) {
  const g = {};
  for (const j of jobs) {
    const a = parse(j.arrived_at);
    const e = parse(j.first_eta);
    if (a === null || e === null) continue;
    const slip = (a - e) / H;
    for (const k of [j.lane, j.carrier ? `${j.lane}|${String(j.carrier).toUpperCase()}` : null].filter(Boolean)) (g[k] ??= []).push(slip);
  }
  return Object.fromEntries(Object.entries(g).map(([k, s]) => {
    const sorted = [...s].sort((x, y) => x - y);
    return [k, { n: s.length, median: Math.round(sorted[Math.floor(sorted.length / 2)]), late: s.filter((x) => x > 24).length / s.length }];
  }));
}

/**
 * job: { mode: 'sea'|'air', status, lane, carrier }
 * plan: { etd, eta, vessel, flight }   (from the booking)
 * snap: { etd: {at, actual}, eta: {at, actual}, predicted_eta, vessel, flight }  (best tracking snapshot, may be {})
 * events: [{ code, at, actual, location, vessel }]
 * punctuality: lanePunctuality() result; now: ms
 */
export function predictDelay({ job, plan = {}, snap = {}, events = [], punctuality = {}, now = Date.now() }) {
  const mode = job.mode === 'air' || job.mode === 'AIR' ? 'air' : 'sea';
  const N = NORMS[mode];
  const signals = [];
  const add = (type, p, slipHours, text) => signals.push({ type, p, slip: Math.max(0, Math.round(slipHours || 0)), text });
  if (['arrived', 'completed', 'cancelled'].includes(job.status) || snap.eta?.actual) return { risk: 'arrived', signals: [] };

  const planEta = parse(plan.eta);
  const carrierEta = parse(snap.predicted_eta || snap.eta?.at);
  const baseEta = carrierEta ?? planEta;
  const actual = events.filter((e) => e.actual !== false);
  const departed = actual.some((e) => ['departed', 'loaded'].includes(e.code)) || snap.etd?.actual || ['departed'].includes(job.status);

  // 1. ETA passed, no arrival
  if (baseEta !== null && now > baseEta + 6 * H) add('eta_passed', 0.95, (now - baseEta) / H, `Expected arrival ${fmt(baseEta)} has passed with no arrival reported.`);

  // 2. departure overdue
  const planEtd = parse(snap.etd?.at || plan.etd);
  if (!departed && planEtd !== null && now > planEtd + N.departGraceHours * H) {
    const late = (now - planEtd) / H;
    add('not_departed', Math.min(0.95, 0.6 + late / (N.rollHours * 2)), late, `Not reported as departed ${days(late)} after the planned departure.`);
  }

  // 3. rolled: vessel / flight differs from the booking
  const booked = String(mode === 'air' ? plan.flight || '' : plan.vessel || '').toUpperCase().replace(/\s+/g, '');
  const tracked = String(mode === 'air' ? snap.flight || '' : snap.vessel || '').toUpperCase().replace(/\s+/g, '');
  if (booked && tracked && !tracked.includes(booked) && !booked.includes(tracked)) add('rolled', 0.8, N.rollHours, `Moved from ${mode === 'air' ? 'flight' : 'vessel'} ${plan.flight || plan.vessel} to ${snap.flight || snap.vessel}: cargo was probably rolled.`);

  // 4. carrier already shows a later ETA than booked
  if (planEta !== null && carrierEta !== null && carrierEta - planEta > 24 * H) add('eta_moved', 0.9, (carrierEta - planEta) / H, `Carrier's ETA ${fmt(carrierEta)} is ${days((carrierEta - planEta) / H)} after the booked ETA.`);

  // 5. long transshipment stop
  const last = [...actual].sort((a, b) => (parse(a.at) ?? 0) - (parse(b.at) ?? 0)).pop();
  if (last && ['transshipment', 'discharged'].includes(last.code) && departed) {
    const wait = (now - (parse(last.at) ?? now)) / H;
    if (wait > N.tsHours) add('transshipment_wait', Math.min(0.85, 0.4 + (wait - N.tsHours) / (N.tsHours * 4)), wait - N.tsHours, `Waiting ${days(wait)} at ${last.location || 'the transshipment port'} (normal is up to ${days(N.tsHours)}).`);
  }

  // 6. tracking quiet while moving
  if (departed && last) {
    const quiet = (now - (parse(last.at) ?? now)) / H;
    if (quiet > N.quietHours && !(baseEta !== null && now < baseEta - 24 * H && mode === 'sea')) add('quiet', 0.3, 0, `No tracking news for ${days(quiet)}.`);
  }

  // 7. lane / carrier history
  const hist = (job.carrier && punctuality[`${job.lane}|${String(job.carrier).toUpperCase()}`]) || punctuality[job.lane];
  if (hist && hist.n >= 3 && hist.median > 12) add('history', Math.min(0.7, hist.late), hist.median, `On this ${hist === punctuality[job.lane] ? 'route' : 'route with this carrier'}, ${Math.round(hist.late * 100)}% of past shipments arrived over a day late (median ${days(hist.median)}, ${hist.n} jobs).`);

  if (baseEta === null && !signals.length) return { risk: 'unknown', signals: [], text: 'No ETA yet.' };
  const probability = 1 - signals.reduce((acc, s) => acc * (1 - s.p), 1);
  // the largest slip any strong signal implies (signals overlap, so they are not added)
  const strong = signals.filter((s) => s.p >= 0.5);
  const slip = strong.length ? Math.max(...strong.map((s) => s.slip)) : 0;
  const expected = baseEta !== null ? Math.max(baseEta + slip * H, signals.some((s) => s.type === 'eta_passed') ? now + 24 * H : 0) : null;
  const confirmed = signals.some((s) => ['eta_passed', 'eta_moved'].includes(s.type));
  const risk = confirmed ? 'late' : probability >= 0.5 && slip >= 12 ? 'at_risk' : 'on_time';
  return {
    risk, probability: Math.round(probability * 100) / 100, delay_hours: Math.round(slip),
    eta: baseEta !== null ? fmt(baseEta) : null, expected_eta: expected ? fmt(expected) : null,
    signals: signals.sort((a, b) => b.p - a.p),
  };
}
