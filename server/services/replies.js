// Reply pipeline: match inbound email to an RFQ invite, store it, and read it with AI.
import { q, one, tx } from '../db.js';
import { TAG_REGEX } from './templates.js';
import { attachmentBlocks, htmlToText } from './extract.js';
import { parseAgentReply, classifyEmail } from './ai.js';
import { getSetting, getAiKey } from './settings.js';
import { createRfqFromEmail } from './intake.js';
import { rememberQuote } from './rateCards.js';
import { audit } from './audit.js';
import { matchBooking, onBookingReply } from './jobs.js';

const addr = (a) => (a?.value || []).map((v) => v.address?.toLowerCase()).filter(Boolean);

export async function matchInvite({ subject, text, inReplyTo, references, from }) {
  const m = TAG_REGEX.exec(subject || '') || TAG_REGEX.exec(text || '');
  if (m) {
    const inv = await one('SELECT i.* FROM rfq_invites i JOIN rfqs r ON r.id=i.rfq_id WHERE r.ref=$1 AND i.tag=$2', [m[1], m[2]]);
    if (inv) return { invite: inv, method: 'reference' };
  }
  const ids = [inReplyTo, ...(Array.isArray(references) ? references : references ? [references] : [])].filter(Boolean);
  if (ids.length) {
    const e = await one("SELECT invite_id FROM emails WHERE direction='out' AND invite_id IS NOT NULL AND message_id = ANY($1) ORDER BY id DESC LIMIT 1", [ids]);
    if (e) return { invite: await one('SELECT * FROM rfq_invites WHERE id=$1', [e.invite_id]), method: 'thread' };
    // a follow-up from the requester in their enquiry thread / our quotation thread
    const r = await one("SELECT rfq_id FROM emails WHERE rfq_id IS NOT NULL AND invite_id IS NULL AND message_id = ANY($1) ORDER BY id DESC LIMIT 1", [ids]);
    if (r) return { invite: null, rfqId: r.rfq_id, method: 'requester_thread' };
  }
  if (from) {
    const inv = await one(
      `SELECT i.* FROM rfq_invites i JOIN agents a ON a.id=i.agent_id JOIN rfqs r ON r.id=i.rfq_id
       WHERE (lower(a.email)=$1 OR lower(coalesce(a.cc,'')) LIKE '%'||$1||'%') AND i.status IN ('sent','reminded','replied') AND r.status IN ('sent','quoting')
       ORDER BY i.sent_at DESC NULLS LAST LIMIT 1`,
      [from.toLowerCase()]
    );
    if (inv) return { invite: inv, method: 'sender' };
  }
  return { invite: null, method: null };
}

export async function storeInbound({ mailboxId, invite, rfqId, jobId, bookingId, kind, status, messageId, inReplyTo, from, to, cc, subject, text, html, attachments, at }) {
  return tx(async (t) => {
    const email = await t.one(
      `INSERT INTO emails(direction,kind,mailbox_id,rfq_id,invite_id,message_id,in_reply_to,from_addr,to_addr,cc_addr,subject,body_text,body_html,at,parse_status,job_id,booking_id)
       VALUES('in',$14,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12,now()),$13,$15,$16) RETURNING *`,
      [mailboxId || null, invite?.rfq_id || rfqId || null, invite?.id || null, messageId || null, inReplyTo || null, from, to, cc, subject, text, html, at || null, status || (invite ? 'pending' : 'unmatched'), kind || (invite ? 'agent_reply' : null), jobId || null, bookingId || null]
    );
    for (const a of attachments || []) {
      await t.q('INSERT INTO attachments(email_id,filename,content_type,size,data) VALUES($1,$2,$3,$4,$5)', [email.id, a.filename, a.contentType, a.size || a.content?.length || 0, a.content]);
    }
    if (invite) {
      await t.q("UPDATE rfq_invites SET status=CASE WHEN status IN ('declined') THEN status ELSE 'replied' END, replied_at=coalesce(replied_at,now()) WHERE id=$1", [invite.id]);
      await t.q("UPDATE rfqs SET status='quoting' WHERE id=$1 AND status='sent'", [invite.rfq_id]);
    }
    return email;
  });
}

async function maybeAutoParse(email) {
  if (!email.invite_id) return;
  const ai = await getSetting('ai');
  if (!ai.auto_parse) return;
  parseEmail(email.id).catch((e) => console.error('AI parse failed', email.id, e.message));
}

