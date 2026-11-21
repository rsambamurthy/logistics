// Planning algorithms for the Quayly agent (pure functions):
//  replyForecast     – will this agent still reply, and when to chase
//  modeAdvice        – air vs LCL vs FCL from cost, transit and the must-arrive date
//  bestCombination   – cheapest mix of agents across legs, with a transit limit and few hand-offs
//  estimateFromHistory – a cost range before any agent replies
//  shipNowOrWait     – hold a shipment for a consol partner or send it now
//  forecastLane      – weekly volume forecast per lane and the space to block
//  rateCardHealth    – cards to renew: expiring, stale, or off the market
//  paymentRisk       – how a customer pays and what terms to give

const H = 3600e3;
const DAY = 24 * H;
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const quantile = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
};

// ---------------------------------------------------------------- reply forecast
/**
 * history: this agent's past invites [{ replied, reply_hours }]; hoursSince: since we sent this RFQ.
 * P(reply eventually | none yet) = r·S(t) / (1 − r + r·S(t)), S(t) = share of their replies slower than t.
 * Chase when they are later than most of their own replies (75th percentile), within 4–48 h.
 */
export function replyForecast(history, hoursSince, { remindersSent = 0 } = {}) {
  const n = history.length;
  const replied = history.filter((h) => h.replied);
  const rate = (replied.length + 1) / (n + 2); // smoothed
  const times = replied.map((h) => Number(h.reply_hours)).filter((x) => Number.isFinite(x) && x >= 0);
  const S = times.length ? (times.filter((x) => x > hoursSince).length + 0.25) / (times.length + 1) : Math.exp(-hoursSince / 24); // never quite zero: anyone can be late once
  const p = (rate * S) / (1 - rate + rate * S || 1);
  const p75 = times.length >= 3 ? quantile(times, 0.75) : 24;
  const chaseAfter = Math.min(48, Math.max(4, p75 * (1 + remindersSent * 0.5)));
  return {
    probability: r2(Math.max(0, Math.min(1, p))), usual_hours: times.length ? r2(quantile(times, 0.5)) : null,
    chase_after_hours: r2(chaseAfter), due_to_chase: hoursSince >= chaseAfter, history: n,
  };
}

/** Enough to move on? quotes = good quotes in; pending = forecasts of agents still out. */
export function readyToCompare(quotes, pending) {
  const stillLikely = pending.filter((p) => p.probability >= 0.3).length;
  if (quotes >= 2 && pending.length && !stillLikely) return { ready: true, text: `${quotes} quotes in; the agents still out are unlikely to reply. You can compare now.` };
  if (quotes >= 2 && !pending.length) return { ready: true, text: 'Every agent has answered.' };
  if (quotes >= 2 && stillLikely) return { ready: false, text: `${quotes} quotes in; ${stillLikely} more likely to come.` };
  return { ready: false, text: quotes ? 'Waiting for more quotes.' : 'Waiting for quotes.' };
}

// ---------------------------------------------------------------- mode advice
/**
 * options: [{ mode, cost, transit_days, source }] (cost in one currency; null when unknown)
 * ctx: { ready (YYYY-MM-DD), deliverBy (YYYY-MM-DD), kg, cbm }
 * Ranks modes: those arriving in time first, then by cost. Adds plain reasons.
 */
