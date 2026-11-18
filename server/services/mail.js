// Mailbox access: sending via SMTP and receiving via IMAP, per configurable mailbox.
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { q, one } from '../db.js';
import { decrypt } from '../lib/crypto.js';
import { ingestInbound } from './replies.js';

export async function getMailbox(id) {
  const mb = id ? await one('SELECT * FROM mailboxes WHERE id=$1', [id]) : await one('SELECT * FROM mailboxes WHERE active ORDER BY is_default DESC, id LIMIT 1');
  if (!mb) return null;
  return { ...mb, smtp_pass: decrypt(mb.smtp_pass_enc), imap_pass: decrypt(mb.imap_pass_enc) };
}

export const canSend = (mb) => !!(mb && mb.smtp_host && mb.smtp_user && mb.smtp_pass);
export const canReceive = (mb) => !!(mb && mb.imap_host && mb.imap_user && mb.imap_pass);

function transport(mb) {
  return nodemailer.createTransport({
    host: mb.smtp_host,
    port: Number(mb.smtp_port || 587),
    secure: !!mb.smtp_secure,
    auth: { user: mb.smtp_user, pass: mb.smtp_pass },
    connectionTimeout: 20000,
  });
}

export async function testSmtp(mb) {
  await transport(mb).verify();
  return true;
}

export async function testImap(mb) {
  const client = imapClient(mb);
  await client.connect();
  const status = await client.status(mb.imap_folder || 'INBOX', { messages: true, uidNext: true });
  await client.logout();
  return status;
}

/**
 * Send and log an email. Returns the stored email row.
 * meta: { kind, rfq_id, invite_id }
 */
export async function sendMail(mb, msg, meta = {}) {
  if (!canSend(mb)) throw new Error(`Mailbox "${mb?.label || 'none'}" has no SMTP settings. Configure it in Settings → Mailboxes.`);
  const cc = [msg.cc, meta.kind && meta.kind !== 'customer_quote' ? mb.cc : null].filter(Boolean).join(', ') || undefined;
  const info = await transport(mb).sendMail({
    from: { name: mb.from_name, address: mb.from_email },
    replyTo: mb.reply_to || undefined,
    to: msg.to,
    cc,
    bcc: mb.bcc || undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    inReplyTo: msg.inReplyTo,
    references: msg.references,
    attachments: msg.attachments,
  });
  return one(
    `INSERT INTO emails(direction,kind,mailbox_id,rfq_id,invite_id,message_id,in_reply_to,from_addr,to_addr,cc_addr,subject,body_text,body_html)
     VALUES('out',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [meta.kind || null, mb.id, meta.rfq_id || null, meta.invite_id || null, info.messageId, msg.inReplyTo || null, mb.from_email, msg.to, cc || null, msg.subject, msg.text, msg.html]
  );
}

function imapClient(mb) {
  return new ImapFlow({
    host: mb.imap_host,
    port: Number(mb.imap_port || 993),
    secure: mb.imap_secure !== false,
    auth: { user: mb.imap_user, pass: mb.imap_pass },
    logger: false,
    socketTimeout: 60000,
  });
}

let polling = false;

/** Fetch new messages from one mailbox and hand them to the reply pipeline. */
export async function pollMailbox(mb) {
  const client = imapClient(mb);
  let count = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(mb.imap_folder || 'INBOX');
    try {
      let lastUid = Number(mb.last_uid || 0);
      let uids;
      if (!lastUid) {
        // first run: only look back 3 days, then remember the position
        uids = await client.search({ since: new Date(Date.now() - 3 * 864e5) }, { uid: true });
      } else {
        uids = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
      }
      uids = (uids || []).filter((u) => u > lastUid).sort((a, b) => a - b);
      for (const uid of uids) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (msg?.source) {
          const parsed = await simpleParser(msg.source);
          try {
            await ingestInbound(mb, parsed);
            count++;
          } catch (e) {
            console.error('ingest failed', uid, e.message);
          }
        }
        lastUid = uid;
        await q('UPDATE mailboxes SET last_uid=$1 WHERE id=$2', [lastUid, mb.id]);
      }
    } finally {
      lock.release();
    }
    await client.logout();
    await q('UPDATE mailboxes SET last_poll_at=now(), last_poll_error=NULL WHERE id=$1', [mb.id]);
  } catch (e) {
    await q('UPDATE mailboxes SET last_poll_at=now(), last_poll_error=$1 WHERE id=$2', [String(e.message).slice(0, 500), mb.id]);
    try { await client.logout(); } catch {}
    throw e;
  }
  return count;
}

export async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    const rows = await q('SELECT id FROM mailboxes WHERE active');
    for (const r of rows) {
      const mb = await getMailbox(r.id);
      if (!canReceive(mb)) continue;
      try {
        const n = await pollMailbox(mb);
        if (n) console.log(`mailbox ${mb.label}: ${n} new message(s)`);
      } catch (e) {
        console.error(`mailbox ${mb.label} poll error:`, e.message);
      }
    }
  } finally {
    polling = false;
  }
}
