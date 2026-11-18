// RFQ lifecycle: create, invite agents, send, remind, compare, award.
import { q, one, tx } from '../db.js';
import { randomTag } from '../lib/crypto.js';
import { getMailbox, sendMail } from './mail.js';
import { rfqEmail, reminderEmail, counterEmail, awardEmail, regretEmail } from './templates.js';
import { compare } from '../engines/costing.js';
import { getFx } from './settings.js';

const RFQ_FIELDS = ['requester_id', 'requester_role', 'requester_ref', 'source_email_id', 'parent_rfq_id', 'hs_code', 'dangerous_goods', 'dg_class', 'un_number', 'reefer_temp', 'dimensions', 'cargo_value', 'cargo_value_currency', 'stackable', 'mailbox_id', 'mode', 'pol', 'pod', 'pickup_place', 'delivery_place', 'incoterm', 'commodity', 'containers', 'packages', 'gross_weight_kg', 'volume_cbm', 'ready_date', 'deadline', 'notes', 'legs'];

function clean(v) {
  return v === '' || v === undefined ? null : v;
}

export async function nextRef(prefix = 'RFQ') {
  const year = new Date().getFullYear();
  const row = await one(`SELECT count(*)::int AS n FROM rfqs WHERE ref LIKE $1`, [`${prefix}-${year}-%`]);
  return `${prefix}-${year}-${String(row.n + 1).padStart(4, '0')}`;
}

export async function createRfq(dataIn, userId) {
  const data = { ...dataIn, requester_role: dataIn.requester_role || 'customer' };
  const ref = await nextRef();
  const vals = RFQ_FIELDS.map((f) => (f === 'containers' ? JSON.stringify(data.containers || []) : clean(data[f])));
  const rfq = await one(
    `INSERT INTO rfqs(ref,${RFQ_FIELDS.join(',')},created_by) VALUES($1,${RFQ_FIELDS.map((_, i) => `$${i + 2}`).join(',')},$${RFQ_FIELDS.length + 2}) RETURNING *`,
    [ref, ...vals, userId || null]
  );
  if (data.invites?.length) await setInvites(rfq.id, data.invites);
  return rfq;
}

/** Create a linked alternative of an RFQ (e.g. the same shipment by air) to offer as a quote option. */
export async function duplicateRfq(id, { mode }, userId) {
  const src = await one('SELECT * FROM rfqs WHERE id=$1', [id]);
  const copy = Object.fromEntries(RFQ_FIELDS.map((f) => [f, src[f]]));
  copy.mode = mode || src.mode;
  copy.parent_rfq_id = src.parent_rfq_id || src.id;
  copy.source_email_id = null;
  if (copy.mode === 'AIR') copy.legs = (src.legs || []).map((l) => l); // same legs; containers are ignored for air
  const created = await createRfq(copy, userId);
  await q("UPDATE rfqs SET status='draft' WHERE id=$1", [created.id]);
  return created;
}