export function modeAdvice(options, { ready, deliverBy, kg, cbm } = {}) {
  const start = ready ? Date.parse(`${ready}T00:00Z`) : Date.now();
  const limit = deliverBy ? Date.parse(`${deliverBy}T23:59Z`) : null;
  const rows = options.filter((o) => o.cost !== null || o.transit_days !== null).map((o) => {
    const arrive = o.transit_days !== null ? start + (o.transit_days + (o.mode === 'AIR' ? 2 : 4)) * DAY : null; // + handling days
    const onTime = limit === null || arrive === null ? null : arrive <= limit;
    return { ...o, arrive: arrive ? new Date(arrive).toISOString().slice(0, 10) : null, on_time: onTime };
  });
  rows.sort((a, b) => ((b.on_time !== false) - (a.on_time !== false)) || ((a.cost ?? Infinity) - (b.cost ?? Infinity)));
  const best = rows[0] || null;
  const reasons = [];
  const density = kg && cbm ? kg / cbm : null;
  if (density !== null) reasons.push(density < 167 ? `Light cargo (${Math.round(density)} kg/cbm): air is charged on volume, so it costs relatively more.` : `Dense cargo (${Math.round(density)} kg/cbm): air is charged on weight.`);
  if (cbm) reasons.push(cbm >= 15 ? `${cbm} cbm: a full container is usually cheaper than LCL from about 15 cbm.` : `${cbm} cbm: LCL is usually cheaper than a full container below about 15 cbm.`);
  if (best && limit !== null && best.on_time === false) reasons.push('No mode arrives by the required date; the fastest is shown first.');
  const late = rows.filter((r) => r.on_time === false).map((r) => r.mode);
  if (late.length && best?.on_time) reasons.push(`${late.join(', ')} would arrive after the required date.`);
  return { best, options: rows, reasons };
}

// ---------------------------------------------------------------- best leg combination
/**
 * quotes: [{ id, agent, legs: { [leg]: total }, transit_days }]; legs: legs to cover.
 * opts: { maxTransit, handoffCost } – each extra agent adds handoffCost (co-ordination, risk).
 * Exhaustive search (agents ≤ 12, legs ≤ 6 in practice).
 */
export function bestCombination(quotes, legs, { maxTransit = null, handoffCost = 0 } = {}) {
  const per = legs.map((l) => quotes.filter((q) => q.legs[l] !== undefined && q.legs[l] !== null));
  if (per.some((c) => !c.length)) return null;
  let best = null;
  const pick = (i, chosen) => {
    if (i === legs.length) {
      const freight = chosen[legs.indexOf('freight')] || null;
      if (maxTransit !== null && freight && freight.transit_days !== null && freight.transit_days > maxTransit) return;
      const agents = new Set(chosen.map((c) => c.id));
      const cost = chosen.reduce((s, c, k) => s + Number(c.legs[legs[k]]), 0);
      const score = cost + handoffCost * (agents.size - 1);
      if (!best || score < best.score - 1e-9) best = { score: r2(score), cost: r2(cost), agents: agents.size, selection: Object.fromEntries(legs.map((l, k) => [l, chosen[k].id])), transit_days: freight?.transit_days ?? null };
      return;
    }
    for (const q of per[i]) pick(i + 1, [...chosen, q]);
  };
  pick(0, []);
  return best;
}

// ---------------------------------------------------------------- instant estimate
/**
 * samples: past quotes on the same mode / lane / leg: [{ leg, total, units }] where units = containers
 * (FCL), chargeable kg (air) or cbm (LCL) of that shipment. units: of this shipment — a number, or
 * { [leg]: units } when legs scale differently (customs is per shipment, freight per unit).
 * Returns per leg { low, mid, high, n } scaled per unit, and a total.
 */
export function estimateFromHistory(samples, units, legs) {
  const out = {};
  for (const leg of legs) {
    const per = samples.filter((s) => s.leg === leg && s.units > 0 && s.total > 0).map((s) => s.total / s.units);
    if (per.length < 2) continue;
    const scale = (units && typeof units === 'object' ? Number(units[leg]) : Number(units)) || 1;
    out[leg] = { low: r2(quantile(per, 0.25) * scale), mid: r2(quantile(per, 0.5) * scale), high: r2(quantile(per, 0.75) * scale), n: per.length };
  }
  const vals = Object.values(out);
  if (!vals.length) return null;
  const sum = (k) => r2(vals.reduce((s, v) => s + v[k], 0));
  return { legs: out, low: sum('low'), mid: sum('mid'), high: sum('high'), covered: Object.keys(out), missing: legs.filter((l) => !out[l]), confidence: Math.min(...vals.map((v) => v.n)) >= 8 ? 'good' : Math.min(...vals.map((v) => v.n)) >= 4 ? 'fair' : 'low' };
}

