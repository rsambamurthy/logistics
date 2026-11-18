// Email the requester of an RFQ (customer or partner agent), inside their own enquiry thread when there is one.
// Shared by quotations, follow-ups and booking confirmations.
// mailBookingAgent: the same for a partner agent's booking on a job (booking requests, SI, BL replies).
import { q, one } from '../db.js';
import { getMailbox, sendMail } from './mail.js';

/**
 * build({ rfq, customer, mb }) -> { subject, text, html }
 * opts: { to, cc, subject, text, attachments, kind, refSuffix, jobId }
 */
export async function mailRequester(rfqId, build, { to, cc, subject, text, attachments, kind, refSuffix, jobId } = {}) {
  const rfq = await one('SELECT * FROM rfqs WHERE id=$1', [rfqId]);
  const requester = rfq.requester_id ? await one('SELECT * FROM agents WHERE id=$1', [rfq.requester_id]) : null;
  const source = rfq.source_email_id ? await one('SELECT message_id, subject FROM emails WHERE id=$1', [rfq.source_email_id]) : null;
  const mb = await getMailbox(rfq.mailbox_id);
  if (!mb) throw Object.assign(new Error('No mailbox configured'), { status: 400 });
  const tpl = build({ rfq, customer: requester && { name: requester.company, contact: requester.contact }, mb });
  const recipient = to || requester?.email;
  if (!recipient) throw Object.assign(new Error('Requester email missing'), { status: 400 });
  const threadSubject = source?.subject ? `${/^re:/i.test(source.subject) ? '' : 'Re: '}${source.subject}${refSuffix ? ` — ${refSuffix}` : ''}` : null;
  const email = await sendMail(
    mb,
    { to: recipient, cc, subject: subject || threadSubject || tpl.subject, text: text || tpl.text, html: text ? undefined : tpl.html, inReplyTo: source?.message_id || undefined, references: source?.message_id ? [source.message_id] : undefined, attachments },
    { kind, rfq_id: rfq.id }
  );
  if (jobId) await one('UPDATE emails SET job_id=$1 WHERE id=$2 RETURNING id', [jobId, email.id]);
  return { rfq, email };
}

/**
 * Email the agent of a booking, in their thread (the given message, else their latest quote / booking mail).
 * build({ job, booking, rfq, agent, mb }) -> { subject, text, html }. Returns the stored email.
 */
export async function mailBookingAgent(bookingId, build, { to, attachments, inReplyTo, kind } = {}) {
  const booking = await one('SELECT * FROM bookings WHERE id=$1', [bookingId]);
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
  const job = await one('SELECT * FROM jobs WHERE id=$1', [booking.job_id]);
  const rfq = await one('SELECT * FROM rfqs WHERE id=$1', [job.rfq_id]);
  const agent = booking.agent_id ? await one('SELECT * FROM agents WHERE id=$1', [booking.agent_id]) : null;
  const recipient = to || agent?.email;
  if (!recipient) throw Object.assign(new Error('The agent has no email address'), { status: 400 });
  const mb = await getMailbox(rfq.mailbox_id);
  if (!mb) throw Object.assign(new Error('No mailbox configured'), { status: 400 });
  const last = inReplyTo
    ? { message_id: inReplyTo }
    : await one('SELECT message_id FROM emails WHERE (booking_id=$1 OR ($2::int IS NOT NULL AND invite_id=$2)) AND message_id IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1', [booking.id, booking.invite_id]);
  const tpl = build({ job, booking, rfq, agent, mb });
  const email = await sendMail(
    mb,
    { to: recipient, cc: agent?.cc || undefined, subject: tpl.subject, text: tpl.text, html: tpl.html, inReplyTo: last?.message_id || undefined, references: last?.message_id ? [last.message_id] : undefined, attachments },
    { kind, rfq_id: rfq.id }
  );
  await one('UPDATE emails SET job_id=$1, booking_id=$2 WHERE id=$3 RETURNING id', [job.id, booking.id, email.id]);
  return email;
}

/** Job documents as mail attachments. */
export async function filesForMail(jobId, fileIds = []) {
  if (!fileIds?.length) return [];
  const rows = await q('SELECT filename, content_type, data FROM job_files WHERE job_id=$1 AND id = ANY($2)', [jobId, fileIds.map(Number)]);
  return rows.map((f) => ({ filename: f.filename, contentType: f.content_type, content: f.data }));
}
