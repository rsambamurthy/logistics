// Planning agent services: instant estimate, mode advice, lane volume forecast, rate-card renewals and
// customer payment risk. The maths lives in engines/planning.js; this file only gathers the data.
import { q, one, currentTenant } from '../db.js';
import { laneOf } from '../engines/agentRank.js';
import { quoteTotals, shipmentMetrics, convert } from '../engines/costing.js';
import { priceFromCards, cardMatches, cardLines } from '../engines/ratecards.js';
import { estimateFromHistory, modeAdvice, forecastLane, rateCardHealth, paymentRisk, shipNowOrWait } from '../engines/planning.js';
import { loadActiveCards } from './rateCards.js';
import { getFx, getSetting } from './settings.js';
import { getMailbox, sendMail } from './mail.js';
import { audit } from './audit.js';

const DAY = 864e5;
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const err = (m, status = 400) => Object.assign(new Error(m), { status });
const today = () => new Date().toISOString().slice(0, 10);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

/** What a shipment is priced on for freight: containers (FCL), chargeable kg (air) or W/M (LCL). */
export function freightUnits(rfq) {
  const m = shipmentMetrics(rfq);
  return rfq.mode === 'FCL' ? m.containers || 1 : rfq.mode === 'AIR' ? m.chargeableKg : m.wm;
}
const unitName = (mode) => (mode === 'FCL' ? 'container' : mode === 'AIR' ? 'kg' : 'W/M');

// ---------------------------------------------------------------- quote history (cached)
const histCache = new Map();
/** Every agent quote of the last 18 months as { rfq_id, mode, lane, leg, total, units, transit_days } in the base currency. */
async function quoteHistory() {
  const t = currentTenant();
  const hit = histCache.get(t?.id);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.rows;
  const fx = await getFx();
  const quotes = await q(`SELECT qt.id, qt.rfq_id, qt.transit_days, coalesce(qt.source,'') AS source, qt.created_at, r.mode, r.pol, r.pod, r.gross_weight_kg, r.volume_cbm, r.containers, r.packages, r.package_type
    FROM agent_quotes qt JOIN rfqs r ON r.id=qt.rfq_id WHERE NOT qt.superseded AND NOT qt.declined AND qt.created_at > now() - interval '18 months' ORDER BY qt.id DESC LIMIT 4000`);
  const lines = quotes.length ? await q('SELECT * FROM quote_lines WHERE agent_quote_id = ANY($1)', [quotes.map((x) => x.id)]) : [];
  const byQuote = {};
  for (const l of lines) (byQuote[l.agent_quote_id] ??= []).push(l);
  const rows = [];
  for (const qt of quotes) {
    let tot;
    try { tot = quoteTotals({ lines: byQuote[qt.id] || [] }, qt, fx); } catch { continue; }
    const units = freightUnits(qt);
    for (const [leg, v] of Object.entries(tot.legs)) {
      if (!(v.total > 0)) continue;
      rows.push({ quote_id: qt.id, rfq_id: qt.rfq_id, source: qt.source, at: qt.created_at, mode: qt.mode, lane: laneOf(qt), leg, total: v.total, units: leg === 'freight' ? units : 1, transit_days: leg === 'freight' ? qt.transit_days : null });
    }
  }
  histCache.set(t?.id, { at: Date.now(), rows });
  return rows;
}

/** Cost range for an RFQ from past quotes on the same lane and mode (before any agent replies). */
async function estimateFor(rfq, hist, base) {
  const legs = rfq.legs || [];
  const lane = laneOf(rfq);
  const samples = hist.filter((h) => h.lane === lane && h.rfq_id !== rfq.id);
  const units = Object.fromEntries(legs.map((l) => [l, l === 'freight' ? freightUnits(rfq) : 1]));
  const est = estimateFromHistory(samples, units, legs);
  if (!est) return null;
  const transit = samples.filter((s) => s.leg === 'freight' && s.transit_days).map((s) => Number(s.transit_days));
  return { ...est, currency: base, transit_days: median(transit), unit: unitName(rfq.mode), freight_units: r2(freightUnits(rfq)) };
}

export async function instantEstimate(rfqId) {
  const rfq = await one('SELECT * FROM rfqs WHERE id=$1', [rfqId]);
  if (!rfq) throw err('Not found', 404);
  const fx = await getFx();
  return estimateFor(rfq, await quoteHistory(), fx.base);
}