// ---------------------------------------------------------------- ship now or wait
/**
 * Hold a lone shipment for a consol partner? Partners arrive on the lane at `ratePerDay` (Poisson).
 * Each partner is worth `gainPerPartner` (weight gain value). Waiting costs `costPerDay`, and the
 * shipment must leave within `slackDays` (until the cut-off for its must-arrive date).
 */
export function shipNowOrWait({ ratePerDay, gainPerPartner, costPerDay = 0, slackDays }) {
  const maxWait = Math.max(0, Math.min(7, Math.floor(slackDays ?? 0)));
  let best = { days: 0, value: 0, p: 0 };
  for (let d = 1; d <= maxWait; d++) {
    const p = 1 - Math.exp(-ratePerDay * d);
    const value = p * gainPerPartner - d * costPerDay;
    if (value > best.value + 1e-9) best = { days: d, value: r2(value), p: r2(p) };
  }
  if (!best.days) {
    const why = !maxWait ? 'no time to wait before the cut-off' : ratePerDay <= 0 ? 'no other shipments usually come on this lane' : 'waiting is not worth it';
    return { decision: 'ship_now', days: 0, probability: 0, text: `Ship now: ${why}.` };
  }
  return { decision: 'wait', days: best.days, probability: best.p, expected_value: best.value, text: `Wait up to ${best.days} day${best.days > 1 ? 's' : ''}: ${Math.round(best.p * 100)}% chance another shipment joins, worth about ${best.value} in weight gain.` };
}

// ---------------------------------------------------------------- lane volume forecast
/**
 * weekly: volumes for consecutive past weeks (oldest first). Holt's linear smoothing.
 * Returns next `ahead` weeks with p50 / p80 and the space to block (p50 by default).
 */
