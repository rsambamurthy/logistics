// Import past business from Excel so the agent's skills (agent ranking, reply forecast, estimates,
// margin advice, delay prediction, space planning, payment risk) learn from day one.
// Parsing and checks: engines/historyImport.js. Each import is a batch that can be undone.
import * as XLSX from 'xlsx';
import { q, one, tx } from '../db.js';
import { allSheetRows, normaliseRows } from '../lib/sheets.js';
import { randomTag } from '../lib/crypto.js';
import { clearLearning } from '../lib/learningCache.js';
import { parseHistory, SHEETS, COLUMNS, LOST_REASONS } from '../engines/historyImport.js';
import { quoteTotals } from '../engines/costing.js';
import { LEG_CODES, BASIS_CODES } from '../engines/charges.js';
import { getFx } from './settings.js';
import { audit } from './audit.js';

const PREFIX = 'H-'; // imported refs never clash with Quayly's own RFQ-/JOB- numbering
const err = (m, status = 400) => Object.assign(new Error(m), { status });
const r2 = (n) => Math.round(Number(n) * 100) / 100;

// ---------------------------------------------------------------- template
export function historyTemplate() {
  const wb = XLSX.utils.book_new();
  const add = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  add(SHEETS.enquiries, [COLUMNS.enquiries,
    ['ENQ-1041', '2026-05-04', 'Acme Exports', 'buyer@acme.in', 'FCL', 'Chennai', 'Hong Kong', 'Sriperumbudur', '', 'pickup, export_customs, freight', 'FOB', 'Auto parts', '', '', 18000, '', '1x40HC', 185000, 'INR', 'won', '', ''],
    ['ENQ-1042', '2026-05-06', 'Bright Garments', 'ops@bright.in', 'AIR', 'Chennai', 'Hong Kong', '', '', 'freight', '', 'Garments', 40, 'Carton', 620, 3.1, '', 1450, 'USD', 'lost', 'Price too high', 1380],
    ['ENQ-1043', '2026-05-09', 'Acme Exports', 'buyer@acme.in', 'LCL', 'Chennai', 'Singapore', '', '', 'freight', '', 'Spares', 12, 'Pallet', 2400, 6.5, '', 520, 'USD', 'no answer', '', ''],
  ]);
  add(SHEETS.quotes, [COLUMNS.quotes,
    ['ENQ-1041', 'Alpha Logistics', 'rates@alpha.com', '2026-05-04', '2026-05-04', '', 'yes', 'freight', 'OFR', 'Ocean freight', 'per_container', 1350, 'USD', '', 9, 'ONE', '2026-05-31'],
    ['ENQ-1041', 'Alpha Logistics', 'rates@alpha.com', '2026-05-04', '2026-05-04', '', 'yes', 'freight', 'THC', 'Origin THC', 'per_container', 11000, 'INR', '', '', '', ''],
    ['ENQ-1041', 'Chennai Movers', 'quote@movers.in', '2026-05-04', '2026-05-05', '', 'yes', 'pickup', 'TRUCK', '40ft trailer', 'per_trip', 16000, 'INR', '', '', '', ''],
    ['ENQ-1041', 'Chennai Movers', 'quote@movers.in', '2026-05-04', '2026-05-05', '', 'yes', 'export_customs', 'CHA', 'Customs clearance', 'per_declaration', 3500, 'INR', '', '', '', ''],
    ['ENQ-1041', 'Bravo Freight', 'sales@bravo.hk', '2026-05-04', '', '', '', 'freight', '', '', '', '', '', '', '', '', ''],
    ['ENQ-1042', 'Alpha Logistics', 'rates@alpha.com', '2026-05-06', '2026-05-07', '', '', 'freight', 'AFR', 'Air freight', 'per_kg', 1.95, 'USD', '', 2, 'CX', ''],
    ['ENQ-1042', 'Bravo Freight', 'sales@bravo.hk', '2026-05-06', '2026-05-08', 'yes', '', 'freight', '', '', '', '', '', '', '', '', ''],
    ['ENQ-1043', 'Charlie Logistics', 'lcl@charlie.sg', '2026-05-09', '2026-05-10', '', '', 'freight', 'OFR', 'LCL freight', 'per_cbm', 48, 'USD', '', 7, '', ''],
  ]);
  add(SHEETS.jobs, [COLUMNS.jobs,
    ['ENQ-1041', 'JOB-0451', 'ONE', '2026-05-15', '2026-05-24', '2026-05-16', '2026-05-27', 'INV-2231', '2026-05-16', 185000, 'INR', '2026-06-15', '2026-06-20'],
  ]);
  add('Help', [
    ['How to fill this workbook'],
    ['Enquiries: one row per past enquiry. ref must be unique. Required: ref, date, mode (FCL / LCL / AIR), origin, destination; containers for FCL (e.g. 2x40HC, 1x20GP); weight or volume for LCL and air.'],
    ['legs: comma-separated, default freight. Codes: ' + LEG_CODES.join(', ')],
    ['quoted_price / quoted_currency: what you quoted the customer in total. outcome: won, lost, no answer, or not quoted. With a price, won and lost teach the margin advice.'],
    ['lost_reason: ' + LOST_REASONS.join(', ') + '. competitor_price: the price you lost to, if known.'],
    [],
    ['Agent quotes: one row per charge. Rows with the same enquiry_ref and agent form one quote.'],
    ['An agent you asked who never replied: one row with the agent and asked_on, and no rate. An agent who said no: declined = yes.'],
    ['used = yes for the agent(s) you booked with. asked_on / replied_on teach the reply forecast (blank asked_on = the enquiry date).'],
    ['basis: ' + BASIS_CODES.join(', ') + '. Blank basis on freight = per container (FCL), per kg (air) or per cbm (LCL). qty: only when the charge is not per the whole shipment.'],
    [],
    ['Jobs: one row per enquiry that became a shipment. eta_booked vs arrived_on teaches delay prediction; invoice and paid_on teach customer payment risk.'],
    ['Dates: YYYY-MM-DD or DD/MM/YYYY. Importing the same ref again replaces what the earlier import created for it.'],
  ]);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---------------------------------------------------------------- reading
async function readWorkbook(buffer) {
  const all = await allSheetRows(buffer);
  const pick = (name) => {
    const key = Object.keys(all).find((k) => k.trim().toLowerCase() === name.toLowerCase());
    return key ? normaliseRows(all[key]) : null;
  };
  const sheets = { enquiries: pick(SHEETS.enquiries), quotes: pick(SHEETS.quotes) || [], jobs: pick(SHEETS.jobs) || [] };
  if (!sheets.enquiries) throw err(`The workbook needs a sheet named "${SHEETS.enquiries}". Download the template to see the layout.`);
  return sheets;
}

/** Which refs are already in Quayly: from an earlier import (will be replaced) or live records (skipped). */
async function existing(enquiries) {
  const refs = enquiries.map((e) => PREFIX + e.ref);
  const jobRefs = enquiries.filter((e) => e.job?.ref).map((e) => PREFIX + e.job.ref);
  const rfqs = refs.length ? await q('SELECT ref, import_batch_id FROM rfqs WHERE ref = ANY($1)', [refs]) : [];
  const jobs = jobRefs.length ? await q('SELECT ref, import_batch_id FROM jobs WHERE ref = ANY($1)', [jobRefs]) : [];
  return { rfqs: new Map(rfqs.map((r) => [r.ref, r.import_batch_id])), jobs: new Map(jobs.map((r) => [r.ref, r.import_batch_id])) };
}

async function check(buffer) {
  const parsed = parseHistory(await readWorkbook(buffer));
  const ex = await existing(parsed.enquiries);
  const replace = [];
  const keep = [];
  for (const e of parsed.enquiries) {
    const rb = ex.rfqs.get(PREFIX + e.ref);
    const jb = e.job?.ref ? ex.jobs.get(PREFIX + e.job.ref) : undefined;
    if (rb === null || jb === null) { parsed.errors.push({ sheet: SHEETS.enquiries, row: e.row, message: `${PREFIX}${e.ref} already exists and was not imported; rename the ref` }); continue; }
    if (rb !== undefined) replace.push(e.ref);
    keep.push(e);
  }
  parsed.enquiries = keep;
  parsed.counts.enquiries = keep.length;
  parsed.replace = replace;
  return parsed;
}

/** Dry run: what would be imported, and the rows with problems. */
export async function previewHistory(buffer) {
  const p = await check(buffer);
  const span = p.enquiries.map((e) => e.date).sort();
  return {
    counts: p.counts, errors: p.errors.slice(0, 200), error_count: p.errors.length, warnings: p.warnings.slice(0, 50), replace: p.replace,
    from: span[0] || null, to: span[span.length - 1] || null,
    customers: new Set(p.enquiries.map((e) => e.customer?.email || e.customer?.name).filter(Boolean)).size,
    agents: new Set(p.enquiries.flatMap((e) => e.agents.map((a) => a.email || a.name.toLowerCase()))).size,
    sample: p.enquiries.slice(0, 5).map((e) => ({ ref: e.ref, date: e.date, customer: e.customer?.name || null, lane: `${e.rfq.pol} → ${e.rfq.pod}`, mode: e.rfq.mode, agents: e.agents.length, quotes: e.agents.filter((a) => a.lines.length).length, outcome: e.outcome, job: !!e.job })),
  };
}

// ---------------------------------------------------------------- import
/** Find a contact by email, else by company name; create it if new. */
async function party(t, { name, email }, kind, cache, batchId) {
  const key = `${kind}:${email || name.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  let row = email ? await t.one('SELECT id, is_agent, is_customer FROM agents WHERE lower(email)=$1 ORDER BY id LIMIT 1', [email]) : null;
  row ||= await t.one('SELECT id, is_agent, is_customer FROM agents WHERE lower(company)=$1 ORDER BY id LIMIT 1', [name.toLowerCase()]);
  if (row && kind === 'agent' && !row.is_agent) await t.q('UPDATE agents SET is_agent=true WHERE id=$1', [row.id]);
  if (row && kind === 'customer' && !row.is_customer) await t.q('UPDATE agents SET is_customer=true WHERE id=$1', [row.id]);
  if (!row) {
    row = await t.one("INSERT INTO agents(company, email, is_agent, is_customer, source, import_batch_id) VALUES($1,$2,$3,$4,'import',$5) RETURNING id", [name, email, kind === 'agent', kind === 'customer', batchId]);
  }
  cache.set(key, row.id);
  return row.id;
}

/** Remove what earlier imports created for these refs (re-importing a ref replaces it). */
async function removeImported(t, rfqRefs, jobRefs) {
  if (jobRefs.length) await t.q('DELETE FROM jobs WHERE ref = ANY($1) AND import_batch_id IS NOT NULL', [jobRefs]);
  if (!rfqRefs.length) return;
  await t.q('DELETE FROM jobs WHERE import_batch_id IS NOT NULL AND rfq_id IN (SELECT id FROM rfqs WHERE ref = ANY($1) AND import_batch_id IS NOT NULL)', [rfqRefs]);
  await t.q('DELETE FROM rfqs WHERE ref = ANY($1) AND import_batch_id IS NOT NULL', [rfqRefs]);
}

async function importEnquiry(t, e, ctx) {
  const { batchId, fx, cache } = ctx;
  const at = `${e.date}T09:00:00Z`;
  const customerId = e.customer ? await party(t, e.customer, 'customer', cache, batchId) : null;
  const status = { accepted: 'awarded', lost: 'lost', expired: 'expired' }[e.outcome] || 'closed';
  const r = e.rfq;
  const rfq = await t.one(
    `INSERT INTO rfqs(ref, mode, pol, pod, pickup_place, delivery_place, incoterm, commodity, containers, packages, package_type, gross_weight_kg, volume_cbm, ready_date, legs, status, requester_id, created_at, import_batch_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [PREFIX + e.ref, r.mode, r.pol, r.pod, r.pickup_place, r.delivery_place, r.incoterm, r.commodity, JSON.stringify(r.containers), r.packages, r.package_type, r.gross_weight_kg, r.volume_cbm, e.date, r.legs, status, customerId, at, batchId]
  );
  const used = [];
  const quoted = [];
  for (const a of e.agents) {
    const agentId = await party(t, a, 'agent', cache, batchId);
    const replied = a.replied_on ? `${a.replied_on}T${a.replied_on === a.asked_on ? '15' : '11'}:00:00Z` : null;
    const invStatus = a.used ? 'awarded' : a.declined ? 'declined' : replied ? 'replied' : 'closed';
    const inv = await t.one(
      "INSERT INTO rfq_invites(rfq_id, agent_id, tag, legs, status, sent_at, replied_at, awarded, source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'email') ON CONFLICT (rfq_id, agent_id) DO NOTHING RETURNING id",
      [rfq.id, agentId, randomTag(), a.legs, invStatus, `${a.asked_on}T09:00:00Z`, replied, a.used]
    );
    if (!inv || !(a.lines.length || a.declined)) continue;
    const aq = await t.one(
      "INSERT INTO agent_quotes(rfq_id, invite_id, valid_until, transit_days, carrier, declined, verified, source, created_at) VALUES($1,$2,$3,$4,$5,$6,true,'import',$7) RETURNING id",
      [rfq.id, inv.id, a.valid_until, a.transit_days, a.carrier, a.declined && !a.lines.length, replied || at]
    );
    for (const l of a.lines) {
      await t.q('INSERT INTO quote_lines(agent_quote_id, leg, charge_code, description, basis, rate, currency, qty, sort) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [aq.id, l.leg, l.charge_code, l.description, l.basis, l.rate, l.currency, l.qty, l.sort]);
    }
    if (a.lines.length) (a.used ? used : quoted).push({ id: aq.id, lines: a.lines });
  }

  // the customer quote: teaches margin advice (won / lost at what margin)
  let cqId = null;
  if (e.sell && e.outcome) {
    const cur = e.currency || fx.base;
    const legsOf = (x) => { try { return quoteTotals({ lines: x.lines }, rfq, fx, cur).legs; } catch { return {}; } };
    const best = {};
    for (const x of used.length ? used : quoted) for (const [leg, v] of Object.entries(legsOf(x))) if (v.total > 0 && (!best[leg] || v.total < best[leg].total)) best[leg] = { total: v.total, id: x.id };
    const buy = Object.values(best).reduce((s, v) => s + v.total, 0);
    const margin = buy > 0 ? r2(((e.sell - buy) / buy) * 100) : null;
    const snapshot = { imported: true, options: [{ totals: { buy: r2(buy), sell: e.sell, profit: r2(e.sell - buy), margin_pct_effective: margin } }] };
    const cq = await t.one(
      `INSERT INTO customer_quotes(rfq_id, ref, currency, selection, margin_pct, snapshot, status, created_at, sent_at, valid_until, decided_at, accepted_at, accepted_option, lost_reason, lost_note, competitor_price)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,0,$12,$13,$14) RETURNING id`,
      [rfq.id, `${PREFIX}${e.ref}-Q`, cur, JSON.stringify(Object.fromEntries(Object.entries(best).map(([l, v]) => [l, v.id]))), margin ?? 0, JSON.stringify(snapshot), e.outcome, at,
        new Date(new Date(e.date).getTime() + 7 * 864e5).toISOString().slice(0, 10), e.outcome === 'expired' ? null : at, e.outcome === 'accepted' ? at : null, e.lost_reason, e.lost_note, e.competitor_price]
    );
    cqId = cq.id;
  }

  if (e.job) {
    const j = e.job;
    const old = (d) => d && new Date(d) < new Date(Date.now() - 60 * 864e5);
    const jStatus = j.ata || old(j.eta) || old(j.etd) || old(e.date) ? 'completed' : j.atd ? 'departed' : 'booked';
    const job = await t.one(
      `INSERT INTO jobs(ref, rfq_id, customer_quote_id, requester_id, status, cargo_ready_date, sell_currency, atd, ata, first_eta, invoice_no, invoice_date, invoice_amount, invoice_currency, due_date, paid_at, created_at, closed_at, import_batch_id, track_enabled)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,false) RETURNING id`,
      [PREFIX + (j.ref || e.ref), rfq.id, cqId, customerId, jStatus, j.etd || e.date, e.currency || fx.base, j.atd, j.ata, j.eta, j.invoice_no, j.invoice_date, j.invoice_amount, j.invoice_currency, j.due_date, j.paid_at, at, jStatus === 'completed' ? (j.ata || j.eta || j.etd || e.date) : null, batchId]
    );
    const freightAgent = e.agents.find((a) => a.used && a.legs.includes('freight')) || e.agents.find((a) => a.used);
    const inv = freightAgent ? await t.one('SELECT i.id, i.agent_id FROM rfq_invites i JOIN agents a ON a.id=i.agent_id WHERE i.rfq_id=$1 AND (lower(a.email)=$2 OR lower(a.company)=$3) LIMIT 1', [rfq.id, freightAgent.email, freightAgent.name.toLowerCase()]) : null;
    if (j.carrier || j.etd || j.eta) {
      await t.q(
        "INSERT INTO bookings(job_id, invite_id, agent_id, tag, legs, status, carrier, pol, pod, etd, eta, verified, source, confirmed_at) VALUES($1,$2,$3,$4,$5,'confirmed',$6,$7,$8,$9,$10,true,'import',$11)",
        [job.id, inv?.id || null, inv?.agent_id || null, randomTag(), freightAgent?.legs?.length ? freightAgent.legs : ['freight'], j.carrier, r.pol, r.pod, j.etd, j.eta, at]
      );
    }
  }
}

export async function importHistory(buffer, user, filename) {
  const p = await check(buffer);
  if (!p.enquiries.length) throw err(p.errors.length ? `Nothing to import: ${p.errors.length} row(s) have problems. Check the preview.` : 'No enquiries found in the workbook.');
  const fx = await getFx();
  const batch = await tx(async (t) => {
    const b = await t.one('INSERT INTO import_batches(kind, filename, created_by) VALUES($1,$2,$3) RETURNING *', ['history', filename || null, user?.id || null]);
    await removeImported(t, p.enquiries.map((e) => PREFIX + e.ref), p.enquiries.filter((e) => e.job?.ref).map((e) => PREFIX + e.job.ref));
    const ctx = { batchId: b.id, fx, cache: new Map() };
    for (const e of p.enquiries) await importEnquiry(t, e, ctx);
    const counts = { ...p.counts, replaced: p.replace.length, skipped_rows: p.errors.length };
    await t.q('UPDATE import_batches SET counts=$1 WHERE id=$2', [JSON.stringify(counts), b.id]);
    return { ...b, counts };
  });
  clearLearning();
  await audit(user, 'history.imported', { entity: 'import', entityId: batch.id, summary: `Imported ${batch.counts.enquiries} past enquiries, ${batch.counts.agent_quotes} agent quotes, ${batch.counts.jobs} jobs${filename ? ` from ${filename}` : ''}` });
  return { id: batch.id, counts: batch.counts, errors: p.errors.slice(0, 200), warnings: p.warnings.slice(0, 50) };
}

export async function listImports() {
  return q(`SELECT b.*, u.name AS by_name, (SELECT count(*)::int FROM rfqs r WHERE r.import_batch_id=b.id) AS enquiries_now,
      (SELECT count(*)::int FROM jobs j WHERE j.import_batch_id=b.id) AS jobs_now
    FROM import_batches b LEFT JOIN users u ON u.id=b.created_by ORDER BY b.id DESC LIMIT 50`);
}

/** Undo an import: its enquiries, quotes and jobs go; business partners it created stay unless nothing else uses them. */
export async function undoImport(batchId, user) {
  const b = await one('SELECT * FROM import_batches WHERE id=$1', [batchId]);
  if (!b) throw err('Not found', 404);
  if (b.undone_at) throw err('This import was already undone.');
  await tx(async (t) => {
    await t.q('DELETE FROM jobs WHERE import_batch_id=$1', [batchId]);
    await t.q('DELETE FROM rfqs WHERE import_batch_id=$1', [batchId]);
    await t.q(`DELETE FROM agents a WHERE a.import_batch_id=$1
      AND NOT EXISTS (SELECT 1 FROM rfq_invites i WHERE i.agent_id=a.id) AND NOT EXISTS (SELECT 1 FROM rfqs r WHERE r.requester_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.requester_id=a.id) AND NOT EXISTS (SELECT 1 FROM rate_cards c WHERE c.vendor_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM bookings bk WHERE bk.agent_id=a.id)`, [batchId]);
    await t.q('UPDATE import_batches SET undone_at=now() WHERE id=$1', [batchId]);
  });
  clearLearning();
  await audit(user, 'history.import_undone', { entity: 'import', entityId: batchId, summary: `Undid history import #${batchId}` });
  return { ok: true };
}
