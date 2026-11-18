// Documents stage of a job: checklist, documents from the customer, shipping instructions to the agent,
// draft BL / AWB checked against the SI, customer approval, final copy.
import { q, one } from '../db.js';
import { mailRequester, mailBookingAgent, filesForMail } from './requesterMail.js';
import { documentRequestEmail, siEmail, blToCustomerEmail, blDecisionEmail, fmtDT } from './templates.js';
import { checklist, missingFromCustomer, compareToSi, correctionsText, docName, DOC_TYPES } from '../engines/documents.js';
import { attachmentBlocks } from './extract.js';
import { readShippingInstruction, readBillOfLading, readCustomerJobEmail } from './ai.js';
import { getSetting, getAiKey } from './settings.js';
import { createPdf, letterhead, kvRows, boxes, table, finish } from '../lib/pdf.js';
import { audit } from './audit.js';
import { trackUrlFor } from './tracking.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const partyLines = (p) => (p && typeof p === 'object' ? [p.name, p.address, [p.contact, p.phone, p.email].filter(Boolean).join(' / '), p.tax_id && `Tax ID: ${p.tax_id}`].filter(Boolean).join('\n') : p || '');
const blLabel = (rfq) => (rfq?.mode === 'AIR' ? 'AWB' : 'BL');

