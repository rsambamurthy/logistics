// Smart agent selection: builds each partner agent's history from past RFQs and ranks them for a
// new request (engines/agentRank.js). Cached briefly per company.
import { q } from '../db.js';
import { learningCache } from '../lib/learningCache.js';
import { currentTenant } from '../db.js';
import { rankAgents, laneOf } from '../engines/agentRank.js';
import { quoteTotals } from '../engines/costing.js';
import { getFx } from './settings.js';

const cache = learningCache();
const TTL = 10 * 60 * 1000;
export const clearAgentHistory = () => cache.delete(currentTenant()?.id);

/** One row per invite in the last 18 months, with lane, reply, price rank and booking outcome. */
export async function agentHistory() {
  const t = currentTenant();
  const hit = cache.get(t?.id);
  if (hit && Date.now() - hit.at < TTL) return hit.rows;
  const invites = await q(`SELECT i.id, i.agent_id, i.rfq_id, i.legs, i.status, i.sent_at, i.replied_at, i.awarded,
      r.mode, r.pol, r.pod, r.gross_weight_kg, r.volume_cbm, r.containers, r.packages, r.package_type,
      (SELECT b.status FROM bookings b WHERE b.invite_id=i.id ORDER BY b.id DESC LIMIT 1) AS booking
    FROM rfq_invites i JOIN rfqs r ON r.id=i.rfq_id
    WHERE i.sent_at > now() - interval '18 months' AND coalesce(i.source,'email') <> 'internal'`);
  const quotes = invites.length ? await q('SELECT * FROM agent_quotes WHERE invite_id = ANY($1) AND NOT superseded', [invites.map((i) => i.id)]) : [];
  const lines = quotes.length ? await q('SELECT * FROM quote_lines WHERE agent_quote_id = ANY($1)', [quotes.map((x) => x.id)]) : [];
  const fx = await getFx();
  const byInvite = {};
  for (const qt of quotes) byInvite[qt.invite_id] = { ...qt, lines: lines.filter((l) => l.agent_quote_id === qt.id) };
  // price rank per RFQ and leg among the agents that quoted it (0 = cheapest, 1 = dearest)
  const rank = {};
  const byRfq = {};
  for (const i of invites) (byRfq[i.rfq_id] ??= []).push(i);
  for (const list of Object.values(byRfq)) {
    const legTotals = {};
    for (const i of list) {
      const qt = byInvite[i.id];
      if (!qt || qt.declined) continue;
      const tot = quoteTotals(qt, i, fx);
      for (const [leg, v] of Object.entries(tot.legs)) if (v.total > 0) (legTotals[leg] ??= []).push({ invite: i.id, total: v.total });
    }
    for (const arr of Object.values(legTotals)) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => a.total - b.total);
      arr.forEach((x, k) => (rank[x.invite] ??= []).push(k / (arr.length - 1)));
    }
  }
  const rows = invites.map((i) => {
    const qt = byInvite[i.id];
    const replied = !!i.replied_at || !!qt;
    const ranks = rank[i.id];
    return {
      invite_id: i.id, agent_id: i.agent_id, sent_at: i.sent_at, lane: laneOf(i), replied, declined: !!qt?.declined, awarded: !!i.awarded,
      reply_hours: i.replied_at && i.sent_at ? (new Date(i.replied_at) - new Date(i.sent_at)) / 3600000 : null,
      price_rank: ranks?.length ? ranks.reduce((s, x) => s + x, 0) / ranks.length : null,
      booking: i.booking || null,
    };
  });
  cache.set(t?.id, { at: Date.now(), rows });
  return rows;
}

/** Ranked partner agents for a request: { mode, pol, pod, legs, places, exclude, pick }. */
export async function suggestAgents({ mode, pol, pod, legs = [], places = [], exclude = 0, pick = 4 }) {
  const agents = await q('SELECT * FROM agents WHERE active AND is_agent AND id <> $1', [Number(exclude) || 0]);
  return rankAgents(agents, await agentHistory(), { mode, pol, pod, legs, places }, { pick: Number(pick) || 4 });
}
