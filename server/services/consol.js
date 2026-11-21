// Consolidation desk: consols (masters) hold several jobs (houses). The consolidation agent plans
// which open air / LCL jobs to put together (engines/consol.js), prices the master from rate cards,
// and, when an AI key is set, reviews the plan for cargo that should not travel together.
import { q, one, tx } from '../db.js';
import { houseWeights, consolEconomics, planConsols, consolWarnings, KG_PER_CBM, CONTAINERS } from '../engines/consol.js';
import { convert } from '../engines/costing.js';
import { priceFromCards } from '../engines/ratecards.js';
import { loadActiveCards } from './rateCards.js';
import { setMilestone } from './jobs.js';
import { ensureTracking } from './tracking.js';
import { getFx, getSetting, getAiKey } from './settings.js';
import { reviewConsolPlan } from './ai.js';
import { audit } from './audit.js';
import { shipOrWait } from './insights.js';
import { createPdf, letterhead, kvRows, table, finish } from '../lib/pdf.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const blank = (v) => (v === '' || v === undefined ? null : v);
const FIELDS = ['mode', 'origin', 'destination', 'carrier', 'flight_no', 'vessel', 'voyage', 'etd', 'eta', 'cutoff', 'mawb', 'container_type', 'agent_id', 'buy_currency', 'buy_rate', 'buy_min', 'buy_fixed', 'capacity_kg', 'notes'];
const OPEN_JOB = "j.status NOT IN ('completed','cancelled','departed','arrived')";
export const CONSOL_STATUSES = ['planning', 'closed', 'departed', 'arrived', 'cancelled'];

const HOUSE_SQL = `SELECT j.id, j.ref, j.status, j.consol_id, j.hawb, j.pieces, j.sell_currency, a.company AS customer,
    r.ref AS rfq_ref, r.mode, r.pol AS origin, r.pod AS destination, r.gross_weight_kg AS gross_kg, r.volume_cbm AS cbm,
    r.packages, r.package_type, r.commodity, r.dangerous_goods, r.dg_class, r.reefer_temp, r.stackable,
    coalesce(j.cargo_ready_date, r.ready_date) AS ready_date
  FROM jobs j JOIN rfqs r ON r.id=j.rfq_id LEFT JOIN agents a ON a.id=j.requester_id`;

/** Freight sell and buy of each job (from its cost sheet), in `currency`. */
async function freightMoney(jobIds, currency, fx) {
  if (!jobIds.length) return {};
  const rows = await q("SELECT job_id, kind, amount, currency, source FROM job_costs WHERE job_id = ANY($1) AND leg='freight' AND kind IN ('sell','buy','buy_replaced')", [jobIds]);
  const out = {};
  for (const r of rows) {
    const m = (out[r.job_id] ??= { sell_amount: 0, standalone_cost: 0 });
    let v;
    try { v = convert(Number(r.amount), r.currency, currency, fx); } catch { continue; }
    if (r.kind === 'sell') m.sell_amount += v;
    else if (r.source !== 'consol') m.standalone_cost += v; // what the agent quoted for this shipment alone
  }
  return out;
}

async function housesWithMoney(rows, currency) {
  const fx = await getFx();
  const money = await freightMoney(rows.map((r) => r.id), currency || fx.base, fx);
  return rows.map((r) => ({ ...r, ...(money[r.id] || { sell_amount: 0, standalone_cost: 0 }), weights: houseWeights(r) }));
}

/** Best freight rate for a master of this size from the rate cards (weight breaks apply to the total). */
export async function masterRateFromCards({ mode, origin, destination, gross, volKg, cbm }, currency) {
  const fx = await getFx();
  const rfq = { mode, pol: origin, pod: destination, gross_weight_kg: gross, volume_cbm: mode === 'AIR' ? volKg / KG_PER_CBM : cbm, legs: ['freight'], containers: [] };
  const cards = (await loadActiveCards()).filter((c) => c.leg === 'freight');
  let best = null;
  for (const g of priceFromCards(rfq, cards, fx)) {
    const leg = g.legs.freight;
    if (leg && (!best || leg.total < best.total)) best = { total: leg.total, card: leg.card };
  }
  if (!best) return null;
  // in the card's own currency unless asked otherwise
  const lineCur = [...new Set((best.card.lines || []).map((l) => l.currency))];
  const cur = currency || (lineCur.length === 1 ? lineCur[0] : fx.base);
  const total = convert(best.total, fx.base, cur, fx);
  const ch = mode === 'AIR' ? Math.max(gross, volKg) : cbm;
  const vendor = best.card.vendor_id ? (await one('SELECT company FROM agents WHERE id=$1', [best.card.vendor_id]))?.company : 'Our own rates';
  return { currency: cur, total: Math.round(total * 100) / 100, rate: ch ? Math.round((total / ch) * 100) / 100 : null, card_id: best.card.id, card_name: best.card.name, vendor };
}

