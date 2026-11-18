// Booking stage: a job is opened when a quotation is accepted; bookings go to the winning agents;
// their confirmations are read by AI; the customer gets the booking details; profit is tracked.
import { q, one, tx } from '../db.js';
import { randomTag } from '../lib/crypto.js';
import { getMailbox, sendMail } from './mail.js';
import { mailRequester } from './requesterMail.js';
import { bookingRequestEmail, customerBookingEmail, JOB_TAG_REGEX } from './templates.js';
import { jobPlanFromOption, jobProfit, deriveJobStatus, cutoffsDue, bookingChanges, MILESTONES, tzOffset } from '../engines/jobs.js';
import { attachmentBlocks } from './extract.js';
import { parseBookingReply as aiReadBooking } from './ai.js';
import { getFx, getSetting, getAiKey } from './settings.js';
import { audit } from './audit.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const JOB_FIELDS = ['shipper', 'consignee', 'notify_party', 'cargo_ready_date', 'customer_ref', 'notes', 'atd', 'ata'];
const BOOKING_FIELDS = ['carrier', 'booking_no', 'vessel', 'voyage', 'flight_no', 'mbl_awb', 'pol', 'pod', 'etd', 'eta', 'cutoffs', 'empty_pickup', 'container_nos', 'remarks'];
const blank = (v) => (v === '' || v === undefined ? null : v);

async function nextJobRef(t) {
  const year = new Date().getFullYear();
  const row = await t.one('SELECT count(*)::int AS n FROM jobs WHERE ref LIKE $1', [`JOB-${year}-%`]);
  return `JOB-${year}-${String(row.n + 1).padStart(4, '0')}`;
}