/** Keep an email's attachments with the job (once per email and file name). Returns the job file ids. */
export async function fileAttachments(jobId, emailId, atts, kind) {
  const ids = [];
  for (const a of atts) {
    const ex = await one('SELECT id FROM job_files WHERE job_id=$1 AND email_id=$2 AND filename=$3', [jobId, emailId, a.filename]);
    if (ex) { ids.push(ex.id); continue; }
    const f = await one('INSERT INTO job_files(job_id,kind,filename,content_type,size,data,email_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [jobId, typeof kind === 'function' ? kind(a) : kind, a.filename, a.content_type, a.data?.length || 0, a.data, emailId]);
    ids.push(f.id);
  }
  return ids;
}

async function ctx(jobId) {
  const job = await one('SELECT * FROM jobs WHERE id=$1', [jobId]);
  if (!job) throw err('Job not found', 404);
  const rfq = job.rfq_id ? await one('SELECT * FROM rfqs WHERE id=$1', [job.rfq_id]) : null;
  return { job, rfq };
}

/** Everything the documents tab needs. */
export async function documentsState(job, rfq, files) {
  const company = await getSetting('company');
  const si = await one('SELECT * FROM shipping_instructions WHERE job_id=$1', [job.id]);
  const bls = await q('SELECT b.*, a.company AS agent FROM bl_drafts b LEFT JOIN bookings k ON k.id=b.booking_id LEFT JOIN agents a ON a.id=k.agent_id WHERE b.job_id=$1 ORDER BY b.id DESC', [job.id]);
  const rows = checklist({ rfq, country: company.country, files, waived: job.doc_waived || [], extra: job.doc_extra || [], si, bls });
  for (const b of bls) b.suggested_corrections = suggestedCorrections(b);
  return { checklist: rows, missing_from_customer: missingFromCustomer(rows), si, bls, doc_types: DOC_TYPES.map((d) => ({ code: d.code, name: docName(d.code, rfq?.mode), from: d.from })) };
}

export async function setDocRequirement(jobId, { code, waived, extra }) {
  if (!DOC_TYPES.some((d) => d.code === code)) throw err('Unknown document type');
  if (waived !== undefined) await q(`UPDATE jobs SET doc_waived = ${waived ? 'array_append(array_remove(doc_waived,$1),$1)' : 'array_remove(doc_waived,$1)'} WHERE id=$2`, [code, jobId]);
  if (extra !== undefined) await q(`UPDATE jobs SET doc_extra = ${extra ? 'array_append(array_remove(doc_extra,$1),$1)' : 'array_remove(doc_extra,$1)'} WHERE id=$2`, [code, jobId]);
}

/** Ask the customer for the documents still missing (in their enquiry thread). */
export async function requestDocuments(jobId, { codes, note, to } = {}) {
  const { job, rfq } = await ctx(jobId);
  if (!codes?.length) throw err('Choose at least one document');
  const si = await one("SELECT b.cutoffs FROM bookings b WHERE b.job_id=$1 AND b.cutoffs ? 'si' ORDER BY b.cutoffs->>'si' LIMIT 1", [jobId]);
  const docs = codes.map((c) => docName(c, rfq?.mode));
  await mailRequester(job.rfq_id, (c) => documentRequestEmail({ ...c, job, docs, note, cutoff: si ? fmtDT(si.cutoffs.si) : null }), { to, kind: 'document_request', refSuffix: job.ref, jobId });
  await q('UPDATE jobs SET docs_requested_at=now() WHERE id=$1', [jobId]);
}

// ---------------- shipping instructions ----------------

const FREIGHT_COLLECT = ['EXW', 'FCA', 'FAS', 'FOB'];

/** SI pre-filled from the job, its RFQ and the main-freight booking. */
async function defaultSi(job, rfq) {
  const freight = await one("SELECT * FROM bookings WHERE job_id=$1 AND 'freight' = ANY(legs) AND status<>'cancelled' ORDER BY id LIMIT 1", [job.id]);
  return {
    booking_id: freight?.id || null,
    data: {
      shipper: job.shipper || {}, consignee: job.consignee || {}, notify_party: job.notify_party || {},
      place_of_receipt: rfq?.pickup_place || null, pol: freight?.pol || rfq?.pol || null, pod: freight?.pod || rfq?.pod || null, place_of_delivery: rfq?.delivery_place || null,
      vessel: freight?.vessel || null, voyage: freight?.voyage || null, flight_no: freight?.flight_no || null, booking_no: freight?.booking_no || null,
      description: rfq?.commodity || null, hs_code: rfq?.hs_code || null,
      packages: rfq?.packages || null, gross_weight_kg: rfq?.gross_weight_kg || null, volume_cbm: rfq?.volume_cbm || null,
      containers: (freight?.container_nos || []).map((n) => ({ number: n })),
      freight_terms: rfq?.incoterm ? (FREIGHT_COLLECT.includes(rfq.incoterm) ? 'collect' : 'prepaid') : null,
      bl_type: rfq?.mode === 'AIR' ? null : 'original', originals: rfq?.mode === 'AIR' ? null : 3,
    },
  };
}

export async function getSi(jobId) {
  const { job, rfq } = await ctx(jobId);
  const si = await one('SELECT * FROM shipping_instructions WHERE job_id=$1', [jobId]);
  return si || { job_id: jobId, status: 'new', ...(await defaultSi(job, rfq)) };
}

export async function saveSi(jobId, { data, booking_id }, source = 'manual') {
  const ex = await one('SELECT * FROM shipping_instructions WHERE job_id=$1', [jobId]);
  if (ex) {
    await q("UPDATE shipping_instructions SET data=$1, booking_id=coalesce($2,booking_id), source=$3, status=CASE WHEN status='draft' THEN 'draft' ELSE 'amended' END, updated_at=now() WHERE job_id=$4", [JSON.stringify(data || {}), booking_id || null, source, jobId]);
  } else {
    await q('INSERT INTO shipping_instructions(job_id,booking_id,data,source) VALUES($1,$2,$3,$4)', [jobId, booking_id || null, JSON.stringify(data || {}), source]);
  }
  return getSi(jobId);
}

/** AI reads the invoice, packing list and any SI from the customer, and fills in what it finds. */
export async function prefillSi(jobId) {
  const { job, rfq } = await ctx(jobId);
  if (!(await getAiKey())) throw err('Turn on AI reading in Settings first');
  const files = await q("SELECT filename, content_type, data FROM job_files WHERE job_id=$1 AND kind IN ('invoice','packing_list','si','other') ORDER BY kind='si' DESC, id", [jobId]);
  if (!files.length) throw err('Upload the invoice and packing list first (Documents)');
  const blocks = files.slice(0, 6).flatMap(attachmentBlocks);
  const found = await readShippingInstruction({ job, rfq, blocks });
  const cur = await getSi(jobId);
  const keepParty = (a, b) => (b && Object.values(b).some(Boolean) ? { ...a, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v)) } : a);
  const data = { ...cur.data };
  for (const [k, v] of Object.entries(found)) {
    if (k === 'confidence') continue;
    if (['shipper', 'consignee', 'notify_party'].includes(k)) data[k] = keepParty(cur.data[k] || {}, v);
    else if (k === 'containers') data.containers = mergeContainers(cur.data.containers, v);
    else data[k] = v;
  }
  return saveSi(jobId, { data, booking_id: cur.booking_id }, 'ai');
}

