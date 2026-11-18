// Single cost-calculation engine: quantities, FX, comparison and customer quote.
// Pure functions only — no DB access — so they are shared and testable.
import { LEG_CODES, legName, chargeByCode } from './charges.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function shipmentMetrics(rfq) {
  const containers = Array.isArray(rfq.containers) ? rfq.containers : [];
  const count = (pred) => containers.filter(pred).reduce((s, c) => s + Number(c.qty || 0), 0);
  const total = count(() => true);
  const c20 = count((c) => String(c.type).startsWith('20'));
  const c40 = count((c) => /^4[05]/.test(String(c.type)));
  const cbm = Number(rfq.volume_cbm || 0);
  const kg = Number(rfq.gross_weight_kg || 0);
  const volKg = cbm * 167; // air volumetric weight (1 cbm = 167 kg)
  const chargeableKg = rfq.mode === 'AIR' ? Math.max(kg, volKg) : kg;
  const wm = Math.max(cbm, kg / 1000);
  return { containers: total, c20, c40, cbm, kg, chargeableKg: round2(chargeableKg), wm: round2(wm) };
}

export function qtyFor(basis, rfq) {
  const m = shipmentMetrics(rfq);
  switch (basis) {
    case 'per_container': return m.containers || 1;
    case 'per_20': return m.c20;
    case 'per_40': return m.c40;
    case 'per_cbm': return m.cbm;
    case 'per_kg': return m.chargeableKg;
    case 'per_wm': return Math.max(m.wm, 1);
    case 'per_trip': return rfq.mode === 'FCL' ? Math.max(m.containers, 1) : 1;
    default: return 1; // per_shipment, per_bl, per_declaration
  }
}

/** fx = { base: 'INR', rates: { USD: 84.5, ... } } — units of base per 1 unit of currency */
export function convert(amount, from, to, fx) {
  if (from === to) return Number(amount);
  const r = fx.rates || {};
  const fromRate = from === fx.base ? 1 : r[from];
  const toRate = to === fx.base ? 1 : r[to];
  if (!fromRate || !toRate) throw new Error(`No FX rate for ${!fromRate ? from : to}`);
  return (Number(amount) * fromRate) / toRate;
}

export function lineAmount(line, rfq) {
  const qty = line.qty !== null && line.qty !== undefined && line.qty !== '' ? Number(line.qty) : qtyFor(line.basis, rfq);
  return { qty, amount: round2(Number(line.rate) * qty) };
}

/** Totals for one agent quote, per leg, in the target currency. */
export function quoteTotals(quote, rfq, fx, currency = fx.base) {
  const legs = {};
  let total = 0;
  const errors = [];
  for (const line of quote.lines || []) {
    const { qty, amount } = lineAmount(line, rfq);
    let conv = 0;
    try { conv = convert(amount, line.currency, currency, fx); } catch (e) { errors.push(e.message); }
    legs[line.leg] ??= { total: 0, lines: [] };
    legs[line.leg].total += conv;
    legs[line.leg].lines.push({ ...line, qty, amount, converted: round2(conv) });
    total += conv;
  }
  for (const k of Object.keys(legs)) legs[k].total = round2(legs[k].total);
  return { legs, total: round2(total), errors };
}

function quoteFlags(quote, invite, today = new Date()) {
  const flags = [];
  const quoted = new Set((quote.lines || []).map((l) => l.leg));
  for (const leg of invite.legs || []) if (!quoted.has(leg)) flags.push({ type: 'missing_leg', leg, text: `No price for ${legName(leg)}` });
  if (quote.valid_until && new Date(quote.valid_until) < new Date(today.toDateString())) flags.push({ type: 'expired', text: 'Quote validity has passed' });
  if (quote.exclusions) flags.push({ type: 'exclusions', text: `Excludes: ${quote.exclusions}` });
  if ((quote.lines || []).some((l) => Number(l.confidence ?? 1) < 0.7) && !quote.verified) flags.push({ type: 'low_confidence', text: 'Some lines need review' });
  if ((quote.lines || []).some((l) => l.charge_code === 'OTHER')) flags.push({ type: 'unmapped', text: 'Unmapped charge(s)' });
  return flags;
}

