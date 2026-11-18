// Pure document logic: which documents a job needs, checklist status, and checking a BL / AWB against the SI.

export const DOC_TYPES = [
  { code: 'invoice', name: 'Commercial invoice', from: 'customer' },
  { code: 'packing_list', name: 'Packing list', from: 'customer' },
  { code: 'si', name: 'Shipping instructions', air: "Shipper's letter of instruction", from: 'us' },
  { code: 'vgm', name: 'VGM declaration', from: 'customer' },
  { code: 'shipping_bill', name: 'Shipping bill', from: 'customs' },
  { code: 'export_declaration', name: 'Export declaration', from: 'customs' },
  { code: 'bill_of_entry', name: 'Bill of entry', from: 'customs' },
  { code: 'import_declaration', name: 'Import declaration', from: 'customs' },
  { code: 'dg_declaration', name: 'DG declaration / MSDS', from: 'customer' },
  { code: 'coo', name: 'Certificate of origin', from: 'customer' },
  { code: 'insurance', name: 'Insurance certificate', from: 'customer' },
  { code: 'booking', name: 'Booking confirmation', from: 'agent' },
  { code: 'draft_bl', name: 'Draft BL', air: 'Draft AWB', from: 'agent' },
  { code: 'bl', name: 'Bill of lading', air: 'Air waybill', from: 'agent' },
  { code: 'other', name: 'Other', from: 'customer' },
];
export const docName = (code, mode) => {
  const d = DOC_TYPES.find((x) => x.code === code);
  return d ? (mode === 'AIR' && d.air) || d.name : code;
};
/** Codes a customer is asked to send (used to request documents). */
export const CUSTOMER_DOCS = DOC_TYPES.filter((d) => d.from === 'customer' && d.code !== 'other').map((d) => d.code);

/** Documents a job needs, from its RFQ (mode, legs, DG) and the tenant's country. */
export function requiredDocs(rfq, country = 'IN') {
  const legs = rfq?.legs || [];
  const hk = String(country).toUpperCase() === 'HK';
  const out = ['invoice', 'packing_list'];
  if (legs.includes('freight')) out.push('si');
  if (rfq?.mode === 'FCL' && (legs.includes('freight') || legs.includes('origin_charges'))) out.push('vgm');
  if (legs.includes('export_customs')) out.push(hk ? 'export_declaration' : 'shipping_bill');
  if (legs.includes('import_customs')) out.push(hk ? 'import_declaration' : 'bill_of_entry');
  if (rfq?.dangerous_goods) out.push('dg_declaration');
  if (legs.includes('freight')) out.push('bl');
  return out;
}

/**
 * Checklist rows: { code, name, from, status, files }
 * status: missing | received | sent (SI sent to agent) | draft (draft BL in progress) | final | waived
 */
export function checklist({ rfq, country, files = [], waived = [], extra = [], si = null, bls = [] }) {
  const codes = [...new Set([...requiredDocs(rfq, country), ...extra])];
  return codes.map((code) => {
    const d = DOC_TYPES.find((x) => x.code === code) || { code, from: 'customer' };
    const mine = files.filter((f) => f.kind === code);
    let status = mine.length ? 'received' : 'missing';
    if (code === 'si' && si?.status && si.status !== 'draft') status = 'sent';
    else if (code === 'si' && si) status = 'draft';
    if (code === 'bl') {
      if (bls.some((b) => b.is_final)) status = 'final';
      else if (bls.length) status = 'draft';
    }
    if (waived.includes(code) && !['received', 'sent', 'final'].includes(status)) status = 'waived';
    return { code, name: docName(code, rfq?.mode), from: d.from, status, files: mine.map((f) => f.id), required: !extra.includes(code) };
  });
}
export const missingFromCustomer = (rows) => rows.filter((r) => r.status === 'missing' && r.from === 'customer').map((r) => r.code);

// ---- BL / AWB vs SI ----
const norm = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null;
};
const partyText = (p) => (p && typeof p === 'object' ? [p.name, p.address].filter(Boolean).join(' ') : p);

// ports: ignore UN/LOCODEs and bracketed codes ("Hong Kong (HKHKG)" = "HONG KONG")
const place = (v) => (v ? String(v).replace(/\([^)]*\)/g, ' ').replace(/\b[A-Z]{2}[A-Z0-9]{3}\b/g, ' ') : v);
const TEXT_FIELDS = [
  ['shipper', 'Shipper', partyText],
  ['consignee', 'Consignee', partyText],
  ['notify_party', 'Notify party', partyText],
  ['pol', 'Port of loading', place],
  ['pod', 'Port of discharge', place],
  ['place_of_delivery', 'Place of delivery', place],
  ['vessel', 'Vessel'],
  ['voyage', 'Voyage'],
  ['description', 'Description of goods'],
  ['marks', 'Marks and numbers'],
  ['hs_code', 'HS code'],
  ['freight_terms', 'Freight terms'],
];
const NUM_FIELDS = [
  ['packages', 'Packages'],
  ['gross_weight_kg', 'Gross weight (kg)'],
  ['volume_cbm', 'Volume (cbm)'],
  ['originals', 'Number of originals'],
];

/** True when b contains all words of a (BLs often wrap or abbreviate addresses, so containment is enough). */
function sameText(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (!x || !y) return false;
  const words = x.split(' ');
  const yw = new Set(y.split(' '));
  return words.filter((w) => !yw.has(w)).length <= Math.floor(words.length * 0.1);
}

/** Differences between what we instructed (SI) and what the agent put on the draft. */
export function compareToSi(si = {}, bl = {}) {
  const out = [];
  for (const [k, label, get = (v) => v] of TEXT_FIELDS) {
    const a = get(si[k]);
    const b = get(bl[k]);
    if (!norm(a)) continue;
    if (!norm(b)) out.push({ field: k, label, si: a, bl: null, kind: 'missing' });
    else if (!sameText(a, b)) out.push({ field: k, label, si: a, bl: b, kind: 'different' });
  }
  for (const [k, label] of NUM_FIELDS) {
    const a = num(si[k]);
    const b = num(bl[k]);
    if (a === null) continue;
    if (b === null) out.push({ field: k, label, si: si[k], bl: null, kind: 'missing' });
    else if (Math.abs(a - b) > Math.max(0.01, a * 0.005)) out.push({ field: k, label, si: si[k], bl: bl[k], kind: 'different' });
  }
  const cn = (list) => new Map((list || []).filter((c) => c?.number).map((c) => [norm(c.number).replace(/ /g, ''), c]));
  const sc = cn(si.containers);
  const bc = cn(bl.containers);
  for (const [n, c] of sc) {
    const o = bc.get(n);
    if (!o) out.push({ field: 'containers', label: `Container ${c.number}`, si: c.number, bl: null, kind: 'missing' });
    else if (c.seal && norm(c.seal) !== norm(o.seal)) out.push({ field: 'containers', label: `Seal of ${c.number}`, si: c.seal, bl: o.seal || null, kind: o.seal ? 'different' : 'missing' });
  }
  for (const [n, c] of bc) if (sc.size && !sc.has(n)) out.push({ field: 'containers', label: `Container ${c.number}`, si: null, bl: c.number, kind: 'extra' });
  return out;
}

/** Plain-text list of corrections for an email to the agent. */
export function correctionsText(discrepancies) {
  return (discrepancies || []).map((d) => `- ${d.label}: ${d.si ? `should read "${d.si}"` : 'please remove'}${d.bl ? ` (draft shows "${d.bl}")` : ' (missing on draft)'}`).join('\n');
}