function mergeContainers(a = [], b = []) {
  const key = (c) => String(c?.number || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const map = new Map(a.filter((c) => key(c)).map((c) => [key(c), c]));
  for (const c of b) map.set(key(c) || `x${map.size}`, { ...(map.get(key(c)) || {}), ...c });
  return [...map.values()];
}

export async function renderSiPdf(jobId) {
  const { job, rfq } = await ctx(jobId);
  const si = await getSi(jobId);
  const d = si.data || {};
  const company = await getSetting('company');
  const air = rfq?.mode === 'AIR';
  const pdf = createPdf({ title: `Shipping instructions ${job.ref}` });
  const { doc } = pdf;
  letterhead(doc, company, pdf, air ? "Shipper's letter of instruction" : 'Shipping instructions', job.ref);
  kvRows(doc, [['Booking no.', d.booking_no], ['Date', new Date().toDateString()]], pdf);
  doc.moveDown(0.5);
  boxes(doc, [{ title: 'Shipper', text: partyLines(d.shipper) }, { title: 'Consignee', text: partyLines(d.consignee) }, { title: 'Notify party', text: partyLines(d.notify_party) || 'Same as consignee' }], pdf);
  boxes(doc, [
    { title: 'Place of receipt', text: d.place_of_receipt }, { title: air ? 'Airport of departure' : 'Port of loading', text: d.pol },
    { title: air ? 'Airport of destination' : 'Port of discharge', text: d.pod }, { title: 'Place of delivery', text: d.place_of_delivery },
  ], pdf);
  boxes(doc, [
    { title: air ? 'Flight' : 'Vessel / voyage', text: air ? d.flight_no : [d.vessel, d.voyage].filter(Boolean).join(' / ') },
    { title: 'Freight', text: d.freight_terms ? `${d.freight_terms[0].toUpperCase()}${d.freight_terms.slice(1)}` : '' },
    { title: air ? 'AWB' : 'BL type / originals', text: air ? '' : [d.bl_type, d.originals && `${d.originals} originals`].filter(Boolean).join(', ') },
    { title: 'HS code', text: d.hs_code },
  ], pdf);
  boxes(doc, [{ title: 'Marks and numbers', text: d.marks || 'N/M' }, { title: 'Description of goods', text: d.description }], pdf);
  boxes(doc, [
    { title: 'Packages', text: [d.packages, d.package_type].filter(Boolean).join(' ') },
    { title: 'Gross weight (kg)', text: d.gross_weight_kg != null ? String(d.gross_weight_kg) : '' },
    { title: 'Net weight (kg)', text: d.net_weight_kg != null ? String(d.net_weight_kg) : '' },
    { title: 'Volume (cbm)', text: d.volume_cbm != null ? String(d.volume_cbm) : '' },
  ], pdf);
  if (d.containers?.length) {
    doc.font(pdf.BOLD).fontSize(10).fillColor('#0b2a4a').text('Containers', 40, doc.y);
    doc.moveDown(0.3);
    table(doc, [{ label: 'Container', width: 120 }, { label: 'Seal', width: 100 }, { label: 'Type', width: 70 }, { label: 'Packages', width: 75, align: 'right' }, { label: 'Gross kg', width: 75, align: 'right' }, { label: 'CBM', width: 75, align: 'right' }],
      d.containers.map((c) => [c.number, c.seal, c.type, c.packages, c.gross_weight_kg, c.volume_cbm]), pdf);
  }
  kvRows(doc, [['Invoice', [d.invoice_no, d.invoice_value].filter(Boolean).join(' / ')], ['Remarks', d.remarks]], pdf);
  doc.moveDown(0.6).font(pdf.REG).fontSize(8.5).fillColor('#444').text(`Please send the draft ${air ? 'AWB' : 'BL'} for approval before finalising.`, 40);
  return finish(pdf);
}

/** Email the SI (as PDF) to the agent handling the main freight, in their booking thread. */
export async function sendSi(jobId, { booking_id, note, to, fileIds = [] } = {}) {
  const si = await getSi(jobId);
  const bookingId = booking_id || si.booking_id;
  if (!bookingId) throw err('Choose the agent booking to send the SI to');
  if (si.status === 'new') await saveSi(jobId, { data: si.data, booking_id: bookingId });
  const { job } = await ctx(jobId);
  const pdfBuf = await renderSiPdf(jobId);
  const amended = (si.sent_count || 0) > 0;
  const attachments = [{ filename: `SI-${job.ref}${amended ? `-v${si.sent_count + 1}` : ''}.pdf`, contentType: 'application/pdf', content: pdfBuf }, ...(await filesForMail(jobId, fileIds))];
  await mailBookingAgent(bookingId, (c) => siEmail({ ...c, note, amended }), { to, attachments, kind: 'shipping_instructions' });
  await q("UPDATE shipping_instructions SET status='sent', sent_at=now(), sent_count=sent_count+1, booking_id=$1 WHERE job_id=$2", [bookingId, jobId]);
}

// ---------------- draft / final BL - AWB ----------------

/** A BL / AWB arrived from the agent (by email or uploaded): read it and check it against the SI. */
export async function recordAgentBl({ job, booking, email, fileIds, isFinal }) {
  const versionRow = await one('SELECT count(*)::int AS n FROM bl_drafts WHERE job_id=$1 AND booking_id IS NOT DISTINCT FROM $2', [job.id, booking?.id || null]);
  const bl = await one(
    "INSERT INTO bl_drafts(job_id,booking_id,is_final,version,file_id,email_id,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [job.id, booking?.id || null, !!isFinal, versionRow.n + 1, fileIds?.[0] || null, email?.id || null, isFinal ? 'final' : 'received']
  );
  // the previous draft is replaced by this one
  await q("UPDATE bl_drafts SET status='superseded' WHERE job_id=$1 AND booking_id IS NOT DISTINCT FROM $2 AND id<>$3 AND status NOT IN ('final','superseded')", [job.id, booking?.id || null, bl.id]);
  if (await getAiKey()) await readBl(bl.id).catch((e) => q('UPDATE bl_drafts SET extracted=$1 WHERE id=$2', [JSON.stringify({ error: e.message }), bl.id]));
  await audit(null, isFinal ? 'Final BL / AWB received' : 'Draft BL / AWB received', { entity: 'bl', entityId: bl.id, rfqId: job.rfq_id, jobId: job.id, summary: `${job.ref} v${bl.version}` });
  return bl;
}

/** (Re)read a BL / AWB file with AI and compare with the SI. */
export async function readBl(blId) {
  const bl = await one('SELECT * FROM bl_drafts WHERE id=$1', [blId]);
  const job = await one('SELECT * FROM jobs WHERE id=$1', [bl.job_id]);
  const files = bl.file_id ? await q('SELECT filename, content_type, data FROM job_files WHERE id=$1', [bl.file_id]) : [];
  const email = bl.email_id ? await one('SELECT body_text FROM emails WHERE id=$1', [bl.email_id]) : null;
  const blocks = files.flatMap(attachmentBlocks);
  if (!blocks.length && email?.body_text) blocks.push({ type: 'text', text: email.body_text.slice(0, 20000) });
  if (!blocks.length) throw err('Nothing to read: no file attached');
  const extracted = await readBillOfLading({ job, blocks });
  const si = await one('SELECT data FROM shipping_instructions WHERE job_id=$1', [job.id]);
  const discrepancies = si ? compareToSi(si.data, extracted) : [];
  await q('UPDATE bl_drafts SET extracted=$1, discrepancies=$2, confidence=$3 WHERE id=$4', [JSON.stringify(extracted), JSON.stringify(discrepancies), extracted.confidence ?? null, blId]);
  if (bl.is_final && extracted.bl_no) await q('UPDATE jobs SET bl_no=$1 WHERE id=$2', [extracted.bl_no, job.id]);
  return { extracted, discrepancies };
}

/** A BL / AWB uploaded by a person (e.g. received on WhatsApp or a portal). */
export async function uploadBl(jobId, file, { booking_id, is_final }, user) {
  const { job } = await ctx(jobId);
  const f = await one('INSERT INTO job_files(job_id,kind,filename,content_type,size,data,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [jobId, is_final ? 'bl' : 'draft_bl', file.originalname, file.mimetype, file.size, file.buffer, user?.id || null]);
  const booking = booking_id ? await one('SELECT * FROM bookings WHERE id=$1 AND job_id=$2', [booking_id, jobId]) : null;
  return recordAgentBl({ job, booking, email: null, fileIds: [f.id], isFinal: is_final === true || is_final === 'true' });
}

/** Send the draft (for approval) or the final copy to the customer, in their thread. */
export async function sendBlToCustomer(blId, { note, to } = {}) {
  const bl = await one('SELECT * FROM bl_drafts WHERE id=$1', [blId]);
  const { job, rfq } = await ctx(bl.job_id);
  const attachments = await filesForMail(job.id, bl.file_id ? [bl.file_id] : []);
  if (!attachments.length) throw err('This draft has no file to send');
  const trackUrl = bl.is_final && job.track_enabled ? await trackUrlFor(job.id) : null;
  const email = await mailRequester(job.rfq_id, (c) => blToCustomerEmail({ ...c, job, draft: !bl.is_final, note, docLabel: blLabel(rfq), trackUrl }), { to, attachments, kind: bl.is_final ? 'final_bl' : 'draft_bl_approval', refSuffix: job.ref, jobId: job.id });
  await q("UPDATE bl_drafts SET status=CASE WHEN is_final THEN status ELSE 'with_customer' END, sent_to_customer_at=now(), customer_email_id=$1 WHERE id=$2", [email.email.id, blId]);
}

/** Record the customer's answer (when they replied by phone, or to correct the AI). */
export async function customerDecision(blId, { approved, corrections }) {
  await q('UPDATE bl_drafts SET status=$1, customer_note=$2 WHERE id=$3', [approved ? 'customer_approved' : 'customer_corrections', approved ? null : corrections || null, blId]);
}

/** Tell the agent: approved, or the corrections (ours from the SI check plus the customer's). */
export async function replyAgentOnBl(blId, { approve, corrections, note, to } = {}) {
  const bl = await one('SELECT * FROM bl_drafts WHERE id=$1', [blId]);
  if (!bl.booking_id) throw err('This draft is not linked to an agent booking');
  if (!approve && !String(corrections || '').trim()) throw err('List the corrections');
  const { rfq } = await ctx(bl.job_id);
  const src = bl.email_id ? await one('SELECT message_id FROM emails WHERE id=$1', [bl.email_id]) : null;
  await mailBookingAgent(bl.booking_id, (c) => blDecisionEmail({ ...c, approve, corrections, note, docLabel: blLabel(rfq) }), { to, inReplyTo: src?.message_id, kind: approve ? 'draft_bl_approved' : 'draft_bl_corrections' });
  await q('UPDATE bl_drafts SET status=$1, agent_reply_at=now() WHERE id=$2', [approve ? 'approved' : 'corrections_sent', blId]);
}

/** Suggested corrections text for a draft: SI differences plus the customer's own corrections. */
export function suggestedCorrections(bl) {
  return [correctionsText(bl.discrepancies), bl.customer_note].filter(Boolean).join('\n');
}

// ---------------- customer emails about a job ----------------

const JOB_REF = /\b(JOB-\d{4}-\d{3,})\b/;

/** Customer replies in the job thread (or with the job reference in the subject). */
export async function matchJobCustomer({ subject, inReplyTo, references }) {
  const ids = [inReplyTo, ...(Array.isArray(references) ? references : references ? [references] : [])].filter(Boolean);
  if (ids.length) {
    const e = await one('SELECT job_id FROM emails WHERE job_id IS NOT NULL AND booking_id IS NULL AND message_id = ANY($1) ORDER BY id DESC LIMIT 1', [ids]);
    if (e) return one('SELECT * FROM jobs WHERE id=$1', [e.job_id]);
  }
  const m = JOB_REF.exec(subject || '');
  if (m) return one('SELECT * FROM jobs WHERE ref=$1', [m[1]]);
  return null;
}

export async function onCustomerJobEmail(email) {
  const job = await one('SELECT * FROM jobs WHERE id=$1', [email.job_id]);
  const atts = await q('SELECT id, filename, content_type, data FROM attachments WHERE email_id=$1', [email.id]);
  const ai = await getSetting('ai');
  let r = null;
  if (ai.auto_parse && (await getAiKey())) {
    try {
      r = await readCustomerJobEmail({ job, email, attachments: atts, blocks: atts.slice(0, 6).flatMap(attachmentBlocks) });
    } catch (e) {
      await q("UPDATE emails SET parse_status='error', parse_error=$1 WHERE id=$2", [e.message.slice(0, 500), email.id]);
    }
  }
  const typeOf = (a) => r?.attachments?.find((x) => x.filename === a.filename)?.doc_type || 'other';
  await fileAttachments(job.id, email.id, atts, typeOf);
  if (!r) {
    await q("UPDATE emails SET parse_status=CASE WHEN parse_status='error' THEN parse_status ELSE 'review' END WHERE id=$1", [email.id]);
    return null;
  }
  if (['bl_approved', 'bl_corrections'].includes(r.intent)) {
    const bl = await one("SELECT * FROM bl_drafts WHERE job_id=$1 AND status='with_customer' ORDER BY id DESC LIMIT 1", [job.id]);
    if (bl) await customerDecision(bl.id, { approved: r.intent === 'bl_approved', corrections: r.corrections });
  }
  await q('UPDATE emails SET parse_status=$1, parse_error=$2 WHERE id=$3', [r.confidence >= 0.7 ? 'parsed' : 'review', r.summary?.slice(0, 500) || null, email.id]);
  const what = { documents: 'Customer sent documents', bl_approved: 'Customer approved the draft', bl_corrections: 'Customer asked for corrections to the draft', question: 'Customer question', other: 'Customer email' }[r.intent] || 'Customer email';
  await audit(null, what, { entity: 'job', entityId: job.id, rfqId: job.rfq_id, jobId: job.id, summary: [job.ref, r.summary].filter(Boolean).join(' · ').slice(0, 300) });
  return r;
}

/** Change a document's type (when the AI or the uploader got it wrong). */
export async function setFileKind(fileId, kind) {
  if (!DOC_TYPES.some((d) => d.code === kind)) throw err('Unknown document type');
  const f = await one('UPDATE job_files SET kind=$1 WHERE id=$2 RETURNING job_id', [kind, fileId]);
  if (!f) throw err('Not found', 404);
  return f.job_id;
}
