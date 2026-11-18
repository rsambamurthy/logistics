// Rate card matching: turns stored buy rates into quote lines for an RFQ. Pure functions.
import { shipmentMetrics, quoteTotals } from './costing.js';

const tokens = (s) =>
  String(s || '')
    .toLowerCase()
    .split(/[,;/|()]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);

/** A card place like "Chennai, INMAA, Sriperumbudur" matches if any alias appears in the RFQ place. Blank card place = anywhere. */
export function placeMatches(cardPlace, rfqPlace) {
  const ct = tokens(cardPlace);
  if (!ct.length || ct.includes('any') || ct.includes('*')) return true;
  const r = String(rfqPlace || '').toLowerCase();
  if (!r) return false;
  const rt = tokens(rfqPlace);
  return ct.some((c) => r.includes(c) || rt.some((x) => c.includes(x) && x.length > 3));
}

/** Which RFQ places a leg runs between. Single-location legs use the card's origin only. */
export function legPlaces(leg, rfq) {
  switch (leg) {
    case 'pickup': return [rfq.pickup_place, rfq.pol];
    case 'export_customs':
    case 'origin_charges': return [rfq.pol, null];
    case 'freight': return [rfq.pol, rfq.pod];
    case 'destination_charges':
    case 'import_customs': return [rfq.pod, null];
    case 'delivery': return [rfq.pod, rfq.delivery_place];
    default: return [rfq.pol, rfq.pod];
  }
}

const dayStr = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export function cardMatches(card, rfq, onDate = new Date()) {
  if (!card.active) return false;
  if (!(rfq.legs || []).includes(card.leg)) return false;
  if (card.mode && card.mode !== 'ANY' && card.mode !== rfq.mode) return false;
  const d = dayStr(onDate);
  if (card.valid_from && dayStr(card.valid_from) > d) return false;
  if (card.valid_to && dayStr(card.valid_to) < d) return false;
  const [from, to] = legPlaces(card.leg, rfq);
  if (!placeMatches(card.origin, from)) return false;
  if (to !== null && card.destination && !placeMatches(card.destination, to)) return false;
  return true;
}

function metricFor(basis, m) {
  if (basis === 'per_kg') return m.chargeableKg;
  if (basis === 'per_cbm') return m.cbm;
  if (basis === 'per_wm') return m.wm;
  return m.kg;
}

/** Quote lines a card contributes to this RFQ (empty if it does not fit the cargo). */
export function cardLines(card, rfq) {
  const m = shipmentMetrics(rfq);
  const containers = Array.isArray(rfq.containers) ? rfq.containers : [];
  const out = [];
  for (const l of card.lines || []) {
    let qty = null;
    if (l.equipment) {
      if (rfq.mode !== 'FCL') continue;
      const n = containers.filter((c) => c.type === l.equipment).reduce((s, c) => s + Number(c.qty || 0), 0);
      if (!n) continue;
      if (['per_container', 'per_20', 'per_40', 'per_trip'].includes(l.basis)) qty = n;
    }
    const metric = metricFor(l.basis, m);
    if (l.qty_from !== null && l.qty_from !== undefined && metric < Number(l.qty_from)) continue;
    if (l.qty_to !== null && l.qty_to !== undefined && metric > Number(l.qty_to)) continue;
    const line = { leg: card.leg, charge_code: l.charge_code, description: l.description || l.charge_code, basis: l.basis, rate: Number(l.rate), currency: l.currency, qty, confidence: 1 };
    if (l.min_amount) {
      // apply minimum charge
      const q = qty ?? (['per_kg', 'per_cbm', 'per_wm'].includes(l.basis) ? Math.max(metric, l.basis === 'per_wm' ? 1 : 0) : 1);
      if (Number(l.rate) * q < Number(l.min_amount)) Object.assign(line, { basis: 'per_shipment', rate: Number(l.min_amount), qty: null, description: `${line.description} (minimum)` });
    }
    out.push(line);
  }
  return out;
}

/**
 * Best matching card per vendor and leg.
 * Returns [{ vendorId (null = own), legs: { [leg]: { card, lines, total } } }]
 */
export function priceFromCards(rfq, cards, fx, onDate = new Date()) {
  const byVendor = new Map();
  for (const card of cards) {
    if (!cardMatches(card, rfq, onDate)) continue;
    const lines = cardLines(card, rfq);
    if (!lines.length) continue;
    let total;
    try {
      total = quoteTotals({ lines }, rfq, fx).total;
    } catch {
      continue;
    }
    const key = card.vendor_id || 0;
    if (!byVendor.has(key)) byVendor.set(key, { vendorId: card.vendor_id || null, legs: {} });
    const v = byVendor.get(key);
    const cur = v.legs[card.leg];
    if (!cur || total < cur.total) v.legs[card.leg] = { card, lines, total };
  }
  return [...byVendor.values()];
}