/** From IMAP (mailparser output). */
export async function ingestInbound(mb, parsed) {
  const messageId = parsed.messageId;
  if (messageId && (await one('SELECT id FROM emails WHERE message_id=$1', [messageId]))) return null;
  const from = addr(parsed.from)[0] || '';
  if (from && from === String(mb.from_email).toLowerCase()) return null; // our own sent copy
  const text = parsed.text || htmlToText(parsed.html || '');
  const mailAttachments = (parsed.attachments || []).filter((a) => !a.related || /pdf|sheet|excel|csv/.test(a.contentType));
  // replies about a booking go to the job, not to the quotation
  const booking = await matchBooking({ subject: parsed.subject, text, inReplyTo: parsed.inReplyTo, references: parsed.references });
  if (booking) {
    const email = await storeInbound({
      mailboxId: mb.id, rfqId: booking.rfq_id, jobId: booking.job_id, bookingId: booking.id, kind: 'booking_reply', status: 'pending',
      messageId, inReplyTo: parsed.inReplyTo, from, to: addr(parsed.to).join(', '), cc: addr(parsed.cc).join(', '),
      subject: parsed.subject || '', text, html: typeof parsed.html === 'string' ? parsed.html : null, attachments: mailAttachments, at: parsed.date,
    });
    onBookingReply(email).catch((e) => console.error('booking reply', e.message));
    return email;
  }
  let { invite, rfqId, method } = await matchInvite({ subject: parsed.subject, text, inReplyTo: parsed.inReplyTo, references: parsed.references, from });
  let kind;
  let status;
  let classified = null;
  if (method === 'requester_thread') {
    kind = 'requester_reply';
    status = 'requester';
  } else if (!invite || method === 'sender') {
    // weak or no match: let the AI decide whether this is a quote reply or a new enquiry
    classified = await classifySafe({ from_addr: from, subject: parsed.subject, body_text: text });
    if (classified?.type === 'new_enquiry' && classified.confidence >= 0.6) {
      invite = null;
      kind = 'enquiry';
      status = 'enquiry';
    } else if (classified && classified.type !== 'quote_reply' && method === 'sender') {
      invite = null; // not a quote: don't attach it to the agent's open RFQ
    }
  }
  const email = await storeInbound({
    mailboxId: mb.id,
    invite,
    rfqId,
    kind,
    status,
    messageId,
    inReplyTo: parsed.inReplyTo,
    from,
    to: addr(parsed.to).join(', '),
    cc: addr(parsed.cc).join(', '),
    subject: parsed.subject || '',
    text,
    html: typeof parsed.html === 'string' ? parsed.html : null,
    attachments: mailAttachments,
    at: parsed.date,
  });
  if (kind === 'enquiry') {
    await createRfqFromEmail(email.id, { mailboxId: mb.id }).catch((e) => q("UPDATE emails SET parse_status='error', parse_error=$1 WHERE id=$2", [e.message.slice(0, 500), email.id]));
    return email;
  }
  await maybeAutoParse(email);
  return email;
}

async function classifySafe(email) {
  if (!(await getAiKey())) return null;
  try {
    return await classifyEmail(email);
  } catch (e) {
    console.error('classify failed', e.message);
    return null;
  }
}

/** Manually logged reply (pasted text + uploaded files), e.g. when an agent replied to a personal inbox. */
export async function ingestManual({ invite, from, subject, text, files }) {
  const email = await storeInbound({
    invite,
    from: from || 'manual-entry',
    subject: subject || 'Reply logged manually',
    text: text || '',
    attachments: (files || []).map((f) => ({ filename: f.originalname, contentType: f.mimetype, size: f.size, content: f.buffer })),
  });
  await q("UPDATE emails SET kind='manual_reply' WHERE id=$1", [email.id]);
  await maybeAutoParse(email);
  return email;
}

/** Assign an unmatched email to an invite. */
export async function assignEmail(emailId, inviteId) {
  const invite = await one('SELECT * FROM rfq_invites WHERE id=$1', [inviteId]);
  if (!invite) throw new Error('Invite not found');
  await q("UPDATE emails SET invite_id=$1, rfq_id=$2, parse_status='pending' WHERE id=$3", [invite.id, invite.rfq_id, emailId]);
  await q("UPDATE rfq_invites SET status='replied', replied_at=coalesce(replied_at,now()) WHERE id=$1 AND status<>'declined'", [invite.id]);
  return parseEmail(emailId);
}

