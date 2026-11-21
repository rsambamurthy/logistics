// Document cross-check (pure): the same facts appear on the commercial invoice, packing list,
// shipping instructions, BL / AWB and the booking. Any disagreement can stop the cargo at customs
// or delay release, so each field is compared across every document that has it.
import { norm, num, sameText, partyText } from './documents.js';

const FIELDS = [
  ['shipper', 'Shipper', 'text'],
  ['consignee', 'Consignee', 'text'],
  ['packages', 'Number of packages', 'num'],
  ['gross_weight_kg', 'Gross weight (kg)', 'num'],
  ['volume_cbm', 'Volume (cbm)', 'num'],
  ['hs_code', 'HS code', 'hs'],
  ['description', 'Description of goods', 'text'],
  ['invoice_value', 'Invoice value', 'money'],
  ['containers', 'Container numbers', 'containers'],
];
const hs = (v) => String(v ?? '').replace(/[^0-9]/g, '').slice(0, 6); // first 6 digits are international
const containers = (v) => (Array.isArray(v) ? v.map((c) => norm(c?.number || c).replace(/ /g, '')).filter(Boolean).sort().join(',') : '');

function same(kind, a, b) {
  if (kind === 'num') return Math.abs(num(a) - num(b)) <= Math.max(0.01, num(a) * 0.005);
  if (kind === 'money') return Math.abs(num(a) - num(b)) <= Math.max(0.5, num(a) * 0.001);
  if (kind === 'hs') return hs(a) === hs(b) || hs(a).startsWith(hs(b)) || hs(b).startsWith(hs(a));
  if (kind === 'containers') return containers(a) === containers(b);
  return sameText(partyText(a), partyText(b)) || sameText(partyText(b), partyText(a));
}
const present = (kind, v) => (kind === 'num' || kind === 'money' ? num(v) !== null : kind === 'containers' ? !!containers(v) : kind === 'hs' ? !!hs(v) : !!norm(partyText(v)));

/**
 * sources: [{ key, name, fields: {...} }] – e.g. invoice, packing list, SI, BL, booking (RFQ).
 * Returns { checks: [{ field, label, ok, values: [{ source, value }], text }], issues }.
 */
export function crossCheckDocs(sources) {
  const checks = [];
  for (const [field, label, kind] of FIELDS) {
    const values = sources.filter((s) => present(kind, s.fields?.[field])).map((s) => ({ source: s.name, key: s.key, value: s.fields[field] }));
    if (values.length < 2) continue;
    // group into agreeing clusters; the biggest cluster is taken as right
    const groups = [];
    for (const v of values) {
      const g = groups.find((x) => same(kind, x[0].value, v.value));
      if (g) g.push(v); else groups.push([v]);
    }
    groups.sort((a, b) => b.length - a.length);
    const ok = groups.length === 1;
    const show = (v) => (kind === 'containers' ? containers(v) : partyText(v));
    checks.push({
      field, label, ok, values: values.map((v) => ({ ...v, value: show(v.value) })),
      text: ok ? `${label} agrees on ${values.length} documents` : `${label} differs: ${groups.map((g) => `${g.map((v) => v.source).join(' + ')} say "${String(show(g[0].value)).slice(0, 60)}"`).join('; ')}`,
    });
  }
  return { checks, issues: checks.filter((c) => !c.ok).length };
}