export async function updateRfq(id, data) {
  const sets = [];
  const vals = [];
  for (const f of RFQ_FIELDS) {
    if (f in data) {
      vals.push(f === 'containers' ? JSON.stringify(data[f] || []) : clean(data[f]));
      sets.push(`${f}=$${vals.length}`);
    }
  }
  if (sets.length) {
    vals.push(id);
    await q(`UPDATE rfqs SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
  }
  if (data.invites) await setInvites(id, data.invites);
  return one('SELECT * FROM rfqs WHERE id=$1', [id]);
}

/** invites: [{ agent_id, legs: [] }] — adds new and updates unsent ones; never removes sent invites. */
export async function setInvites(rfqId, invitesIn) {
  const rfq = await one('SELECT requester_id FROM rfqs WHERE id=$1', [rfqId]);
  // never ask the requester to quote on their own enquiry
  const invites = invitesIn.filter((i) => Number(i.agent_id) !== rfq?.requester_id);
  const existing = await q('SELECT * FROM rfq_invites WHERE rfq_id=$1', [rfqId]);
  const keep = new Set(invites.map((i) => Number(i.agent_id)));
  for (const e of existing) if (!keep.has(e.agent_id) && e.status === 'pending') await q('DELETE FROM rfq_invites WHERE id=$1', [e.id]);
  for (const inv of invites) {
    const ex = existing.find((e) => e.agent_id === Number(inv.agent_id));
    if (ex) {
      if (ex.status === 'pending') await q('UPDATE rfq_invites SET legs=$1 WHERE id=$2', [inv.legs || [], ex.id]);
    } else {
      await q('INSERT INTO rfq_invites(rfq_id,agent_id,tag,legs) VALUES($1,$2,$3,$4)', [rfqId, inv.agent_id, randomTag(), inv.legs || []]);
    }
  }
}

export async function loadRfq(id) {
  const rfq = await one(
    `SELECT r.*, p.company AS requester_name, p.email AS requester_email, p.contact AS requester_contact, p.country AS requester_country
     FROM rfqs r LEFT JOIN agents p ON p.id=r.requester_id WHERE r.id=$1`,
    [id]
  );
  if (!rfq) return null;
  const invites = await q(
    `SELECT i.*, a.company AS agent_company, a.contact AS agent_contact, a.email AS agent_email, a.country AS agent_country
     FROM rfq_invites i JOIN agents a ON a.id=i.agent_id WHERE i.rfq_id=$1 ORDER BY i.id`,
    [id]
  );
  const quotes = await q('SELECT * FROM agent_quotes WHERE rfq_id=$1 ORDER BY id', [id]);
  const lines = quotes.length ? await q('SELECT * FROM quote_lines WHERE agent_quote_id = ANY($1) ORDER BY sort, id', [quotes.map((x) => x.id)]) : [];
  for (const qt of quotes) {
    qt.lines = lines.filter((l) => l.agent_quote_id === qt.id);
    const inv = invites.find((i) => i.id === qt.invite_id);
    qt.agent = { company: inv?.agent_company };
  }
  const emails = await q(
    `SELECT e.id,e.direction,e.kind,e.invite_id,e.from_addr,e.to_addr,e.subject,e.body_text,e.at,e.parse_status,e.parse_error,
      (SELECT coalesce(json_agg(json_build_object('id',a.id,'filename',a.filename,'size',a.size,'content_type',a.content_type)),'[]') FROM attachments a WHERE a.email_id=e.id) AS attachments
     FROM emails e WHERE e.rfq_id=$1 ORDER BY e.at`,
    [id]
  );
  const customerQuotes = await q('SELECT * FROM customer_quotes WHERE rfq_id=$1 ORDER BY id DESC', [id]);
  const sourceEmail = rfq.source_email_id ? emails.find((e) => e.id === rfq.source_email_id) || null : null;
  const root = rfq.parent_rfq_id || rfq.id;
  const linked = await q('SELECT id, ref, mode, status FROM rfqs WHERE (id=$1 OR parent_rfq_id=$1) AND id<>$2 ORDER BY id', [root, rfq.id]);
  return { rfq, invites, quotes, emails, customerQuotes, sourceEmail, linked };
}

export async function compareRfq(id, currency) {
  const data = await loadRfq(id);
  const fx = await getFx();
  return compare(data.rfq, data.invites, data.quotes, fx, currency || fx.base);
}

async function ctx(inviteId) {
  const invite = await one('SELECT * FROM rfq_invites WHERE id=$1', [inviteId]);
  const rfq = await one('SELECT * FROM rfqs WHERE id=$1', [invite.rfq_id]);
  const agent = await one('SELECT * FROM agents WHERE id=$1', [invite.agent_id]);
  const mb = await getMailbox(rfq.mailbox_id);
  if (!mb) throw new Error('No mailbox configured. Add one in Settings → Mailboxes.');
  const lastOut = await one("SELECT message_id FROM emails WHERE invite_id=$1 AND direction='out' ORDER BY id LIMIT 1", [invite.id]);
  const lastIn = await one("SELECT message_id FROM emails WHERE invite_id=$1 AND direction='in' AND message_id IS NOT NULL ORDER BY id DESC LIMIT 1", [invite.id]);
  const threadRef = lastIn?.message_id || lastOut?.message_id || invite.message_id;
  return { invite, rfq, agent, mb, threadRef, rootRef: lastOut?.message_id };
}

const toList = (agent) => agent.email;
const ccList = (agent) => agent.cc || undefined;

export async function sendInvite(inviteId) {
  const c = await ctx(inviteId);
  const tpl = rfqEmail(c);
  try {
    const email = await sendMail(c.mb, { to: toList(c.agent), cc: ccList(c.agent), ...tpl }, { kind: 'rfq', rfq_id: c.rfq.id, invite_id: c.invite.id });
    await q("UPDATE rfq_invites SET status='sent', sent_at=now(), message_id=$1, last_error=NULL WHERE id=$2", [email.message_id, c.invite.id]);
    return email;
  } catch (e) {
    await q("UPDATE rfq_invites SET status='failed', last_error=$1 WHERE id=$2", [e.message.slice(0, 500), c.invite.id]);
    throw e;
  }
}

/** Send all pending (or failed) invites of an RFQ. */
export async function sendRfq(rfqId) {
  const rfq = await one('SELECT * FROM rfqs WHERE id=$1', [rfqId]);
  if (!rfq.mailbox_id) {
    const mb = await getMailbox();
    if (mb) await q('UPDATE rfqs SET mailbox_id=$1 WHERE id=$2', [mb.id, rfqId]);
  }
  const pending = await q("SELECT id FROM rfq_invites WHERE rfq_id=$1 AND status IN ('pending','failed')", [rfqId]);
  const results = [];
  for (const p of pending) {
    try {
      await sendInvite(p.id);
      results.push({ invite_id: p.id, ok: true });
    } catch (e) {
      results.push({ invite_id: p.id, ok: false, error: e.message });
    }
  }
  if (results.some((r) => r.ok)) await q("UPDATE rfqs SET status=CASE WHEN status='draft' THEN 'sent' ELSE status END WHERE id=$1", [rfqId]);
  return results;
}

export async function remindInvite(inviteId) {
  const c = await ctx(inviteId);
  const tpl = reminderEmail(c);
  const email = await sendMail(c.mb, { to: toList(c.agent), cc: ccList(c.agent), ...tpl, inReplyTo: c.threadRef, references: c.rootRef ? [c.rootRef] : undefined }, { kind: 'reminder', rfq_id: c.rfq.id, invite_id: c.invite.id });
  await q("UPDATE rfq_invites SET status='reminded', reminder_count=reminder_count+1, last_reminder_at=now() WHERE id=$1", [c.invite.id]);
  return email;
}

export async function counterInvite(inviteId, message) {
  const c = await ctx(inviteId);
  const tpl = counterEmail({ ...c, message });
  return sendMail(c.mb, { to: toList(c.agent), cc: ccList(c.agent), ...tpl, inReplyTo: c.threadRef, references: c.rootRef ? [c.rootRef] : undefined }, { kind: 'counter', rfq_id: c.rfq.id, invite_id: c.invite.id });
}

/** Scheduled: remind agents who have not replied after the mailbox's reminder interval. */
export async function autoRemind() {
  const due = await q(
    `SELECT i.id FROM rfq_invites i JOIN rfqs r ON r.id=i.rfq_id JOIN mailboxes m ON m.id=r.mailbox_id
     WHERE i.status IN ('sent','reminded') AND r.status IN ('sent','quoting')
       AND i.reminder_count < m.max_reminders AND m.reminder_hours > 0
       AND coalesce(i.last_reminder_at, i.sent_at) < now() - (m.reminder_hours || ' hours')::interval
       AND (r.deadline IS NULL OR r.deadline > now())`
  );
  for (const d of due) {
    try { await remindInvite(d.id); } catch (e) { console.error('auto-remind failed', d.id, e.message); }
  }
  return due.length;
}

/** An invite that did not go out by email (own rates, rate cards). Reuses an existing invite for that party. */
export async function systemInvite(rfqId, agentId, source) {
  const ex = await one('SELECT * FROM rfq_invites WHERE rfq_id=$1 AND agent_id=$2', [rfqId, agentId]);
  if (ex) return ex;
  const rfq = await one('SELECT legs FROM rfqs WHERE id=$1', [rfqId]);
  return one("INSERT INTO rfq_invites(rfq_id,agent_id,tag,legs,status,replied_at,source) VALUES($1,$2,$3,$4,'replied',now(),$5) RETURNING *", [rfqId, agentId, randomTag(), rfq.legs, source]);
}

export async function ownParty() {
  return (await one("SELECT * FROM agents WHERE source='internal' LIMIT 1")) ||
    one("INSERT INTO agents(company, is_agent, is_customer, source, active, notes) VALUES('Our own rates', false, false, 'internal', true, 'System entry for your own buy rates') RETURNING *");
}

/** Our own buy rates as a pseudo-agent, so they appear in the comparison like any other quote. */
export async function ownRatesInvite(rfqId) {
  const party = await ownParty();
  return systemInvite(rfqId, party.id, 'own');
}

const isInternal = async (inviteId) => !!(await one("SELECT 1 FROM rfq_invites i JOIN agents a ON a.id=i.agent_id WHERE i.id=$1 AND a.source='internal'", [inviteId]));

/**
 * Award: confirm winning agent(s) per leg and send regret mails to the rest.
 * selection: { [leg]: agentQuoteId }
 */
export async function awardRfq(rfqId, selection, { sendRegrets = true, note } = {}) {
  const quotes = await q('SELECT id, invite_id FROM agent_quotes WHERE rfq_id=$1', [rfqId]);
  const legsByInvite = {};
  for (const [leg, qid] of Object.entries(selection)) {
    const qt = quotes.find((x) => x.id === Number(qid));
    if (!qt) throw new Error(`Quote ${qid} not part of this RFQ`);
    (legsByInvite[qt.invite_id] ??= []).push(leg);
  }
  const results = [];
  for (const [inviteId, legs] of Object.entries(legsByInvite)) {
    if (await isInternal(Number(inviteId))) {
      await q("UPDATE rfq_invites SET awarded=true, status='awarded' WHERE id=$1", [inviteId]);
      results.push({ invite_id: Number(inviteId), award: true, ok: true, internal: true });
      continue;
    }
    try {
      const c = await ctx(Number(inviteId));
      await sendMail(c.mb, { to: toList(c.agent), cc: ccList(c.agent), ...awardEmail({ ...c, legs, note }), inReplyTo: c.threadRef, references: c.rootRef ? [c.rootRef] : undefined }, { kind: 'award', rfq_id: rfqId, invite_id: c.invite.id });
      await q("UPDATE rfq_invites SET awarded=true, status='awarded' WHERE id=$1", [inviteId]);
      results.push({ invite_id: Number(inviteId), award: true, ok: true });
    } catch (e) {
      results.push({ invite_id: Number(inviteId), award: true, ok: false, error: e.message });
    }
  }
  if (sendRegrets) {
    // only agents we actually emailed get a regret note (not rate-card or own-rate entries)
    const losers = await q("SELECT id FROM rfq_invites WHERE rfq_id=$1 AND NOT awarded AND status IN ('replied','reminded','sent') AND source='email'", [rfqId]);
    for (const l of losers) {
      if (legsByInvite[l.id]) continue;
      if (await isInternal(l.id)) continue;
      try {
        const c = await ctx(l.id);
        if (c.invite.status === 'replied') await sendMail(c.mb, { to: toList(c.agent), ...regretEmail(c), inReplyTo: c.threadRef }, { kind: 'regret', rfq_id: rfqId, invite_id: l.id });
        await q("UPDATE rfq_invites SET status='closed' WHERE id=$1", [l.id]);
        results.push({ invite_id: l.id, regret: true, ok: true });
      } catch (e) {
        results.push({ invite_id: l.id, regret: true, ok: false, error: e.message });
      }
    }
  }
  await q("UPDATE rfqs SET status='awarded' WHERE id=$1", [rfqId]);
  return results;
}