/** Run the AI reader on one stored email and save the agent quote. */
export async function parseEmail(emailId) {
  const email = await one('SELECT * FROM emails WHERE id=$1', [emailId]);
  if (!email?.invite_id) throw new Error('Email is not linked to an RFQ invite');
  const invite = await one('SELECT * FROM rfq_invites WHERE id=$1', [email.invite_id]);
  const rfq = await one('SELECT * FROM rfqs WHERE id=$1', [invite.rfq_id]);
  const atts = await q('SELECT * FROM attachments WHERE email_id=$1', [email.id]);
  await q("UPDATE emails SET parse_status='parsing', parse_error=NULL WHERE id=$1", [email.id]);
  let result;
  try {
    result = await parseAgentReply({ rfq, invite, email, attachmentBlocks: atts.flatMap(attachmentBlocks) });
  } catch (e) {
    await q("UPDATE emails SET parse_status='error', parse_error=$1 WHERE id=$2", [e.message.slice(0, 500), email.id]);
    throw e;
  }
  const { review_threshold = 0.75 } = await getSetting('ai');
  if (result.declined) {
    await saveQuote({ rfq_id: rfq.id, invite_id: invite.id, email_id: email.id, declined: true, remarks: result.remarks, confidence: result.confidence, verified: true, lines: [], source: 'ai' });
    await q("UPDATE rfq_invites SET status='declined' WHERE id=$1", [invite.id]);
    await q("UPDATE emails SET parse_status='declined' WHERE id=$1", [email.id]);
    return { status: 'declined', result };
  }
  if (!result.is_quote || !result.lines.length) {
    await q("UPDATE emails SET parse_status='no_quote', parse_error=$1 WHERE id=$2", [result.summary?.slice(0, 500) || null, email.id]);
    return { status: 'no_quote', result };
  }
  const verified = result.confidence >= review_threshold && result.lines.every((l) => l.confidence >= review_threshold);
  const quote = await saveQuote({ ...result, rfq_id: rfq.id, invite_id: invite.id, email_id: email.id, verified, source: 'ai' });
  await q("UPDATE emails SET parse_status='parsed' WHERE id=$1", [email.id]);
  const agentName = (await one('SELECT company FROM agents WHERE id=$1', [invite.agent_id]))?.company;
  await audit(null, 'Agent reply read by AI', { entity: 'agent_quote', entityId: quote.id, rfqId: rfq.id, summary: `${agentName}: ${result.lines.length} charge(s), confidence ${Math.round(result.confidence * 100)}%${verified ? '' : ' (needs review)'}` });
  if (verified) await rememberQuote(quote.id).catch((e) => console.error('rate memory', e.message));
  return { status: 'parsed', quote };
}

/** Create a new agent quote for an invite (older ones are kept but superseded). Used by AI and manual entry. */
export async function saveQuote(d) {
  return tx(async (t) => {
    await t.q('UPDATE agent_quotes SET superseded=true WHERE invite_id=$1', [d.invite_id]);
    const qrow = await t.one(
      `INSERT INTO agent_quotes(rfq_id,invite_id,email_id,valid_until,transit_days,free_days,routing,carrier,remarks,exclusions,declined,confidence,verified,source)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [d.rfq_id, d.invite_id, d.email_id || null, d.valid_until || null, d.transit_days ?? null, d.free_days ?? null, d.routing || null, d.carrier || null, d.remarks || null, d.exclusions || null, !!d.declined, d.confidence ?? null, !!d.verified, d.source || 'manual']
    );
    let i = 0;
    for (const l of d.lines || []) {
      await t.q(
        'INSERT INTO quote_lines(agent_quote_id,leg,charge_code,description,basis,rate,currency,qty,confidence,sort) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [qrow.id, l.leg, l.charge_code, l.description || null, l.basis, Number(l.rate) || 0, (l.currency || 'USD').toUpperCase(), l.qty === '' || l.qty === undefined ? null : l.qty, l.confidence ?? null, l.sort ?? i]
      );
      i++;
    }
    return qrow;
  });
}
