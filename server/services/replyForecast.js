// Reply prediction & chasing: when each agent usually answers, how likely they still will, and when
// to send a reminder. One helper (forecastInvite) serves the RFQ screen and the automatic reminders.
import { q, one } from '../db.js';
import { agentHistory } from './agentRank.js';
import { replyForecast, readyToCompare } from '../engines/planning.js';

const H = 3600e3;
const OPEN = ['sent', 'reminded'];

/** history of one agent, without this invite and without invites still too new to judge. */
function historyOf(hist, invite) {
  const weekAgo = Date.now() - 7 * 24 * H;
  return hist.filter((h) => h.agent_id === invite.agent_id && h.invite_id !== invite.id && (h.replied || (h.sent_at && new Date(h.sent_at).getTime() < weekAgo)));
}

/**
 * Forecast for one open invite. Agents with fewer than 3 past replies are chased on the mailbox's
 * reminder interval; others when they are later than 3 in 4 of their own replies.
 */
export function forecastInvite(invite, hist, mailboxHours = 24, now = Date.now()) {
  const own = historyOf(hist, invite);
  const sent = new Date(invite.sent_at).getTime();
  const lastContact = new Date(invite.last_reminder_at || invite.sent_at).getTime();
  const f = replyForecast(own, (now - sent) / H, { remindersSent: invite.reminder_count || 0 });
  const learnt = own.filter((h) => h.replied && h.reply_hours !== null).length >= 3;
  const chaseAfter = learnt ? f.chase_after_hours : Number(mailboxHours) || 24;
  const chaseAt = lastContact + chaseAfter * H;
  return { ...f, learnt, chase_after_hours: chaseAfter, chase_at: new Date(chaseAt).toISOString(), due_to_chase: now >= chaseAt };
}

/** Forecasts for the open invites of an RFQ and whether there are enough quotes to compare. */
export async function replyInsights(rfqId) {
  const rfq = await one('SELECT r.id, m.reminder_hours FROM rfqs r LEFT JOIN mailboxes m ON m.id=r.mailbox_id WHERE r.id=$1', [rfqId]);
  if (!rfq) return { invites: {}, ready: null };
  const invites = await q('SELECT * FROM rfq_invites WHERE rfq_id=$1', [rfqId]);
  const hist = await agentHistory();
  const out = {};
  for (const i of invites) if (OPEN.includes(i.status) && i.sent_at) out[i.id] = forecastInvite(i, hist, rfq.reminder_hours);
  const quoted = await one('SELECT count(DISTINCT invite_id)::int AS n FROM agent_quotes WHERE rfq_id=$1 AND NOT superseded AND NOT declined', [rfqId]);
  return { invites: out, ready: readyToCompare(quoted.n, Object.values(out)) };
}

/** Open invites that are due a reminder now (used by the automatic reminder run). */
export async function invitesDueToChase() {
  const rows = await q(
    `SELECT i.*, m.reminder_hours FROM rfq_invites i JOIN rfqs r ON r.id=i.rfq_id JOIN mailboxes m ON m.id=r.mailbox_id
     WHERE i.status IN ('sent','reminded') AND r.status IN ('sent','quoting') AND coalesce(i.source,'email')='email'
       AND i.reminder_count < m.max_reminders AND m.reminder_hours > 0 AND i.sent_at IS NOT NULL
       AND coalesce(i.last_reminder_at, i.sent_at) < now() - interval '4 hours'
       AND (r.deadline IS NULL OR r.deadline > now())`
  );
  if (!rows.length) return [];
  const hist = await agentHistory();
  return rows.filter((i) => forecastInvite(i, hist, i.reminder_hours).due_to_chase).map((i) => i.id);
}
