// Cost-leakage check (pure): match an agent's invoice against what was quoted and booked for the
// job, and list extras, over-charges, charges not billed and arithmetic problems.
import { normaliseCharge } from './charges.js';

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const words = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
const similar = (a, b) => {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
};

/**
 * invoice: { currency, total, tax, lines: [{ description, charge_code, amount, currency }] }
 * expected: [{ id, description, charge_code, leg, amount, currency }]  (the job's buy lines for this agent)
 * convert(amount, from, to) converts currencies (throws when it can't)
 * Returns { matches, findings, expected_total, invoiced_total, leakage, status }.
 */
export function checkInvoice(invoice, expected, convert, { tolerancePct = 2, toleranceAbs = 1 } = {}) {
  const cur = invoice.currency;
  const conv = (amount, from) => { try { return convert(Number(amount), from || cur, cur); } catch { return null; } };
  const exp = expected.map((e) => ({ ...e, code: e.charge_code || normaliseCharge(e.description, e.leg), value: conv(e.amount, e.currency), used: false }));
  const lines = (invoice.lines || []).map((l) => ({ ...l, code: l.charge_code && l.charge_code !== 'OTHER' ? l.charge_code : normaliseCharge(l.description), value: conv(l.amount, l.currency || cur) }));
  const matches = [];
  const findings = [];
  for (const l of lines) {
    // same charge code first (closest amount), then a similar description
    let cand = exp.filter((e) => !e.used && e.code === l.code && l.code !== 'OTHER');
    if (!cand.length) cand = exp.filter((e) => !e.used && similar(e.description, l.description) >= 0.5);
    cand.sort((x, y) => Math.abs((x.value ?? 0) - (l.value ?? 0)) - Math.abs((y.value ?? 0) - (l.value ?? 0)));
    const m = cand[0];
    if (!m) {
      matches.push({ line: l, expected: null, diff: r2(l.value ?? l.amount) });
      findings.push({ type: 'extra', severity: 'high', amount: r2(l.value ?? l.amount), text: `Not quoted: ${l.description} ${r2(l.amount)} ${l.currency || cur}` });
      continue;
    }
    m.used = true;
    const diff = l.value !== null && m.value !== null ? r2(l.value - m.value) : null;
    matches.push({ line: l, expected: { id: m.id, description: m.description, amount: m.amount, currency: m.currency, value: r2(m.value) }, diff });
    if (diff !== null && diff > Math.max(toleranceAbs, (Math.abs(m.value) * tolerancePct) / 100)) {
      findings.push({ type: 'over', severity: 'high', amount: diff, text: `${l.description}: billed ${r2(l.amount)} ${l.currency || cur}, quoted ${r2(m.amount)} ${m.currency} (+${diff} ${cur})` });
    } else if (diff !== null && diff < -Math.max(toleranceAbs, (Math.abs(m.value) * tolerancePct) / 100)) {
      findings.push({ type: 'under', severity: 'info', amount: diff, text: `${l.description}: billed ${Math.abs(diff)} ${cur} less than quoted` });
    }
    if (m.currency && (l.currency || cur) !== m.currency) findings.push({ type: 'currency', severity: 'low', amount: 0, text: `${l.description}: quoted in ${m.currency}, billed in ${l.currency || cur} (check the exchange rate used)` });
  }
  for (const e of exp.filter((x) => !x.used)) findings.push({ type: 'not_billed', severity: 'info', amount: 0, text: `Quoted but not on this invoice: ${e.description} ${r2(e.amount)} ${e.currency} (may come on another invoice)` });
  const sumLines = r2(lines.reduce((s, l) => s + (l.value ?? 0), 0));
  const stated = invoice.total !== null && invoice.total !== undefined && invoice.total !== '' ? Number(invoice.total) : null;
  const tax = Number(invoice.tax || 0);
  if (stated !== null && Math.abs(stated - (sumLines + tax)) > Math.max(1, stated * 0.005)) findings.push({ type: 'sum', severity: 'high', amount: r2(stated - sumLines - tax), text: `Invoice total ${stated} does not equal its lines ${sumLines}${tax ? ` + tax ${tax}` : ''}` });
  const leakage = r2(findings.filter((f) => f.type === 'extra' || f.type === 'over' || (f.type === 'sum' && f.amount > 0)).reduce((s, f) => s + f.amount, 0));
  const expectedTotal = r2(exp.filter((e) => e.used).reduce((s, e) => s + (e.value ?? 0), 0));
  return {
    matches, findings, leakage, expected_total: expectedTotal, invoiced_total: stated ?? r2(sumLines + tax), currency: cur,
    status: findings.some((f) => f.severity === 'high') ? 'to_check' : 'ok',
  };
}

/** Plain text for an email to the agent about the differences. */
export function disputeText(invoice, result, { agent, job, company }) {
  const issues = result.findings.filter((f) => f.severity === 'high').map((f) => `- ${f.text}`);
  return [
    `Dear ${agent || 'team'},`,
    '',
    `Re: your invoice ${invoice.invoice_no || ''} for our job ${job || ''}`.trim(),
    '',
    'We checked it against your quotation and found these differences:',
    ...issues,
    '',
    `Please send a corrected invoice, or the supporting documents for these charges. Difference: ${result.leakage} ${result.currency}.`,
    '',
    'Thank you,',
    company || '',
  ].join('\n');
}