/**
 * Comparison matrix for an RFQ.
 * quotes: [{ id, invite_id, agent: {company}, lines: [...], valid_until, transit_days, free_days, exclusions, verified, declined }]
 * invites: [{ id, legs, status, agent_company }]
 */
export function compare(rfq, invites, quotes, fx, currency = fx.base) {
  const legs = LEG_CODES.filter((l) => (rfq.legs || []).includes(l));
  const columns = invites.map((inv) => {
    const quote = quotes.find((qq) => qq.invite_id === inv.id && !qq.superseded);
    if (!quote) return { invite: inv, quote: null, status: inv.status, legs: {}, total: null, flags: [] };
    if (quote.declined) return { invite: inv, quote, status: 'declined', legs: {}, total: null, flags: [{ type: 'declined', text: 'Agent declined' }] };
    const t = quoteTotals(quote, rfq, fx, currency);
    return { invite: inv, quote, status: 'quoted', legs: t.legs, total: t.total, flags: [...quoteFlags(quote, inv), ...t.errors.map((e) => ({ type: 'fx', text: e }))] };
  });
  const bestPerLeg = {};
  for (const leg of legs) {
    let best = null;
    for (const col of columns) {
      const v = col.legs[leg]?.total;
      if (v === undefined || col.status !== 'quoted') continue;
      if (col.flags.some((f) => f.type === 'expired')) continue;
      if (!best || v < best.total) best = { quoteId: col.quote.id, inviteId: col.invite.id, total: v };
    }
    if (best) bestPerLeg[leg] = best;
  }
  const bestMixTotal = round2(Object.values(bestPerLeg).reduce((s, b) => s + b.total, 0));
  // best single agent covering all legs
  let bestSingle = null;
  for (const col of columns) {
    if (col.status !== 'quoted') continue;
    if (!legs.every((l) => col.legs[l])) continue;
    if (!bestSingle || col.total < bestSingle.total) bestSingle = { quoteId: col.quote.id, inviteId: col.invite.id, total: col.total };
  }
  return { currency, legs, columns, bestPerLeg, bestMixTotal, bestSingle, coveredLegs: Object.keys(bestPerLeg) };
}

/**
 * Build the customer (sell) quote.
 * selection: { [leg]: agentQuoteId }
 * opts: { currency, marginPct, taxPct, legMargins?: { [leg]: pct } }
 */
export function buildCustomerQuote(rfq, selection, quotesById, opts, fx) {
  const { currency, marginPct = 0, taxPct = 0, legMargins = {} } = opts;
  const sections = [];
  let buy = 0;
  let sell = 0;
  for (const leg of LEG_CODES) {
    const qid = selection[leg];
    if (!qid) continue;
    const quote = quotesById[qid];
    if (!quote) throw new Error(`Selected quote ${qid} not found`);
    const pct = Number(legMargins[leg] ?? marginPct);
    const lines = [];
    for (const l of quote.lines.filter((x) => x.leg === leg)) {
      const { qty, amount } = lineAmount(l, rfq);
      const buyConv = convert(amount, l.currency, currency, fx);
      const sellRate = convert(Number(l.rate), l.currency, currency, fx) * (1 + pct / 100);
      const sellAmt = round2(sellRate * qty);
      buy += buyConv;
      sell += sellAmt;
      lines.push({
        charge_code: l.charge_code,
        description: l.description || chargeByCode(l.charge_code)?.name || l.charge_code,
        basis: l.basis,
        qty,
        buy_currency: l.currency,
        buy_rate: Number(l.rate),
        buy_amount: amount,
        buy_converted: round2(buyConv),
        sell_rate: round2(sellRate),
        sell_amount: sellAmt,
      });
    }
    sections.push({ leg, name: legName(leg), agent_quote_id: qid, invite_id: quote.invite_id, agent: quote.agent?.company, margin_pct: pct, lines, subtotal: round2(lines.reduce((s, x) => s + x.sell_amount, 0)) });
  }
  const tax = round2((sell * Number(taxPct)) / 100);
  return {
    currency,
    sections,
    totals: { buy: round2(buy), sell: round2(sell), profit: round2(sell - buy), margin_pct_effective: buy ? round2(((sell - buy) / buy) * 100) : 0, tax, tax_pct: Number(taxPct), grand_total: round2(sell + tax) },
    fx_snapshot: { base: fx.base, rates: fx.rates, at: new Date().toISOString() },
  };
}