// ---------------------------------------------------------------- mode advice
/** The same cargo as another mode: an FCL shipment without containers gets a container size from its volume. */
function asMode(rfq, mode) {
  const v = { ...rfq, mode };
  if (mode === 'FCL' && !(Array.isArray(rfq.containers) && rfq.containers.length)) {
    const cbm = Number(rfq.volume_cbm || 0);
    if (!cbm) return null;
    v.containers = cbm <= 28 ? [{ type: '20GP', qty: 1 }] : [{ type: '40HC', qty: Math.ceil(cbm / 58) }];
  }
  if (mode !== 'FCL' && !Number(rfq.volume_cbm) && !Number(rfq.gross_weight_kg)) return null;
  return v;
}

export async function modeInsight(rfqId) {
  const rfq = await one('SELECT * FROM rfqs WHERE id=$1', [rfqId]);
  if (!rfq) throw err('Not found', 404);
  const fx = await getFx();
  const cards = await loadActiveCards();
  const hist = await quoteHistory();
  const onDate = rfq.ready_date && new Date(rfq.ready_date) > new Date() ? new Date(rfq.ready_date) : new Date();
  const priced = [];
  for (const mode of ['AIR', 'LCL', 'FCL']) {
    const v = asMode(rfq, mode);
    if (!v) continue;
    const legs = {};
    let transit = null;
    let source = null;
    for (const g of priceFromCards(v, cards, fx, onDate)) {
      for (const [leg, x] of Object.entries(g.legs)) {
        if (!legs[leg] || x.total < legs[leg]) legs[leg] = x.total;
        if (leg === 'freight' && x.card.transit_days) transit = x.card.transit_days;
      }
    }
    if (legs.freight) source = 'rate cards';
    const est = await estimateFor(v, hist, fx.base);
    if (est) for (const [leg, x] of Object.entries(est.legs)) if (legs[leg] === undefined) { legs[leg] = x.mid; source = source ? 'rate cards and past quotes' : 'past quotes'; }
    transit ??= est?.transit_days ?? null;
    priced.push({ mode, legs, transit_days: transit, source, containers: mode === 'FCL' ? v.containers : null });
  }
  // compare like with like: only the legs every priced mode has a price for
  const withFreight = priced.filter((p) => p.legs.freight !== undefined);
  const common = withFreight.length ? Object.keys(withFreight[0].legs).filter((l) => withFreight.every((p) => p.legs[l] !== undefined)) : [];
  const options = priced.map((p) => ({ mode: p.mode, cost: p.legs.freight === undefined ? null : r2(common.reduce((s, l) => s + p.legs[l], 0)), transit_days: p.transit_days, source: p.source, containers: p.containers }));
  const advice = modeAdvice(options, { ready: rfq.ready_date ? String(rfq.ready_date).slice(0, 10) : null, deliverBy: rfq.deliver_by ? new Date(rfq.deliver_by).toISOString().slice(0, 10) : null, kg: Number(rfq.gross_weight_kg) || null, cbm: Number(rfq.volume_cbm) || null });
  return { ...advice, current: rfq.mode, currency: fx.base, compared_legs: common, deliver_by: rfq.deliver_by };
}

/** Both RFQ planning views in one call. */
export async function rfqPlanning(rfqId) {
  const [estimate, modes] = await Promise.all([instantEstimate(rfqId), modeInsight(rfqId)]);
  return { estimate, modes };
}

// ---------------------------------------------------------------- ship now or wait (consolidation)
/**
 * For lone shipments the consolidation agent could not pair: how often a partner turns up on the lane,
 * what it is worth, and whether to hold. houses: [{ id, mode, origin, destination, standalone_cost, sell_amount, ready_date }].
 */
export async function shipOrWait(houses) {
  if (!houses.length) return {};
  const cfg = await getSetting('consol');
  const gainPct = Number(cfg.partner_gain_pct ?? 20) / 100; // saving on the freight when shipped together
  const holdPct = Number(cfg.hold_cost_pct ?? 0.5) / 100; // cost of holding per day, share of the sale
  const counts = await q(`SELECT r.mode, r.pol, r.pod, count(*)::int AS n FROM jobs j JOIN rfqs r ON r.id=j.rfq_id
    WHERE j.created_at > now() - interval '90 days' AND r.mode IN ('AIR','LCL') AND j.status <> 'cancelled' GROUP BY 1,2,3`);
  const perLane = {};
  for (const c of counts) perLane[laneOf(c)] = (perLane[laneOf(c)] || 0) + c.n;
  const deliver = await q('SELECT j.id, r.deliver_by FROM jobs j JOIN rfqs r ON r.id=j.rfq_id WHERE j.id = ANY($1)', [houses.map((h) => h.id)]);
  const deliverBy = Object.fromEntries(deliver.map((d) => [d.id, d.deliver_by]));
  const out = {};
  for (const h of houses) {
    const lane = laneOf({ mode: h.mode, pol: h.origin, pod: h.destination });
    const ratePerDay = Math.max(0, ((perLane[lane] || 1) - 1) / 90); // other shipments per day on this lane
    const transit = h.mode === 'AIR' ? 3 : 25;
    const start = h.ready_date ? Math.max(Date.now(), new Date(h.ready_date).getTime()) : Date.now();
    const slackDays = deliverBy[h.id] ? (new Date(deliverBy[h.id]).getTime() - start) / DAY - transit : 3;
    out[h.id] = { ...shipNowOrWait({ ratePerDay, gainPerPartner: Number(h.standalone_cost || 0) * gainPct, costPerDay: Number(h.sell_amount || 0) * holdPct, slackDays }), per_week: r2(ratePerDay * 7) };
  }
  return out;
}