export function forecastLane(weekly, { ahead = 4, alpha = 0.4, beta = 0.2 } = {}) {
  const w = weekly.map(Number);
  if (w.length < 3 || !w.some((x) => x > 0)) return null;
  let level = w[0];
  let trend = 0;
  const errs = [];
  for (let i = 1; i < w.length; i++) {
    const f = level + trend;
    errs.push(w[i] - f);
    const prev = level;
    level = alpha * w[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  const sd = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / Math.max(1, errs.length));
  const weeks = Array.from({ length: ahead }, (_, k) => {
    const p50 = Math.max(0, level + trend * (k + 1));
    return { week: k + 1, p50: r2(p50), p80: r2(p50 + 0.84 * sd) };
  });
  const avg = w.reduce((s, x) => s + x, 0) / w.length;
  return { weeks, block: r2(weeks[0].p50), trend: r2(trend), average: r2(avg), variability: avg ? r2(sd / avg) : null };
}

// ---------------------------------------------------------------- rate-card health
/**
 * card: { valid_from, valid_to, updated_at }, market: recent agent quotes on its lane as ratio to
 * the card's total for the same shipment (e.g. 0.85 = market 15 % cheaper). today: 'YYYY-MM-DD'.
 */
export function rateCardHealth(card, market = [], today = new Date().toISOString().slice(0, 10)) {
  const issues = [];
  const t = Date.parse(`${today}T00:00Z`);
  const to = card.valid_to ? Date.parse(`${String(card.valid_to).slice(0, 10)}T00:00Z`) : null;
  if (to !== null && to < t) issues.push({ type: 'expired', severity: 'high', text: `Expired ${String(card.valid_to).slice(0, 10)}` });
  else if (to !== null && to - t <= 14 * DAY) issues.push({ type: 'expiring', severity: 'high', text: `Expires in ${Math.round((to - t) / DAY)} days` });
  const since = Date.parse(String(card.updated_at || card.valid_from || today).slice(0, 10) + 'T00:00Z');
  if (t - since > 90 * DAY && !(to !== null && to < t)) issues.push({ type: 'stale', severity: 'low', text: `Not updated for ${Math.round((t - since) / DAY)} days` });
  if (market.length >= 2) {
    const m = quantile(market, 0.5);
    if (m < 0.88) issues.push({ type: 'market_lower', severity: 'high', text: `Recent agent quotes are ${Math.round((1 - m) * 100)}% cheaper (${market.length} quotes): you may be overpricing` });
    else if (m > 1.12) issues.push({ type: 'market_higher', severity: 'high', text: `Recent agent quotes are ${Math.round((m - 1) * 100)}% dearer (${market.length} quotes): this card may be out of date` });
  }
  return { ok: !issues.length, issues };
}

// ---------------------------------------------------------------- customer payment risk
/**
 * invoices: [{ amount, due_date, paid_at, invoice_date }] (one currency). today: 'YYYY-MM-DD'.
 * Grade A–D from on-time share, average days late and overdue now; suggests terms and a limit.
 */
export function paymentRisk(invoices, today = new Date().toISOString().slice(0, 10)) {
  const t = Date.parse(`${today}T00:00Z`);
  const d = (v) => (v ? Date.parse(`${String(v).slice(0, 10)}T00:00Z`) : null);
  const paid = invoices.filter((i) => i.paid_at && i.due_date);
  const lateDays = paid.map((i) => Math.max(0, (d(i.paid_at) - d(i.due_date)) / DAY));
  const open = invoices.filter((i) => !i.paid_at);
  const overdue = open.filter((i) => i.due_date && d(i.due_date) < t);
  const overdueDays = overdue.map((i) => (t - d(i.due_date)) / DAY);
  const onTime = paid.length ? paid.filter((_, k) => lateDays[k] <= 3).length / paid.length : null;
  const avgLate = lateDays.length ? lateDays.reduce((s, x) => s + x, 0) / lateDays.length : null;
  const outstanding = r2(open.reduce((s, i) => s + Number(i.amount || 0), 0));
  const overdueAmt = r2(overdue.reduce((s, i) => s + Number(i.amount || 0), 0));
  const worstOverdue = overdueDays.length ? Math.max(...overdueDays) : 0;
  let score = 70; // neutral for new customers
  if (onTime !== null) score = 100 * (0.5 * onTime + 0.5 * Math.max(0, 1 - (avgLate || 0) / 45));
  score -= Math.min(40, worstOverdue / 2);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = !invoices.length ? 'new' : score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 45 ? 'C' : 'D';
  const avgInvoice = invoices.length ? invoices.reduce((s, i) => s + Number(i.amount || 0), 0) / invoices.length : 0;
  const advice = {
    new: 'New customer: start with advance payment or short credit (7 days) until they have paid a few invoices.',
    A: 'Pays on time: normal credit (30 days) is fine.',
    B: 'Usually pays, sometimes late: keep credit short (15 days) and follow up at the due date.',
    C: 'Often late: ask for part payment in advance and keep exposure low.',
    D: 'High risk: ask for payment in advance before releasing documents.',
  }[grade];
  const limitMultiple = { new: 1, A: 4, B: 2, C: 1, D: 0 }[grade];
  const n0 = (v) => Math.round(v).toLocaleString('en-IN');
  const reasons = [];
  if (paid.length) reasons.push(`${Math.round(onTime * 100)}% of ${paid.length} paid invoice${paid.length > 1 ? 's' : ''} on time; average ${Math.round(avgLate)} days late.`);
  if (overdue.length) reasons.push(`${overdue.length} overdue now (${n0(overdueAmt)}), oldest ${Math.round(worstOverdue)} days.`);
  return { grade, score, on_time: onTime === null ? null : r2(onTime), avg_days_late: avgLate === null ? null : r2(avgLate), outstanding, overdue: overdueAmt, worst_overdue_days: Math.round(worstOverdue), suggested_limit: r2(avgInvoice * limitMultiple), advice, reasons };
}
