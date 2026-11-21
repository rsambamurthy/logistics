// Past business from a spreadsheet: enquiries, the quotes agents gave, and the jobs that followed.
// Pure: turns sheet rows into checked enquiries (with their agent quotes and job) plus row errors.
import { LEG_CODES, LEGS, BASIS_CODES, CHARGE_CODES, CONTAINER_TYPES, normaliseCharge, normaliseBasis, normalisePackage } from './charges.js';
import { toDate, num, yes } from '../lib/sheets.js';

export const SHEETS = { enquiries: 'Enquiries', quotes: 'Agent quotes', jobs: 'Jobs' };

export const COLUMNS = {
  enquiries: ['ref', 'date', 'customer', 'customer_email', 'mode', 'origin', 'destination', 'pickup_place', 'delivery_place', 'legs', 'incoterm', 'commodity', 'packages', 'package_type', 'gross_weight_kg', 'volume_cbm', 'containers', 'quoted_price', 'quoted_currency', 'outcome', 'lost_reason', 'competitor_price'],
  quotes: ['enquiry_ref', 'agent', 'agent_email', 'asked_on', 'replied_on', 'declined', 'used', 'leg', 'charge_code', 'description', 'basis', 'rate', 'currency', 'qty', 'transit_days', 'carrier', 'valid_until'],
  jobs: ['enquiry_ref', 'job_ref', 'carrier', 'etd', 'eta_booked', 'departed_on', 'arrived_on', 'invoice_no', 'invoice_date', 'invoice_amount', 'invoice_currency', 'due_date', 'paid_on'],
};

export const OUTCOMES = { won: 'accepted', accepted: 'accepted', lost: 'lost', 'no answer': 'expired', 'no reply': 'expired', expired: 'expired', 'not quoted': null, '': null };
export const LOST_REASONS = ['Price too high', 'Lost to a competitor', 'Transit time / routing', 'Slow response', 'Shipment cancelled or postponed', 'No reply from customer', 'Other'];

const MODE_WORDS = { FCL: 'FCL', LCL: 'LCL', AIR: 'AIR', 'SEA FCL': 'FCL', 'SEA LCL': 'LCL', 'AIR FREIGHT': 'AIR', AIRFREIGHT: 'AIR' };