// ---------------- the consolidation agent ----------------

/** Plan consols from all open air / LCL jobs not yet in a consol. Fast and deterministic. */
export async function agentPlan({ windowDays, capacityKg, container } = {}) {
  const cfg = await getSetting('consol');
  const rows = await q(`${HOUSE_SQL} WHERE j.consol_id IS NULL AND ${OPEN_JOB} AND r.mode IN ('AIR','LCL') ORDER BY j.id`);
  const fx = await getFx();
  const houses = await housesWithMoney(rows, fx.base);
  const opts = { windowDays: Number(windowDays ?? cfg.window_days ?? 3), capacityKg: Number(capacityKg ?? cfg.capacity_kg ?? 0) || 0, container: container || cfg.container || '40HC' };
  const { plans, unplanned } = planConsols(houses, opts);
  const byId = Object.fromEntries(houses.map((h) => [h.id, h]));
  for (const p of plans) {
    const hs = p.houses.map((id) => byId[id]);
    const quote = await masterRateFromCards({ mode: p.mode, origin: p.origin, destination: p.destination, gross: p.weights.gross, volKg: p.weights.volKg, cbm: p.weights.cbm }).catch(() => null);
    // economics in the base currency; the consol keeps the card's currency
    // shown in the rate card's currency when there is one (the consol keeps it), otherwise the base currency
    const cur = quote?.currency || fx.base;
    const money = cur === fx.base ? null : await freightMoney(p.houses, cur, fx);
    const priced = money ? hs.map((h) => ({ ...h, ...(money[h.id] || { sell_amount: 0, standalone_cost: 0 }) })) : hs;
    const buy = quote ? (p.mode === 'LCL' ? { fixed: quote.total } : { rate: quote.rate }) : {};
    p.buy = quote;
    p.currency = cur;
    p.economics = consolEconomics(priced, buy, p.mode);
    p.house_rows = hs.map((h) => ({ id: h.id, ref: h.ref, customer: h.customer, commodity: h.commodity, ready_date: h.ready_date, dangerous_goods: h.dangerous_goods, reefer_temp: h.reefer_temp, ...h.weights }));
  }
  // lone shipments: hold for a partner or ship now
  const lone = unplanned.filter((u) => byId[u.id] && /No other/.test(u.reason)).map((u) => byId[u.id]);
  const advice = await shipOrWait(lone).catch(() => ({}));
  return { options: opts, currency: fx.base, plans, unplanned: unplanned.map((u) => ({ ...u, ref: byId[u.id]?.ref || null, mode: byId[u.id]?.mode, customer: byId[u.id]?.customer || null, lane: byId[u.id] ? `${byId[u.id].origin || '?'} → ${byId[u.id].destination || '?'}` : null, ship_or_wait: advice[u.id] || null })), candidates: houses.length, ai: !!(await getAiKey()) };
}

/** Ask the AI to review a plan: cargo that should not fly together, documents, handling advice. */
export async function agentReview(plan) {
  if (!(await getAiKey())) throw err('AI is not set up. The plan above is still valid; add an AI key in Settings → AI for a cargo review.', 409);
  const ids = plan.plans.flatMap((p) => p.houses);
  const rows = ids.length ? await q(`${HOUSE_SQL} WHERE j.id = ANY($1)`, [ids]) : [];
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const brief = plan.plans.map((p, i) => ({
    consol: i + 1, lane: `${p.origin} → ${p.destination}`, mode: p.mode, weights: p.weights,
    houses: p.houses.map((id) => { const h = byId[id] || {}; return { job: h.ref, commodity: h.commodity, packages: h.packages, package_type: h.package_type, gross_kg: h.gross_kg, cbm: h.cbm, dangerous_goods: h.dangerous_goods, dg_class: h.dg_class, reefer_temp: h.reefer_temp, stackable: h.stackable, ready_date: h.ready_date }; }),
  }));
  return reviewConsolPlan(brief);
}

