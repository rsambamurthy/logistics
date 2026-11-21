// Missing-charge check (pure): agents leave charges out of a quote ("THC at actuals", no DO fee),
// which makes them look cheaper. For each leg an agent priced, compare its charges with the
// charges agents usually quote on that mode and leg (learnt from past quotes; a standard list
// until there is enough history), flag what is missing and estimate a like-for-like total.
import { normaliseCharge, chargeByCode } from './charges.js';

/** Charges usually on each mode and leg, used until there are enough past quotes. */
export const USUAL = {
  FCL: { freight: ['OFR'], origin_charges: ['OTHC', 'DOC', 'SEAL'], destination_charges: ['DTHC', 'DO'] },
  LCL: { freight: ['OFR'], origin_charges: ['CFS', 'DOC'], destination_charges: ['CFS', 'DO'] },
  AIR: { freight: ['AFR'], origin_charges: ['DOC'], destination_charges: ['DO'] }, // fuel / security surcharges are often in an all-in rate: learnt from history only
};
const MIN_HISTORY = 5;
const SHARE = 0.6; // a charge is "usual" when at least 60 % of past quotes on that leg had it
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const codeOf = (l, leg) => (l.charge_code && l.charge_code !== 'OTHER' ? l.charge_code : normaliseCharge(l.description, leg));

/**
 * Profile from past quotes. samples: [{ mode, leg, lines: [{ charge_code, description, converted }] }]
 * (one sample per quote and leg; converted = line amount in the base currency).
 */
export function chargeProfile(samples) {
  const prof = {};
  for (const s of samples) {
    const k = `${s.mode}|${s.leg}`;
    const p = (prof[k] ??= { n: 0, count: {}, amounts: {} });
    p.n += 1;
    const seen = new Set();
    for (const l of s.lines) {
      const c = codeOf(l, s.leg);
      if (c === 'OTHER' || seen.has(c)) continue;
      seen.add(c);
      p.count[c] = (p.count[c] || 0) + 1;
      if (Number(l.converted) > 0) (p.amounts[c] ??= []).push(Number(l.converted));
    }
  }
  for (const p of Object.values(prof)) {
    p.usual = Object.entries(p.count).filter(([, n]) => n / p.n >= SHARE).map(([c]) => c);
    p.median = Object.fromEntries(Object.entries(p.amounts).map(([c, a]) => [c, Math.round(median(a) * 100) / 100]));
  }
  return prof;
}

const INCLUDED = /\ball[\s-]?in\b|inclusive|incl\.?\b|including/i;

/**
 * Missing charges in one quote. legs: { [leg]: { lines: [...] } } (from quoteTotals), mode, profile.
 * quoteText: remarks / exclusions, so "all-in" quotes are not flagged.
 * Returns { missing: [{ leg, code, name, estimate, source, note }], estimate }.
 */
export function missingCharges(legs, mode, profile, quoteText = '') {
  const missing = [];
  for (const [leg, v] of Object.entries(legs || {})) {
    const p = profile[`${mode}|${leg}`];
    const fromHistory = p && p.n >= MIN_HISTORY;
    const usual = fromHistory ? p.usual : USUAL[mode]?.[leg] || [];
    const have = new Set((v.lines || []).map((l) => codeOf(l, leg)));
    const allIn = (v.lines || []).some((l) => INCLUDED.test(l.description || '')) || INCLUDED.test(quoteText);
    for (const code of usual) {
      if (have.has(code)) continue;
      // DTHC / OTHC often written just as "THC"
      if ((code === 'DTHC' || code === 'OTHC') && [...have].some((c) => c === 'OTHC' || c === 'DTHC')) continue;
      const estimate = fromHistory ? p.median[code] ?? null : null;
      missing.push({
        leg, code, name: chargeByCode(code)?.name || code, estimate: allIn ? null : estimate,
        source: fromHistory ? 'history' : 'usual',
        note: allIn ? 'quote says all-in: check it is included' : fromHistory ? `on ${Math.round((p.count[code] / p.n) * 100)}% of past ${mode} quotes` : `usually charged on ${mode}`,
      });
    }
  }
  const estimate = Math.round(missing.reduce((s, m) => s + (m.estimate || 0), 0) * 100) / 100;
  return { missing, estimate };
}

/** Message to an agent asking about charges missing from their quote. */
export function missingChargesMessage(missing) {
  return `Thank you for your quotation. Before we compare, please confirm the following charges, which are not shown: ${missing.map((m) => m.name).join(', ')}. Are they included, not applicable, or extra (and how much)?`;
}
