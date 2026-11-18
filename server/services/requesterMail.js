// Email the requester of an RFQ (customer or partner agent), inside their own enquiry thread when there is one.
// Shared by quotations, follow-ups and booking confirmations.
import { one } from '../db.js';
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
