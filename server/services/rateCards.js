// Rate cards: stored buy rates (own or a vendor's) that can price an RFQ without emailing anyone.
import * as XLSX from 'xlsx';
import { q, one, tx } from '../db.js';
import { priceFromCards } from '../engines/ratecards.js';
import { LEG_CODES, BASIS_CODES, CHARGE_CODES, normaliseCharge, normaliseBasis, legName, MODES } from '../engines/charges.js';
import { getFx } from './settings.js';
import { saveQuote } from './replies.js';
import { systemInvite, ownParty } from './rfq.js';

const CARD_FIELDS = ['name', 'vendor_id', 'leg', 'mode', 'origin', 'destination', 'carrier', 'valid_from', 'valid_to', 'transit_days', 'free_days', 'notes', 'active'];
const blank = (v) => (v === '' || v === undefined ? null : v);

export async function listCards({ leg, vendor, status } = {}) {
  const where = [];
  const vals = [];
  if (leg) { vals.push(leg); where.push(`c.leg=$${vals.length}`); }
  if (vendor === 'own') where.push('c.vendor_id IS NULL');
  else if (vendor) { vals.push(Number(vendor)); where.push(`c.vendor_id=$${vals.length}`); }
  if (status === 'active') where.push('c.active AND (c.valid_to IS NULL OR c.valid_to >= current_date)');
  if (status === 'expiring') where.push("c.active AND c.valid_to BETWEEN current_date AND current_date + 7");
  if (status === 'expired') where.push('c.valid_to < current_date');
  return q(
    `SELECT c.*, a.company AS vendor_name, (SELECT count(*)::int FROM rate_card_lines l WHERE l.rate_card_id=c.id) AS line_count
     FROM rate_cards c LEFT JOIN agents a ON a.id=c.vendor_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY c.leg, c.origin NULLS FIRST, c.destination NULLS FIRST, c.name`,
    vals
  );
}

export async function getCard(id) {
  const card = await one('SELECT c.*, a.company AS vendor_name FROM rate_cards c LEFT JOIN agents a ON a.id=c.vendor_id WHERE c.id=$1', [id]);
  if (card) card.lines = await q('SELECT * FROM rate_card_lines WHERE rate_card_id=$1 ORDER BY sort, id', [id]);
  return card;
}

function validate(card) {
  if (!card.name) throw Object.assign(new Error('Rate card name is required'), { status: 400 });
  if (!LEG_CODES.includes(card.leg)) throw Object.assign(new Error(`Invalid leg "${card.leg}"`), { status: 400 });
  for (const l of card.lines || []) {
    if (!BASIS_CODES.includes(l.basis)) throw Object.assign(new Error(`Invalid basis "${l.basis}"`), { status: 400 });
    if (l.rate === '' || l.rate === null || Number.isNaN(Number(l.rate))) throw Object.assign(new Error('Every line needs a rate'), { status: 400 });
  }
}