/** Create a consol from a plan the user accepted. */
export async function acceptPlan({ houses, mode, origin, destination, buy }, user) {
  if (!houses?.length) throw err('No shipments in this plan');
  const c = await createConsol({ mode, origin, destination, buy_currency: buy?.currency, buy_rate: mode === 'AIR' ? buy?.rate : null, buy_fixed: mode === 'LCL' ? buy?.total : null, notes: buy?.card_name ? `Buy rate from rate card "${buy.card_name}" (${buy.vendor})` : null }, user);
  await addHouses(c.id, houses, user);
  await audit(user, 'consol.plan_accepted', { entity: 'consol', entityId: c.id, summary: `Consolidation agent plan accepted: ${houses.length} shipments in ${c.ref}` });
  return loadConsol(c.id);
}

// ---------------- consols ----------------

async function nextRef(t) {
  const year = new Date().getFullYear();
  const row = await t.one('SELECT count(*)::int AS n FROM consols WHERE ref LIKE $1', [`CON-${year}-%`]);
  return `CON-${year}-${String(row.n + 1).padStart(4, '0')}`;
}

export async function createConsol(body, user) {
  if (!['AIR', 'LCL'].includes(body.mode)) throw err('A consol is air or LCL');
  const fx = await getFx();
  const c = await tx(async (t) => t.one(
    `INSERT INTO consols(ref,mode,origin,destination,buy_currency,buy_rate,buy_fixed,container_type,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [await nextRef(t), body.mode, blank(body.origin), blank(body.destination), body.buy_currency || fx.base, blank(body.buy_rate), blank(body.buy_fixed), body.mode === 'LCL' ? body.container_type || '40HC' : null, blank(body.notes), user?.id || null]
  ));
  await audit(user, 'consol.create', { entity: 'consol', entityId: c.id, summary: `Created ${c.ref}` });
  return c;
}

export async function listConsols({ status } = {}) {
  const rows = await q(`SELECT c.*, (SELECT count(*)::int FROM jobs j WHERE j.consol_id=c.id) AS houses FROM consols c
    ${status === 'active' ? "WHERE c.status NOT IN ('arrived','cancelled')" : status ? 'WHERE c.status=$1' : ''} ORDER BY c.id DESC LIMIT 300`, status && status !== 'active' ? [status] : []);
  for (const c of rows) {
    const hs = await housesWithMoney(await q(`${HOUSE_SQL} WHERE j.consol_id=$1`, [c.id]), c.buy_currency);
    c.economics = hs.length ? consolEconomics(hs, { rate: c.buy_rate, min: c.buy_min, fixed: c.buy_fixed }, c.mode) : null;
  }
  return rows;
}

export async function loadConsol(id) {
  const c = await one('SELECT * FROM consols WHERE id=$1', [id]);
  if (!c) throw err('Consol not found', 404);
  const houses = await housesWithMoney(await q(`${HOUSE_SQL} WHERE j.consol_id=$1 ORDER BY j.hawb NULLS LAST, j.id`, [id]), c.buy_currency);
  const economics = consolEconomics(houses, { rate: c.buy_rate, min: c.buy_min, fixed: c.buy_fixed }, c.mode);
  const capacity = c.mode === 'LCL' ? CONTAINERS[c.container_type || '40HC'] : c.capacity_kg ? { kg: Number(c.capacity_kg) } : null;
  const cardRate = houses.length ? await masterRateFromCards({ mode: c.mode, origin: c.origin, destination: c.destination, gross: economics.gross, volKg: economics.volKg, cbm: economics.cbm }, c.buy_currency).catch(() => null) : null;
  // open jobs on the same lane that could still join
  const candidates = await q(`${HOUSE_SQL} WHERE j.consol_id IS NULL AND ${OPEN_JOB} AND r.mode=$1 ORDER BY j.id DESC LIMIT 100`, [c.mode]);
  return { consol: c, houses, economics, capacity, card_rate: cardRate, warnings: consolWarnings(houses), candidates: candidates.map((h) => ({ ...h, weights: houseWeights(h) })) };
}

export async function updateConsol(id, body, user) {
  const c = await one('SELECT * FROM consols WHERE id=$1', [id]);
  if (!c) throw err('Consol not found', 404);
  const keys = FIELDS.filter((k) => body[k] !== undefined && k !== 'mode');
  if (keys.length) await q(`UPDATE consols SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1`, [id, ...keys.map((k) => blank(body[k]))]);
  if (body.mawb !== undefined && blank(body.mawb) !== c.mawb) {
    await audit(user, 'consol.update', { entity: 'consol', entityId: id, summary: `${c.ref} MAWB/MBL set to ${body.mawb || '—'}` });
    // every house is tracked on the master number
    for (const h of await q('SELECT id FROM jobs WHERE consol_id=$1', [id])) await ensureTracking(h.id).catch((e) => console.error('consol tracking', h.id, e.message));
  }
  return loadConsol(id);
}

export async function deleteConsol(id, user) {
  const c = await one('SELECT * FROM consols WHERE id=$1', [id]);
  if (!c) throw err('Consol not found', 404);
  if (!['planning', 'cancelled'].includes(c.status)) throw err('Only a consol still being planned can be deleted');
  for (const h of await q('SELECT id FROM jobs WHERE consol_id=$1', [id])) await removeHouse(id, h.id, user);
  await q('DELETE FROM consols WHERE id=$1', [id]);
  await audit(user, 'consol.delete', { entity: 'consol', entityId: id, summary: `Deleted ${c.ref}` });
  return { ok: true };
}

export async function addHouses(id, jobIds, user) {
  const c = await one('SELECT * FROM consols WHERE id=$1', [id]);
  if (!c) throw err('Consol not found', 404);
  if (c.status !== 'planning') throw err('This consol is closed. Reopen it to add shipments.');
  const rows = await q(`${HOUSE_SQL} WHERE j.id = ANY($1)`, [jobIds.map(Number)]);
  if (rows.length !== jobIds.length) throw err('Job not found', 404);
  for (const r of rows) {
    if (r.consol_id && r.consol_id !== id) throw err(`${r.ref} is already in another consol`);
    if (r.mode !== c.mode) throw err(`${r.ref} is ${r.mode}; this consol is ${c.mode}`);
  }
  const existing = await one('SELECT count(*)::int AS n FROM jobs WHERE consol_id=$1', [id]);
  let n = existing.n;
  for (const r of rows) {
    if (r.consol_id === id) continue;
    n += 1;
    await q('UPDATE jobs SET consol_id=$1, hawb=coalesce(hawb,$2) WHERE id=$3', [id, `${c.ref.replace('CON-', 'H')}-${String(n).padStart(2, '0')}`, r.id]);
  }
  // first houses set the lane when it was left blank
  if (!c.origin || !c.destination) await q('UPDATE consols SET origin=coalesce(origin,$1), destination=coalesce(destination,$2) WHERE id=$3', [rows[0].origin, rows[0].destination, id]);
  await audit(user, 'consol.houses', { entity: 'consol', entityId: id, summary: `Added ${rows.map((r) => r.ref).join(', ')} to ${c.ref}` });
  return loadConsol(id);
}

export async function removeHouse(id, jobId, user) {
  const job = await one('SELECT id, ref FROM jobs WHERE id=$1 AND consol_id=$2', [jobId, id]);
  if (!job) throw err('That job is not in this consol', 404);
  await tx(async (t) => {
    await t.q("DELETE FROM job_costs WHERE job_id=$1 AND source='consol'", [jobId]);
    await t.q("UPDATE job_costs SET kind='buy' WHERE job_id=$1 AND kind='buy_replaced'", [jobId]);
    await t.q('UPDATE jobs SET consol_id=NULL, hawb=NULL WHERE id=$1', [jobId]);
  });
  await audit(user, 'consol.houses', { entity: 'consol', entityId: id, summary: `Removed ${job.ref} from the consol` });
  return loadConsol(id);
}

export async function updateHouse(id, jobId, { hawb, pieces }) {
  const job = await one('SELECT id FROM jobs WHERE id=$1 AND consol_id=$2', [jobId, id]);
  if (!job) throw err('That job is not in this consol', 404);
  if (hawb !== undefined) await q('UPDATE jobs SET hawb=$1 WHERE id=$2', [blank(hawb), jobId]);
  if (pieces !== undefined) await setPieces(jobId, pieces);
  return loadConsol(id);
}

/** Dimensions of a job's pieces: [{ count, l, w, h, unit, kg }]. */
export async function setPieces(jobId, pieces) {
  const clean = (Array.isArray(pieces) ? pieces : []).map((p) => ({
    count: Math.max(1, Math.round(Number(p.count || 1))), l: Number(p.l || 0), w: Number(p.w || 0), h: Number(p.h || 0), unit: p.unit === 'in' ? 'in' : 'cm', kg: p.kg === '' || p.kg === null || p.kg === undefined ? null : Number(p.kg),
  })).filter((p) => p.l > 0 && p.w > 0 && p.h > 0);
  await q('UPDATE jobs SET pieces=$1 WHERE id=$2', [clean.length ? JSON.stringify(clean) : null, jobId]);
  return clean;
}

/**
 * Put the consol's buy cost on the houses' cost sheets, shared by chargeable weight (air) or
 * W/M (sea). The agents' stand-alone freight costs are set aside (and come back if a house leaves).
 */
export async function applyCosts(id, user) {
  const { consol: c, houses, economics: e } = await loadConsol(id);
  if (e.cost === null) throw err('Enter the buy rate (or container cost) first');
  const total = houses.reduce((s, h) => s + h.weights.chargeable, 0);
  await tx(async (t) => {
    for (const h of houses) {
      const share = total ? (e.cost * h.weights.chargeable) / total : e.cost / houses.length;
      await t.q("DELETE FROM job_costs WHERE job_id=$1 AND source='consol'", [h.id]);
      await t.q("UPDATE job_costs SET kind='buy_replaced' WHERE job_id=$1 AND kind='buy' AND leg='freight'", [h.id]);
      await t.q("INSERT INTO job_costs(job_id,kind,leg,description,amount,currency,agent_id,source) VALUES($1,'buy','freight',$2,$3,$4,$5,'consol')",
        [h.id, `Consol ${c.ref} share: ${h.weights.chargeable} of ${Math.round(total * 100) / 100} ${h.weights.unit}`, Math.round(share * 100) / 100, c.buy_currency, c.agent_id]);
    }
  });
  await audit(user, 'consol.costs', { entity: 'consol', entityId: id, summary: `${c.ref}: cost ${e.cost} ${c.buy_currency} shared across ${houses.length} jobs` });
  return loadConsol(id);
}

/** Move the consol on (closed / departed / arrived / cancelled); departures and arrivals update every house. */
export async function setConsolStatus(id, { status, date, notify }, user) {
  if (!CONSOL_STATUSES.includes(status)) throw err('Unknown status');
  const c = await one('SELECT * FROM consols WHERE id=$1', [id]);
  if (!c) throw err('Consol not found', 404);
  if (status === 'closed' && !(await one('SELECT 1 FROM jobs WHERE consol_id=$1 LIMIT 1', [id]))) throw err('Add shipments before closing');
  await q('UPDATE consols SET status=$1, closed_at=CASE WHEN $1 IN (\'arrived\',\'cancelled\') THEN now() ELSE NULL END WHERE id=$2', [status, id]);
  if (status === 'departed' || status === 'arrived') {
    for (const h of await q('SELECT id FROM jobs WHERE consol_id=$1', [id])) await setMilestone(h.id, { status, date, notify }).catch((e) => console.error('consol milestone', h.id, e.message));
  }
  await audit(user, 'consol.status', { entity: 'consol', entityId: id, summary: `${c.ref} ${status}` });
  return loadConsol(id);
}

/** Cargo manifest PDF: the master, then one line per house. */
export async function manifestPdf(id) {
  const { consol: c, houses, economics: e } = await loadConsol(id);
  const company = await getSetting('company');
  const pdf = createPdf({ title: `Manifest ${c.ref}` });
  const { doc } = pdf;
  letterhead(doc, company, pdf, 'Cargo manifest', c.ref);
  const air = c.mode === 'AIR';
  kvRows(doc, [
    [air ? 'MAWB' : 'MBL', c.mawb], ['Carrier', c.carrier], [air ? 'Flight' : 'Vessel / voyage', air ? c.flight_no : [c.vessel, c.voyage].filter(Boolean).join(' / ')],
    ['From', c.origin], ['To', c.destination], ['ETD / ETA', [c.etd && new Date(c.etd).toDateString(), c.eta && new Date(c.eta).toDateString()].filter(Boolean).join(' / ')],
    ['Totals', air ? `${houses.length} houses · ${e.gross} kg gross · ${e.volKg} kg volume · chargeable ${e.chargeable} kg` : `${houses.length} houses · ${e.gross} kg · ${e.cbm} cbm`],
  ], pdf);
  doc.moveDown(0.6);
  table(doc, [
    { label: air ? 'HAWB' : 'HBL', width: 70 }, { label: 'Job', width: 75 }, { label: 'Shipper / customer', width: 110 }, { label: 'Commodity', width: 90 },
    { label: 'Pcs', width: 35, align: 'right' }, { label: 'Gross kg', width: 50, align: 'right' }, { label: air ? 'Ch. kg' : 'cbm', width: 45, align: 'right' }, { label: 'DG', width: 40 },
  ], houses.map((h) => [h.hawb, h.ref, h.customer, h.commodity, h.packages || '', h.weights.gross, air ? h.weights.chargeable : h.weights.cbm, h.dangerous_goods ? `Yes${h.dg_class ? ` ${h.dg_class}` : ''}` : '']), pdf);
  return finish(pdf);
}