/** "2x40HC, 1 x 20' GP" -> [{ type: '40HC', qty: 2 }, { type: '20GP', qty: 1 }] */
export function parseContainers(text) {
  const out = [];
  const bad = [];
  for (const part of String(text || '').split(/[,;+]/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.replace(/['\s]/g, '').toUpperCase().match(/^(\d+)?[X*]?(\d{2}[A-Z]{2})$/);
    const type = m && (m[2] === '40HQ' ? '40HC' : m[2] === '20DV' || m[2] === '20DC' ? '20GP' : m[2] === '40DV' || m[2] === '40DC' ? '40GP' : m[2]);
    if (m && CONTAINER_TYPES.includes(type)) out.push({ type, qty: Number(m[1] || 1) });
    else bad.push(part);
  }
  return { containers: out, bad };
}

/** "freight, export customs" / "Main freight" -> leg codes */
export function parseLeg(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const code = t.replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
  if (LEG_CODES.includes(code)) return code;
  const byName = LEGS.find((l) => l.name.toLowerCase() === t);
  if (byName) return byName.code;
  if (/freight|ocean|air ?freight/.test(t)) return 'freight';
  if (/pick ?up|origin truck|haulage at origin/.test(t)) return 'pickup';
  if (/deliver|destination truck/.test(t)) return 'delivery';
  if (/export.*(custom|clear|cha)|cha.*export/.test(t)) return 'export_customs';
  if (/import.*(custom|clear|cha)|cha.*import/.test(t)) return 'import_customs';
  if (/origin|thc.*origin|terminal.*origin/.test(t)) return 'origin_charges';
  if (/destination|dest/.test(t)) return 'destination_charges';
  return null;
}

const lowerKey = (s) => String(s || '').trim().toLowerCase();

/**
 * sheets: { enquiries: rows, quotes: rows, jobs: rows } (rows already normalised: snake_case keys).
 * Returns { enquiries, errors, warnings, counts }. An enquiry with an error is left out; the others import.
 */
export function parseHistory(sheets) {
  const errors = [];
  const warnings = [];
  const err = (sheet, row, message) => errors.push({ sheet: SHEETS[sheet], row, message });
  const byRef = new Map();

  (sheets.enquiries || []).forEach((r, i) => {
    const row = i + 2;
    if (!Object.values(r).some((v) => v !== '' && v !== null)) return;
    const ref = String(r.ref ?? '').trim();
    if (!ref) return err('enquiries', row, 'ref is missing');
    if (byRef.has(lowerKey(ref))) return err('enquiries', row, `ref "${ref}" appears twice`);
    const date = toDate(r.date);
    if (!date) return err('enquiries', row, `date "${r.date}" is missing or not a date (use YYYY-MM-DD or DD/MM/YYYY)`);
    const mode = MODE_WORDS[String(r.mode || '').trim().toUpperCase()];
    if (!mode) return err('enquiries', row, `mode "${r.mode}" should be FCL, LCL or AIR`);
    if (!r.origin || !r.destination) return err('enquiries', row, 'origin and destination are needed');
    const legs = String(r.legs || 'freight').split(/[,;]/).map(parseLeg);
    if (legs.some((l) => !l)) return err('enquiries', row, `legs "${r.legs}" not recognised (use ${LEG_CODES.join(', ')})`);
    const { containers, bad } = parseContainers(r.containers);
    if (bad.length) return err('enquiries', row, `containers "${bad.join(', ')}" not recognised (write like 2x40HC, 1x20GP)`);
    if (mode === 'FCL' && !containers.length) return err('enquiries', row, 'FCL needs containers, e.g. 1x40HC');
    if (mode !== 'FCL' && !num(r.gross_weight_kg) && !num(r.volume_cbm)) return err('enquiries', row, `${mode} needs gross_weight_kg or volume_cbm`);
    const outcomeKey = lowerKey(r.outcome);
    if (!(outcomeKey in OUTCOMES)) return err('enquiries', row, `outcome "${r.outcome}" should be won, lost, no answer or not quoted`);
    const sell = num(r.quoted_price);
    if (OUTCOMES[outcomeKey] && !sell) warnings.push({ sheet: SHEETS.enquiries, row, message: `${ref}: outcome given without quoted_price, so it can't teach margin advice` });
    const reason = r.lost_reason ? LOST_REASONS.find((x) => x.toLowerCase().startsWith(lowerKey(r.lost_reason).slice(0, 6))) || 'Other' : null;
    byRef.set(lowerKey(ref), {
      row, ref, date,
      customer: r.customer || r.customer_email ? { name: String(r.customer || r.customer_email).trim(), email: lowerKey(r.customer_email) || null } : null,
      rfq: {
        mode, pol: String(r.origin).trim(), pod: String(r.destination).trim(),
        pickup_place: r.pickup_place || null, delivery_place: r.delivery_place || null,
        legs: [...new Set(legs)].sort((a, b) => LEG_CODES.indexOf(a) - LEG_CODES.indexOf(b)),
        incoterm: r.incoterm ? String(r.incoterm).toUpperCase() : null, commodity: r.commodity || null,
        packages: num(r.packages), package_type: normalisePackage(r.package_type), gross_weight_kg: num(r.gross_weight_kg), volume_cbm: num(r.volume_cbm), containers,
      },
      sell, currency: r.quoted_currency ? String(r.quoted_currency).toUpperCase() : null,
      outcome: OUTCOMES[outcomeKey], lost_reason: OUTCOMES[outcomeKey] === 'lost' ? reason || 'Other' : null,
      lost_note: reason === 'Other' && r.lost_reason && lowerKey(r.lost_reason) !== 'other' ? String(r.lost_reason) : null,
      competitor_price: num(r.competitor_price),
      agents: new Map(), job: null,
    });
  });

  const bad = new Set(); // enquiries with a broken quote or job row are left out whole
  (sheets.quotes || []).forEach((r, i) => {
    const row = i + 2;
    if (!Object.values(r).some((v) => v !== '' && v !== null)) return;
    const e = byRef.get(lowerKey(r.enquiry_ref));
    if (!e) return err('quotes', row, `enquiry_ref "${r.enquiry_ref}" is not on the Enquiries sheet (or that row has an error)`);
    const fail = (m) => { bad.add(lowerKey(r.enquiry_ref)); err('quotes', row, m); };
    const name = String(r.agent || r.agent_email || '').trim();
    if (!name) return fail('agent (or agent_email) is missing');
    const key = lowerKey(r.agent_email) || lowerKey(name);
    const asked = toDate(r.asked_on) || e.date;
    const replied = toDate(r.replied_on);
    if (r.replied_on && !replied) return fail(`replied_on "${r.replied_on}" is not a date`);
    if (replied && replied < asked) return fail('replied_on is before asked_on');
    let a = e.agents.get(key);
    if (!a) {
      a = { name, email: lowerKey(r.agent_email) || null, asked_on: asked, replied_on: replied, declined: false, used: false, transit_days: null, carrier: null, valid_until: null, legs: new Set(), lines: [] };
      e.agents.set(key, a);
    }
    a.replied_on = a.replied_on || replied;
    a.declined = a.declined || yes(r.declined);
    a.used = a.used || yes(r.used);
    a.transit_days ??= num(r.transit_days);
    a.carrier ??= r.carrier || null;
    a.valid_until ??= toDate(r.valid_until);
    const rate = num(r.rate);
    if (rate === null) { if (r.leg) a.legs.add(parseLeg(r.leg) || 'freight'); return; } // an agent asked who did not quote
    const leg = parseLeg(r.leg) || (e.rfq.legs.length === 1 ? e.rfq.legs[0] : null);
    if (!leg) return fail(`leg "${r.leg}" not recognised`);
    const codeText = String(r.charge_code || '').toUpperCase();
    const code = CHARGE_CODES.some((c) => c.code === codeText) ? codeText : normaliseCharge(r.charge_code || r.description || '', leg);
    const basisText = String(r.basis || '').toLowerCase();
    const basis = BASIS_CODES.includes(basisText) ? basisText : r.basis ? normaliseBasis(r.basis) : leg === 'freight' ? (e.rfq.mode === 'FCL' ? 'per_container' : e.rfq.mode === 'AIR' ? 'per_kg' : 'per_cbm') : 'per_shipment';
    if (!r.currency) return fail('currency is missing');
    a.replied_on = a.replied_on || asked; // a price means they answered
    a.legs.add(leg);
    a.lines.push({ leg, charge_code: code, description: r.description || null, basis, rate, currency: String(r.currency).toUpperCase(), qty: num(r.qty), sort: a.lines.length });
  });

  (sheets.jobs || []).forEach((r, i) => {
    const row = i + 2;
    if (!Object.values(r).some((v) => v !== '' && v !== null)) return;
    const e = byRef.get(lowerKey(r.enquiry_ref));
    if (!e) return err('jobs', row, `enquiry_ref "${r.enquiry_ref}" is not on the Enquiries sheet (or that row has an error)`);
    if (e.job) { bad.add(lowerKey(r.enquiry_ref)); return err('jobs', row, `a second job for ${e.ref}: one job per enquiry`); }
    const d = (k) => toDate(r[k]);
    for (const k of ['etd', 'eta_booked', 'departed_on', 'arrived_on', 'invoice_date', 'due_date', 'paid_on']) {
      if (r[k] && !d(k)) { bad.add(lowerKey(r.enquiry_ref)); return err('jobs', row, `${k} "${r[k]}" is not a date`); }
    }
    e.job = {
      row, ref: r.job_ref ? String(r.job_ref).trim() : null, carrier: r.carrier || null,
      etd: d('etd'), eta: d('eta_booked'), atd: d('departed_on'), ata: d('arrived_on'),
      invoice_no: r.invoice_no ? String(r.invoice_no) : null, invoice_date: d('invoice_date'), invoice_amount: num(r.invoice_amount),
      invoice_currency: r.invoice_currency ? String(r.invoice_currency).toUpperCase() : e.currency, due_date: d('due_date'), paid_at: d('paid_on'),
    };
    if (e.job.invoice_amount && !e.job.invoice_date) e.job.invoice_date = e.job.atd || e.job.etd || e.date;
    if (e.outcome !== 'accepted') e.outcome = e.sell ? 'accepted' : e.outcome; // a job means it was won
  });

  const enquiries = [...byRef.values()].filter((e) => !bad.has(lowerKey(e.ref))).map((e) => ({ ...e, agents: [...e.agents.values()].map((a) => ({ ...a, legs: [...(a.legs.size ? a.legs : e.rfq.legs)] })) }));
  const counts = {
    enquiries: enquiries.length,
    agent_quotes: enquiries.reduce((s, e) => s + e.agents.filter((a) => a.lines.length).length, 0),
    no_reply: enquiries.reduce((s, e) => s + e.agents.filter((a) => !a.replied_on).length, 0),
    jobs: enquiries.filter((e) => e.job).length,
    invoices: enquiries.filter((e) => e.job?.invoice_amount).length,
    won_lost: enquiries.filter((e) => e.outcome && e.sell).length,
  };
  return { enquiries, errors, warnings, counts };
}