/** Create or update a card and replace its lines. */
export async function saveCard(data, t) {
  validate(data);
  const run = async (db) => {
    const vals = CARD_FIELDS.map((f) => (f === 'active' ? data.active !== false : blank(data[f])));
    let card;
    if (data.id) {
      card = await db.one(`UPDATE rate_cards SET ${CARD_FIELDS.map((f, i) => `${f}=$${i + 1}`).join(',')}, updated_at=now() WHERE id=$${CARD_FIELDS.length + 1} RETURNING *`, [...vals, data.id]);
      await db.q('DELETE FROM rate_card_lines WHERE rate_card_id=$1', [data.id]);
    } else {
      card = await db.one(`INSERT INTO rate_cards(${CARD_FIELDS.join(',')}) VALUES(${CARD_FIELDS.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals);
    }
    let i = 0;
    for (const l of data.lines || []) {
      await db.q(
        'INSERT INTO rate_card_lines(rate_card_id,charge_code,description,basis,rate,currency,equipment,qty_from,qty_to,min_amount,sort) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [card.id, l.charge_code || 'OTHER', blank(l.description), l.basis, Number(l.rate), String(l.currency || 'USD').toUpperCase(), blank(l.equipment), blank(l.qty_from), blank(l.qty_to), blank(l.min_amount), i++]
      );
    }
    return card;
  };
  return t ? run(t) : tx(run);
}

export async function copyCard(id) {
  const c = await getCard(id);
  const { id: _id, created_at, updated_at, vendor_name, ...rest } = c;
  return saveCard({ ...rest, name: `${c.name} (copy)`, lines: c.lines.map(({ id: _l, rate_card_id, ...l }) => l) });
}

export async function deleteCard(id) {
  await q('DELETE FROM rate_cards WHERE id=$1', [id]);
}

export async function expiringCount() {
  const r = await one("SELECT count(*) FILTER (WHERE active AND valid_to BETWEEN current_date AND current_date + 7)::int AS expiring, count(*) FILTER (WHERE active AND valid_to < current_date)::int AS expired FROM rate_cards");
  return r;
}

async function loadActiveCards() {
  const cards = await q('SELECT * FROM rate_cards WHERE active');
  if (!cards.length) return [];
  const lines = await q('SELECT * FROM rate_card_lines WHERE rate_card_id = ANY($1) ORDER BY sort, id', [cards.map((c) => c.id)]);
  for (const c of cards) c.lines = lines.filter((l) => l.rate_card_id === c.id);
  return cards;
}

/**
 * Price an RFQ from rate cards. Each vendor's best card per leg becomes a quote in the comparison
 * (own cards go under "Our own rates"). Quotes received by email are never overwritten.
 */
export async function applyRateCards(rfqId) {
  const rfq = await one('SELECT * FROM rfqs WHERE id=$1', [rfqId]);
  const fx = await getFx();
  const cards = await loadActiveCards();
  const onDate = rfq.ready_date && new Date(rfq.ready_date) > new Date() ? new Date(rfq.ready_date) : new Date();
  const groups = priceFromCards(rfq, cards, fx, onDate).filter((g) => !g.vendorId || g.vendorId !== rfq.requester_id);
  const own = await ownParty();
  const results = [];
  const covered = new Set();
  for (const g of groups) {
    const partyId = g.vendorId || own.id;
    const invite = await systemInvite(rfq.id, partyId, g.vendorId ? 'ratecard' : 'own');
    const current = await one('SELECT source FROM agent_quotes WHERE invite_id=$1 AND NOT superseded ORDER BY id DESC LIMIT 1', [invite.id]);
    const party = await one('SELECT company FROM agents WHERE id=$1', [partyId]);
    if (current && current.source !== 'ratecard') {
      results.push({ party: party.company, skipped: true, reason: current.source === 'ai' ? 'has an emailed quote' : 'has a manually entered quote' });
      continue;
    }
    const legs = Object.values(g.legs);
    const lines = legs.flatMap((x) => x.lines);
    const freight = g.legs.freight?.card;
    const validTo = legs.map((x) => x.card.valid_to).filter(Boolean).sort()[0] || null;
    const qrow = await saveQuote({
      rfq_id: rfq.id,
      invite_id: invite.id,
      lines,
      valid_until: validTo,
      transit_days: freight?.transit_days ?? null,
      free_days: freight?.free_days ?? null,
      carrier: freight?.carrier || null,
      remarks: `From rate cards: ${legs.map((x) => x.card.name).join(', ')}`,
      verified: true,
      confidence: 1,
      source: 'ratecard',
    });
    await q('UPDATE agent_quotes SET rate_card_ids=$1 WHERE id=$2', [legs.map((x) => x.card.id), qrow.id]);
    Object.keys(g.legs).forEach((l) => covered.add(l));
    results.push({ party: party.company, legs: Object.keys(g.legs), quote_id: qrow.id });
  }
  const missing = (rfq.legs || []).filter((l) => !covered.has(l));
  return { results, missing_legs: missing, missing_names: missing.map(legName) };
}

// ---------------- Excel / CSV import ----------------
export const TEMPLATE_COLUMNS = ['card_name', 'vendor_email', 'leg', 'mode', 'origin', 'destination', 'carrier', 'valid_from', 'valid_to', 'transit_days', 'free_days', 'charge_code', 'description', 'basis', 'equipment', 'rate', 'currency', 'qty_from', 'qty_to', 'min_amount'];

export function templateWorkbook() {
  const wb = XLSX.utils.book_new();
  const rows = [
    TEMPLATE_COLUMNS,
    ['ONE MAA-HKG Dec', '', 'freight', 'FCL', 'Chennai, INMAA', 'Hong Kong, HKHKG', 'ONE', '2026-12-01', '2026-12-31', 9, 14, 'OFR', 'Ocean freight', 'per_container', '20GP', 450, 'USD', '', '', ''],
    ['ONE MAA-HKG Dec', '', 'freight', 'FCL', 'Chennai, INMAA', 'Hong Kong, HKHKG', 'ONE', '2026-12-01', '2026-12-31', 9, 14, 'OFR', 'Ocean freight', 'per_container', '40HC', 610, 'USD', '', '', ''],
    ['ONE MAA-HKG Dec', '', 'freight', 'FCL', 'Chennai, INMAA', 'Hong Kong, HKHKG', 'ONE', '2026-12-01', '2026-12-31', 9, 14, 'BAF', 'Bunker surcharge', 'per_container', '', 60, 'USD', '', '', ''],
    ['Chennai CHA', '', 'export_customs', 'ANY', 'Chennai, INMAA', '', '', '2026-11-01', '2027-03-31', '', '', 'CHA', 'Customs clearance', 'per_declaration', '', 3500, 'INR', '', '', ''],
    ['Sriperumbudur trucking', 'transport@example.com', 'pickup', 'FCL', 'Sriperumbudur, Oragadam', 'Chennai, INMAA', '', '2026-11-01', '2027-03-31', '', '', 'TRUCK', '40ft trailer', 'per_trip', '40HC', 16000, 'INR', '', '', ''],
    ['MAA-HKG air', '', 'freight', 'AIR', 'Chennai, MAA', 'Hong Kong, HKG', 'CX', '2026-11-01', '2026-12-31', 1, '', 'AFR', 'Air freight 100-500kg', 'per_kg', '', 2.1, 'USD', 100, 500, 150],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Rates');
  const help = [
    ['How to fill this sheet'],
    ['One row per charge. Rows with the same card_name (and vendor_email) form one rate card. Importing a card with an existing name replaces it.'],
    ['vendor_email: leave blank for your own rates, or the email of the transporter / line / agent whose rates these are.'],
    ['origin / destination: comma-separated names or codes that should match the RFQ (e.g. "Chennai, INMAA"). Blank = any. For customs and port charges only origin is used (the port).'],
    ['equipment: container type for FCL lines (20GP, 40GP, 40HC...). Blank = applies to every container.'],
    ['qty_from / qty_to: weight or volume break (kg for per_kg, cbm for per_cbm). min_amount: minimum charge.'],
    [],
    ['leg codes', LEG_CODES.join(', ')],
    ['mode', [...MODES.map((m) => m.code), 'ANY'].join(', ')],
    ['basis codes', BASIS_CODES.join(', ')],
    ['charge codes', CHARGE_CODES.map((c) => `${c.code} (${c.name})`).join(', ')],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(help), 'Help');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const toDate = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); // dd/mm/yyyy
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

export async function importRateCards(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets.Rates || wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' }).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [String(k).trim().toLowerCase().replace(/\s+/g, '_'), typeof v === 'string' ? v.trim() : v])));
  const errors = [];
  const groups = new Map();
  rows.forEach((r, i) => {
    const rowNo = i + 2;
    if (!r.card_name && !r.rate) return;
    if (!r.card_name) return errors.push(`Row ${rowNo}: card_name is missing`);
    const leg = String(r.leg || '').toLowerCase();
    if (!LEG_CODES.includes(leg)) return errors.push(`Row ${rowNo}: unknown leg "${r.leg}"`);
    if (num(r.rate) === null) return errors.push(`Row ${rowNo}: rate is missing or not a number`);
    const key = `${r.card_name}||${String(r.vendor_email || '').toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        name: r.card_name,
        vendor_email: String(r.vendor_email || '').toLowerCase(),
        leg,
        mode: r.mode ? String(r.mode).toUpperCase() : null,
        origin: r.origin || null,
        destination: r.destination || null,
        carrier: r.carrier || null,
        valid_from: toDate(r.valid_from),
        valid_to: toDate(r.valid_to),
        transit_days: num(r.transit_days),
        free_days: num(r.free_days),
        active: true,
        lines: [],
      });
    }
    const code = CHARGE_CODES.some((c) => c.code === String(r.charge_code).toUpperCase()) ? String(r.charge_code).toUpperCase() : normaliseCharge(r.charge_code || r.description, leg);
    groups.get(key).lines.push({
      charge_code: code,
      description: r.description || null,
      basis: BASIS_CODES.includes(String(r.basis).toLowerCase()) ? String(r.basis).toLowerCase() : normaliseBasis(r.basis),
      equipment: r.equipment ? String(r.equipment).toUpperCase().replace(/\s|'/g, '') : null,
      rate: num(r.rate),
      currency: String(r.currency || 'USD').toUpperCase(),
      qty_from: num(r.qty_from),
      qty_to: num(r.qty_to),
      min_amount: num(r.min_amount),
    });
  });
  let created = 0;
  let replaced = 0;
  await tx(async (t) => {
    for (const g of groups.values()) {
      let vendorId = null;
      if (g.vendor_email) {
        let v = await t.one('SELECT id FROM agents WHERE lower(email)=$1', [g.vendor_email]);
        if (!v) v = await t.one("INSERT INTO agents(company,email,is_agent,is_customer,source,services) VALUES($1,$2,true,false,'ratecard',$3) RETURNING id", [g.vendor_email.split('@')[1] || g.vendor_email, g.vendor_email, [g.leg]]);
        vendorId = v.id;
      }
      const ex = await t.one('SELECT id FROM rate_cards WHERE name=$1 AND vendor_id IS NOT DISTINCT FROM $2', [g.name, vendorId]);
      await saveCard({ ...g, id: ex?.id, vendor_id: vendorId }, t);
      if (ex) replaced++;
      else created++;
    }
  });
  return { created, replaced, lines: [...groups.values()].reduce((s, g) => s + g.lines.length, 0), errors };
}