// ---------------------------------------------------------------- lane volume forecast (space planning)
const WEEKS = 16;
export async function laneForecasts() {
  const rows = await q(`SELECT r.mode, r.pol, r.pod, floor(extract(epoch FROM (date_trunc('week', now()) - date_trunc('week', coalesce(j.cargo_ready_date, j.created_at::date)))) / 604800)::int AS ago,
      sum(CASE WHEN r.mode='AIR' THEN greatest(coalesce(r.gross_weight_kg,0), coalesce(r.volume_cbm,0)*167) ELSE coalesce(r.volume_cbm,0) END)::float AS vol,
      sum(coalesce((SELECT sum((c->>'qty')::int) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.containers)='array' THEN r.containers ELSE '[]'::jsonb END) c), 0))::int AS boxes,
      count(*)::int AS n
    FROM jobs j JOIN rfqs r ON r.id=j.rfq_id
    WHERE j.status <> 'cancelled' AND coalesce(j.cargo_ready_date, j.created_at::date) >= date_trunc('week', now()) - interval '${WEEKS} weeks'
      AND coalesce(j.cargo_ready_date, j.created_at::date) < date_trunc('week', now())
    GROUP BY 1,2,3,4`);
  const lanes = {};
  for (const r of rows) {
    if (r.ago < 1 || r.ago > WEEKS) continue;
    const key = laneOf(r);
    const l = (lanes[key] ??= { mode: r.mode, pol: r.pol, pod: r.pod, weekly: Array(WEEKS).fill(0), jobs: 0 });
    l.weekly[WEEKS - r.ago] += r.mode === 'FCL' ? r.boxes : r.vol;
    l.jobs += r.n;
  }
  return Object.values(lanes).filter((l) => l.jobs >= 4).map((l) => {
    const f = forecastLane(l.weekly);
    return f && { mode: l.mode, pol: l.pol, pod: l.pod, unit: l.mode === 'AIR' ? 'kg' : l.mode === 'FCL' ? 'containers' : 'cbm', jobs: l.jobs, history: l.weekly.map(r2), ...f };
  }).filter(Boolean).sort((a, b) => b.jobs - a.jobs);
}