/** Open a job from an accepted quotation option. Returns the existing job if one was already opened. */
export async function createJobFromQuote(customerQuoteId, option, user) {
  const existing = await one('SELECT * FROM jobs WHERE customer_quote_id=$1', [customerQuoteId]);
  if (existing) return existing;
  const cq = await one('SELECT * FROM customer_quotes WHERE id=$1', [customerQuoteId]);
  if (!cq) throw err('Quotation not found', 404);
  const idx = Number(option ?? cq.accepted_option ?? 0);
  const opt = cq.snapshot?.options?.[idx] || cq.snapshot;
  const rfq = await one('SELECT * FROM rfqs WHERE id=$1', [opt?.rfq_id || cq.rfq_id]);
  const currency = cq.snapshot?.currency || cq.currency;
  const plan = jobPlanFromOption(opt, currency);
  const job = await tx(async (t) => {
    const j = await t.one(
      `INSERT INTO jobs(ref,rfq_id,customer_quote_id,option_index,requester_id,cargo_ready_date,customer_ref,sell_currency,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [await nextJobRef(t), rfq.id, cq.id, idx, rfq.requester_id, rfq.ready_date || null, rfq.requester_ref || null, currency, user?.id || null]
    );
    const agentOf = {};
    for (const b of plan.bookings) {
      const inv = await t.one("SELECT i.agent_id, a.source FROM rfq_invites i JOIN agents a ON a.id=i.agent_id WHERE i.id=$1", [b.invite_id]);
      agentOf[b.invite_id] = inv?.agent_id || null;
      await t.q('INSERT INTO bookings(job_id,invite_id,agent_id,tag,legs,source) VALUES($1,$2,$3,$4,$5,$6)', [j.id, b.invite_id, inv?.agent_id || null, randomTag(), b.legs, inv?.source === 'internal' ? 'own' : 'agent']);
    }
    for (const c of plan.costs) {
      await t.q("INSERT INTO job_costs(job_id,kind,leg,description,amount,currency,agent_id,source) VALUES($1,$2,$3,$4,$5,$6,$7,'quote')", [j.id, c.kind, c.leg, c.description, c.amount, c.currency, c.kind === 'buy' ? agentOf[c.invite_id] || null : null]);
    }
    return j;
  });
  await audit(user || null, 'Opened job', { entity: 'job', entityId: job.id, rfqId: rfq.id, summary: `${job.ref} from ${cq.ref}`, jobId: job.id });
  return job;
}

export async function listJobs({ status, search } = {}) {
  const where = [];
  const vals = [];
  if (status === 'active') where.push("j.status NOT IN ('completed','cancelled')");
  else if (status) { vals.push(status); where.push(`j.status=$${vals.length}`); }
  if (search) { vals.push(`%${search}%`); where.push(`(j.ref ILIKE $${vals.length} OR r.ref ILIKE $${vals.length} OR a.company ILIKE $${vals.length} OR r.pol ILIKE $${vals.length} OR r.pod ILIKE $${vals.length} OR j.customer_ref ILIKE $${vals.length})`); }
  const rows = await q(
    `SELECT j.*, r.ref AS rfq_ref, r.mode, r.pol, r.pod, a.company AS customer,
       (SELECT min(etd) FROM bookings b WHERE b.job_id=j.id AND b.status<>'cancelled') AS etd,
       (SELECT count(*)::int FROM bookings b WHERE b.job_id=j.id AND b.status='confirmed') AS confirmed,
       (SELECT count(*)::int FROM bookings b WHERE b.job_id=j.id AND b.status<>'cancelled') AS bookings
     FROM jobs j LEFT JOIN rfqs r ON r.id=j.rfq_id LEFT JOIN agents a ON a.id=j.requester_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY j.id DESC LIMIT 500`,
    vals
  );
  const fx = await getFx();
  const costs = rows.length ? await q('SELECT job_id, kind, amount, currency FROM job_costs WHERE job_id = ANY($1)', [rows.map((r) => r.id)]) : [];
  return rows.map((r) => ({ ...r, profit: jobProfit(costs.filter((c) => c.job_id === r.id), fx) }));
}

export async function loadJob(id) {
  const job = await one(
    `SELECT j.*, r.ref AS rfq_ref, a.company AS customer, a.email AS customer_email, cq.ref AS quote_ref
     FROM jobs j LEFT JOIN rfqs r ON r.id=j.rfq_id LEFT JOIN agents a ON a.id=j.requester_id LEFT JOIN customer_quotes cq ON cq.id=j.customer_quote_id WHERE j.id=$1`,
    [id]
  );
  if (!job) throw err('Job not found', 404);
  const [rfq, bookings, costs, files, emails] = await Promise.all([
    job.rfq_id ? one('SELECT * FROM rfqs WHERE id=$1', [job.rfq_id]) : null,
    q('SELECT b.*, a.company AS agent, a.email AS agent_email, a.source AS agent_source FROM bookings b LEFT JOIN agents a ON a.id=b.agent_id WHERE b.job_id=$1 ORDER BY b.id', [id]),
    q('SELECT c.*, a.company AS agent FROM job_costs c LEFT JOIN agents a ON a.id=c.agent_id WHERE c.job_id=$1 ORDER BY c.kind DESC, c.id', [id]),
    q('SELECT id, kind, filename, content_type, size, email_id, created_at FROM job_files WHERE job_id=$1 ORDER BY id', [id]),
    q(`SELECT e.id, e.direction, e.kind, e.from_addr, e.to_addr, e.subject, e.body_text, e.at, e.parse_status, e.parse_error, e.booking_id,
         (SELECT json_agg(json_build_object('id',x.id,'filename',x.filename)) FROM attachments x WHERE x.email_id=e.id) AS attachments
       FROM emails e WHERE e.job_id=$1 ORDER BY e.at DESC`, [id]),
  ]);
  const fx = await getFx();
  return { job, rfq, bookings, costs, files, emails, profit: jobProfit(costs, fx), profit_quote_currency: job.sell_currency ? jobProfit(costs, fx, job.sell_currency) : null };
}

export async function updateJob(id, body) {
  const sets = [];
  const vals = [];
  for (const f of JOB_FIELDS) {
    if (!(f in body)) continue;
    vals.push(['shipper', 'consignee', 'notify_party'].includes(f) ? JSON.stringify(body[f] || {}) : blank(body[f]));
    sets.push(`${f}=$${vals.length}`);
  }
  if (!sets.length) return loadJob(id);
  vals.push(id);
  await q(`UPDATE jobs SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
  return loadJob(id);
}

async function refreshStatus(jobId) {
  const job = await one('SELECT status FROM jobs WHERE id=$1', [jobId]);
  const bookings = await q('SELECT status FROM bookings WHERE job_id=$1', [jobId]);
  const status = deriveJobStatus(job.status, bookings);
  if (status !== job.status) await q('UPDATE jobs SET status=$1 WHERE id=$2', [status, jobId]);
  return status;
}

/** Departed / arrived / completed / cancelled — set by a person. 'reopen' goes back to the booking-derived status. */
export async function setMilestone(jobId, { status, date }) {
  if (status === 'reopen') {
    await q("UPDATE jobs SET status='open', closed_at=NULL WHERE id=$1", [jobId]);
    await refreshStatus(jobId);
    return loadJob(jobId);
  }
  if (!MILESTONES.includes(status)) throw err('Unknown milestone');
  const d = blank(date) || new Date().toISOString().slice(0, 10);
  await q(
    `UPDATE jobs SET status=$1,
       atd=CASE WHEN $1='departed' THEN $2::date ELSE atd END,
       ata=CASE WHEN $1='arrived' THEN $2::date ELSE ata END,
       closed_at=CASE WHEN $1 IN ('completed','cancelled') THEN now() ELSE closed_at END
     WHERE id=$3`,
    [status, d, jobId]
  );
  return loadJob(jobId);
}

// ---------------- bookings ----------------

export async function sendBookingRequest(bookingId, { fileIds = [], note, to } = {}, user) {
  const b = await one('SELECT * FROM bookings WHERE id=$1', [bookingId]);
  if (!b) throw err('Booking not found', 404);
  if (b.source === 'own') throw err('This leg uses your own rates. Enter the booking details yourself.');
  const job = await one('SELECT * FROM jobs WHERE id=$1', [b.job_id]);
  const rfq = await one('SELECT * FROM rfqs WHERE id=$1', [job.rfq_id]);
  const agent = await one('SELECT * FROM agents WHERE id=$1', [b.agent_id]);
  const recipient = to || agent?.email;
  if (!recipient) throw err('The agent has no email address');
  const mb = await getMailbox(rfq.mailbox_id);
  if (!mb) throw err('No mailbox configured');
  // stay in the agent's quotation thread
  const last = b.invite_id ? await one("SELECT message_id FROM emails WHERE invite_id=$1 AND message_id IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1", [b.invite_id]) : null;
  const files = fileIds.length ? await q('SELECT filename, content_type, data FROM job_files WHERE job_id=$1 AND id = ANY($2)', [job.id, fileIds.map(Number)]) : [];
  const tpl = bookingRequestEmail({ job, booking: b, rfq, agent, mb, note });
  const email = await sendMail(
    mb,
    { to: recipient, cc: agent?.cc || undefined, subject: tpl.subject, text: tpl.text, html: tpl.html, inReplyTo: last?.message_id || undefined, references: last?.message_id ? [last.message_id] : undefined, attachments: files.map((f) => ({ filename: f.filename, contentType: f.content_type, content: f.data })) },
    { kind: 'booking_request', rfq_id: rfq.id }
  );
  await q('UPDATE emails SET job_id=$1, booking_id=$2 WHERE id=$3', [job.id, b.id, email.id]);
  await q("UPDATE bookings SET status=CASE WHEN status='confirmed' THEN status ELSE 'requested' END, requested_at=now(), message_id=$1, last_error=NULL WHERE id=$2", [email.message_id, b.id]);
  await refreshStatus(job.id);
  return loadJob(job.id);
}

/** Send to every agent booking not yet requested. Failures are kept on the booking. */
export async function sendAllBookingRequests(jobId, opts, user) {
  const list = await q("SELECT id FROM bookings WHERE job_id=$1 AND status='draft' AND source<>'own'", [jobId]);
  const results = [];
  for (const b of list) {
    try {
      await sendBookingRequest(b.id, opts, user);
      results.push({ id: b.id, ok: true });
    } catch (e) {
      await q('UPDATE bookings SET last_error=$1 WHERE id=$2', [e.message.slice(0, 500), b.id]);
      results.push({ id: b.id, ok: false, error: e.message });
    }
  }
  return { results, job: await loadJob(jobId) };
}

/** A person enters or corrects booking details. */
export async function updateBooking(bookingId, body) {
  const sets = [];
  const vals = [];
  for (const f of BOOKING_FIELDS) {
    if (!(f in body)) continue;
    vals.push(f === 'cutoffs' ? JSON.stringify(body.cutoffs || {}) : f === 'container_nos' ? (body.container_nos || []).filter(Boolean) : blank(body[f]));
    sets.push(`${f}=$${vals.length}`);
  }
  if (body.status && ['draft', 'requested', 'confirmed', 'rejected', 'cancelled'].includes(body.status)) {
    vals.push(body.status);
    sets.push(`status=$${vals.length}`);
    if (body.status === 'confirmed') sets.push('confirmed_at=coalesce(confirmed_at,now())');
  }
  if (body.verified !== undefined) { vals.push(!!body.verified); sets.push(`verified=$${vals.length}`); }
  if (!sets.length) throw err('Nothing to change');
  vals.push(bookingId);
  const b = await one(`UPDATE bookings SET ${sets.join(',')}, source=CASE WHEN source='ai' THEN 'ai+manual' ELSE source END WHERE id=$${vals.length} RETURNING job_id`, vals);
  await refreshStatus(b.job_id);
  return loadJob(b.job_id);
}

/** Inbound mail about a booking: job tag in the subject, or a reply in a booking-request thread. */
export async function matchBooking({ subject, text, inReplyTo, references }) {
  const m = JOB_TAG_REGEX.exec(subject || '') || JOB_TAG_REGEX.exec(text || '');
  if (m) {
    const b = await one('SELECT b.*, j.rfq_id FROM bookings b JOIN jobs j ON j.id=b.job_id WHERE j.ref=$1 AND b.tag=$2', [m[1], m[2]]);
    if (b) return b;
  }
  const ids = [inReplyTo, ...(Array.isArray(references) ? references : references ? [references] : [])].filter(Boolean);
  if (ids.length) {
    const e = await one('SELECT booking_id FROM emails WHERE booking_id IS NOT NULL AND message_id = ANY($1) ORDER BY id DESC LIMIT 1', [ids]);
    if (e) return one('SELECT b.*, j.rfq_id FROM bookings b JOIN jobs j ON j.id=b.job_id WHERE b.id=$1', [e.booking_id]);
  }
  return null;
}

export async function onBookingReply(email) {
  const ai = await getSetting('ai');
  if (!ai.auto_parse || !(await getAiKey())) {
    await q("UPDATE emails SET parse_status='review' WHERE id=$1", [email.id]);
    return;
  }
  await readBookingEmail(email.id);
}

/** Read a booking reply with AI and apply it to the booking. Low-confidence results wait for a person. */
export async function readBookingEmail(emailId) {
  const email = await one('SELECT * FROM emails WHERE id=$1', [emailId]);
  if (!email?.booking_id) throw err('This email is not linked to a booking');
  const booking = await one('SELECT * FROM bookings WHERE id=$1', [email.booking_id]);
  const job = await one('SELECT * FROM jobs WHERE id=$1', [booking.job_id]);
  const atts = await q('SELECT id, filename, content_type, data FROM attachments WHERE email_id=$1', [emailId]);
  // keep the agent's documents with the job (once)
  for (const a of atts) {
    if (!(await one('SELECT 1 FROM job_files WHERE job_id=$1 AND email_id=$2 AND filename=$3', [job.id, emailId, a.filename]))) {
      await q("INSERT INTO job_files(job_id,kind,filename,content_type,size,data,email_id) VALUES($1,'booking',$2,$3,$4,$5,$6)", [job.id, a.filename, a.content_type, a.data?.length || 0, a.data, emailId]);
    }
  }
  try {
    await q("UPDATE emails SET parse_status='parsing' WHERE id=$1", [emailId]);
    const r = await aiReadBooking({ job, booking, email, attachmentBlocks: atts.flatMap(attachmentBlocks) });
    const changes = bookingChanges(booking, r);
    const sure = r.confidence >= 0.7;
    let status = booking.status;
    if (r.rejected) status = 'rejected';
    else if (r.is_confirmation && (r.booking_no || r.vessel || r.flight_no) && sure) status = 'confirmed';
    const vals = [];
    const sets = Object.entries(changes).map(([k, v]) => {
      vals.push(k === 'cutoffs' ? JSON.stringify(v) : v);
      return `${k}=$${vals.length}`;
    });
    vals.push(status, r.confidence, booking.id);
    await q(
      `UPDATE bookings SET ${sets.length ? `${sets.join(',')},` : ''} status=$${vals.length - 2}, confidence=$${vals.length - 1}, source=CASE WHEN source='agent' THEN 'ai' ELSE source END,
         verified=false, confirmed_at=CASE WHEN $${vals.length - 2}='confirmed' THEN coalesce(confirmed_at,now()) ELSE confirmed_at END WHERE id=$${vals.length}`,
      vals
    );
    await q('UPDATE emails SET parse_status=$1, parse_error=$2 WHERE id=$3', [sure ? 'parsed' : 'review', r.summary ? r.summary.slice(0, 500) : null, emailId]);
    await refreshStatus(job.id);
    await audit(null, r.rejected ? 'Agent could not book' : status === 'confirmed' ? 'Booking confirmed by agent (read by AI)' : 'Agent booking reply read by AI', {
      entity: 'booking', entityId: booking.id, rfqId: job.rfq_id, jobId: job.id,
      summary: [job.ref, r.booking_no, r.vessel || r.flight_no, !sure && 'needs checking'].filter(Boolean).join(' · '),
    });
    return { result: r, changes, status };
  } catch (e) {
    await q("UPDATE emails SET parse_status='error', parse_error=$1 WHERE id=$2", [e.message.slice(0, 500), emailId]);
    throw e;
  }
}

/** Booking details to the customer (or the partner agent who asked us), in their enquiry thread. */
export async function sendCustomerConfirmation(jobId, { note, to } = {}, user) {
  const job = await one('SELECT * FROM jobs WHERE id=$1', [jobId]);
  const bookings = await q("SELECT * FROM bookings WHERE job_id=$1 AND status='confirmed' ORDER BY id", [jobId]);
  if (!bookings.length) throw err('No confirmed booking yet');
  await mailRequester(job.rfq_id, (ctx) => customerBookingEmail({ ...ctx, job, bookings, note }), { to, kind: 'booking_confirmation', refSuffix: job.ref, jobId });
  await q("UPDATE jobs SET customer_notified_at=now() WHERE id=$1", [jobId]);
  return loadJob(jobId);
}

// ---------------- costs & files ----------------

export async function addCost(jobId, { kind, leg, description, amount, currency, agent_id }) {
  if (!['buy', 'sell'].includes(kind)) throw err('Cost must be buy or sell');
  if (!description || amount === undefined || amount === '' || !currency) throw err('Description, amount and currency are required');
  await q("INSERT INTO job_costs(job_id,kind,leg,description,amount,currency,agent_id,source) VALUES($1,$2,$3,$4,$5,$6,$7,'manual')", [jobId, kind, blank(leg), description, Number(amount), String(currency).toUpperCase(), blank(agent_id)]);
  return loadJob(jobId);
}

export async function deleteCost(costId) {
  const c = await one('DELETE FROM job_costs WHERE id=$1 RETURNING job_id', [costId]);
  if (!c) throw err('Not found', 404);
  return loadJob(c.job_id);
}

export async function addFiles(jobId, files, kind, user) {
  for (const f of files || []) {
    await q('INSERT INTO job_files(job_id,kind,filename,content_type,size,data,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [jobId, kind || 'other', f.originalname, f.mimetype, f.size, f.buffer, user?.id || null]);
  }
  return loadJob(jobId);
}

export const getFile = (fileId) => one('SELECT * FROM job_files WHERE id=$1', [fileId]);

export async function deleteFile(fileId) {
  const f = await one('DELETE FROM job_files WHERE id=$1 RETURNING job_id', [fileId]);
  if (!f) throw err('Not found', 404);
  return loadJob(f.job_id);
}

// ---------------- dashboard ----------------

export async function upcomingCutoffs(hours = 72) {
  const rows = await q(
    `SELECT b.id, b.job_id, b.status, b.cutoffs, j.ref AS job_ref, a.company AS agent
     FROM bookings b JOIN jobs j ON j.id=b.job_id LEFT JOIN agents a ON a.id=b.agent_id
     WHERE j.status NOT IN ('departed','arrived','completed','cancelled') AND b.cutoffs <> '{}'::jsonb`
  );
  const company = await getSetting('company');
  const due = cutoffsDue(rows, new Date(), hours, tzOffset(company?.country));
  return due.map((d) => ({ ...d, agent: rows.find((r) => r.id === d.booking_id)?.agent }));
}

export async function jobCounts() {
  return one(
    `SELECT count(*) FILTER (WHERE status='open')::int AS open,
            count(*) FILTER (WHERE status='booking_requested')::int AS booking_requested,
            count(*) FILTER (WHERE status='booked')::int AS booked,
            count(*) FILTER (WHERE status IN ('departed','arrived'))::int AS moving
     FROM jobs`
  );
}