// ---------------------------------------------------------------- rate-card renewals
/** Each active card's health: expiry, age and how recent agent quotes on its lane compare. */
export async function rateCardRenewals() {
  const cards = await loadActiveCards();
  if (!cards.length) return [];
  const fx = await getFx();
  const recent = (await quoteHistory()).filter((h) => !['ratecard', 'own'].includes(h.source) && new Date(h.at) > new Date(Date.now() - 90 * DAY));
  const rfqIds = [...new Set(recent.map((h) => h.rfq_id))];
  const rfqs = rfqIds.length ? await q('SELECT * FROM rfqs WHERE id = ANY($1)', [rfqIds]) : [];
  const out = [];
  for (const card of cards) {
    const market = [];
    for (const rfq of rfqs) {
      if (!cardMatches(card, rfq, new Date(rfq.created_at || Date.now()))) continue;
      const lines = cardLines(card, rfq);
      if (!lines.length) continue;
      let cardTotal;
      try { cardTotal = quoteTotals({ lines }, rfq, fx).total; } catch { continue; }
      if (!(cardTotal > 0)) continue;
      for (const h of recent) if (h.rfq_id === rfq.id && h.leg === card.leg) market.push(h.total / cardTotal);
    }
    const health = rateCardHealth(card, market, today());
    if (!health.ok) out.push({ id: card.id, name: card.name, leg: card.leg, mode: card.mode, vendor_id: card.vendor_id, valid_to: card.valid_to, market_quotes: market.length, ...health });
  }
  const vendors = out.some((c) => c.vendor_id) ? await q('SELECT id, company, email FROM agents WHERE id = ANY($1)', [out.map((c) => c.vendor_id).filter(Boolean)]) : [];
  for (const c of out) { const v = vendors.find((x) => x.id === c.vendor_id); c.vendor = v?.company || null; c.can_ask = !!v?.email; }
  const rank = (c) => (c.issues.some((i) => i.severity === 'high') ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** Email the card's vendor for a fresh rate sheet (their reply is read by the rate-sheet reader). */
export async function askForNewRates(cardId, user) {
  const card = await one('SELECT * FROM rate_cards WHERE id=$1', [cardId]);
  if (!card) throw err('Not found', 404);
  const vendor = card.vendor_id ? await one('SELECT * FROM agents WHERE id=$1', [card.vendor_id]) : null;
  if (!vendor?.email) throw err('This card has no vendor with an email address. Your own cards are renewed by editing them.');
  const mb = await getMailbox();
  if (!mb) throw err('No mailbox configured. Add one in Settings → Mailboxes.');
  const until = card.valid_to ? ` Our current rates "${card.name}" are valid until ${new Date(card.valid_to).toISOString().slice(0, 10)}.` : ` Our current rates "${card.name}" need updating.`;
  const text = `Dear ${vendor.contact || vendor.company},\n\nCould you please send us your updated rates for ${[card.origin, card.destination].filter(Boolean).join(' to ') || card.name} (${card.mode || ''} ${card.leg?.replace(/_/g, ' ') || ''}).${until}\n\nA rate sheet in Excel or PDF is fine.\n\nThank you.\n${mb.signature || mb.from_name || ''}`;
  await sendMail(mb, { to: vendor.email, cc: vendor.cc || undefined, subject: `Request for updated rates: ${card.name}`, text }, { kind: 'rate_request' });
  await audit(user, 'ratecard.renewal_requested', { entity: 'rate_card', entityId: card.id, summary: `Asked ${vendor.company} for new rates (${card.name})` });
  return { ok: true, to: vendor.email };
}

// ---------------------------------------------------------------- customer payment risk
async function customerInvoices(customerId) {
  const fx = await getFx();
  const rows = await q(`SELECT j.id, j.ref, j.requester_id, j.invoice_no, j.invoice_date, j.invoice_amount, coalesce(j.invoice_currency, j.sell_currency) AS currency, j.due_date, j.paid_at
    FROM jobs j WHERE j.invoice_amount IS NOT NULL AND j.status <> 'cancelled' ${customerId ? 'AND j.requester_id=$1' : ''}`, customerId ? [customerId] : []);
  return rows.map((r) => { let amount = Number(r.invoice_amount); try { amount = convert(amount, r.currency || fx.base, fx.base, fx); } catch { /* keep as is */ } return { ...r, amount: r2(amount) }; });
}

/** Payment record per customer: { [customerId]: paymentRisk + currency }. */
export async function paymentRisks() {
  const fx = await getFx();
  const by = {};
  for (const i of await customerInvoices()) if (i.requester_id) (by[i.requester_id] ??= []).push(i);
  return Object.fromEntries(Object.entries(by).map(([id, inv]) => [id, { ...paymentRisk(inv, today()), currency: fx.base, invoices: inv.length }]));
}

export async function customerPaymentRisk(customerId) {
  const fx = await getFx();
  const inv = await customerInvoices(customerId);
  const agent = await one('SELECT credit_days FROM agents WHERE id=$1', [customerId]);
  return { ...paymentRisk(inv, today()), currency: fx.base, invoices: inv.length, credit_days: agent?.credit_days ?? null };
}

/** Unpaid customer invoices, overdue first. */
export async function receivables() {
  const fx = await getFx();
  const rows = await q(`SELECT j.id, j.ref, j.invoice_no, j.invoice_date, j.invoice_amount, coalesce(j.invoice_currency, j.sell_currency) AS currency, j.due_date, a.id AS customer_id, a.company AS customer
    FROM jobs j LEFT JOIN agents a ON a.id=j.requester_id WHERE j.invoice_amount IS NOT NULL AND j.paid_at IS NULL AND j.status <> 'cancelled' ORDER BY j.due_date NULLS LAST, j.id`);
  const t = Date.parse(`${today()}T00:00Z`);
  return { currency: fx.base, rows: rows.map((r) => ({ ...r, days_overdue: r.due_date && new Date(r.due_date).getTime() < t ? Math.round((t - new Date(r.due_date).getTime()) / DAY) : 0 })) };
}

/** When an invoice is raised without a due date, use the customer's credit days (or 30). */
export async function defaultDueDate(jobId, invoiceDate) {
  const r = await one('SELECT a.credit_days FROM jobs j LEFT JOIN agents a ON a.id=j.requester_id WHERE j.id=$1', [jobId]);
  const d = new Date(invoiceDate);
  d.setUTCDate(d.getUTCDate() + Number(r?.credit_days ?? 30));
  return d.toISOString().slice(0, 10);
}
