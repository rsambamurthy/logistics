// Reports: win rate, margin, response time, lost reasons, customers, lanes, partner-agent performance.
import { q } from '../db.js';
import { compare } from '../engines/costing.js';
import { getFx } from './settings.js';

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

export async function reports({ days = 90 } = {}) {
  const d = Math.min(Math.max(Number(days) || 90, 1), 3650);
  const fx = await getFx();

  // final quotes per RFQ (latest non-superseded) sent in the period
  const quotes = await q(
    `SELECT cq.*, r.requester_id, r.requester_role, r.pol, r.pod, r.mode, r.created_at AS rfq_created, p.company AS requester
     FROM customer_quotes cq JOIN rfqs r ON r.id=cq.rfq_id LEFT JOIN agents p ON p.id=r.requester_id
     WHERE cq.status IN ('sent','accepted','lost','expired') AND coalesce(cq.sent_at, cq.created_at) >= now() - ($1 || ' days')::interval`,
    [String(d)]
  );
  // convert profits to base currency so they can be added up
  const toBase = (amt, cur) => {
    if (!amt) return 0;
    if (cur === fx.base) return Number(amt);
    const rate = fx.rates?.[cur];
    return rate ? Number(amt) * rate : 0;
  };
  const tally = () => ({ quotes: 0, won: 0, lost: 0, expired: 0, open: 0, profit_won: 0, sell_won: 0, margin_sum: 0 });
  const add = (t, x) => {
    t.quotes++;
    if (x.status === 'accepted') { t.won++; t.profit_won += toBase(x.snapshot?.totals?.profit, x.currency); t.sell_won += toBase(x.snapshot?.totals?.sell, x.currency); }
    else if (x.status === 'lost') t.lost++;
    else if (x.status === 'expired') t.expired++;
    else t.open++;
    t.margin_sum += Number(x.snapshot?.totals?.margin_pct_effective || 0);
  };
  const finish = (t) => ({ ...t, win_rate: pct(t.won, t.won + t.lost + t.expired), avg_margin_pct: t.quotes ? r2(t.margin_sum / t.quotes) : null, profit_won: r2(t.profit_won), sell_won: r2(t.sell_won), margin_sum: undefined });

  const total = tally();
  const byRequester = new Map();
  const byLane = new Map();
  for (const x of quotes) {
    add(total, x);
    const rk = x.requester_id || 0;
    if (!byRequester.has(rk)) byRequester.set(rk, { name: x.requester || 'Unknown', role: x.requester_role, ...tally() });
    add(byRequester.get(rk), x);
    const lk = `${x.mode}|${x.pol || '?'}|${x.pod || '?'}`;
    if (!byLane.has(lk)) byLane.set(lk, { mode: x.mode, pol: x.pol, pod: x.pod, ...tally() });
    add(byLane.get(lk), x);
  }

  const lostReasons = await q(
    `SELECT coalesce(lost_reason,'Not recorded') AS reason, count(*)::int AS n FROM customer_quotes
     WHERE status='lost' AND decided_at >= now() - ($1 || ' days')::interval GROUP BY 1 ORDER BY 2 DESC`,
    [String(d)]
  );

  const response = (await q(
    `SELECT round(avg(extract(epoch FROM (first_sent - r.created_at))/3600)::numeric,1) AS avg_hours, count(*)::int AS n
     FROM (SELECT rfq_id, min(sent_at) AS first_sent FROM customer_quotes WHERE sent_at IS NOT NULL GROUP BY rfq_id) f
     JOIN rfqs r ON r.id=f.rfq_id WHERE r.created_at >= now() - ($1 || ' days')::interval`,
    [String(d)]
  ))[0];

  // partner agents: reply rate, speed, how often cheapest, wins
  const agents = await q(
    `SELECT a.id, a.company, count(i.id)::int AS invited, count(i.replied_at)::int AS replied,
       round(avg(extract(epoch FROM (i.replied_at - i.sent_at))/3600)::numeric,1) AS avg_reply_hours,
       count(*) FILTER (WHERE i.awarded)::int AS won
     FROM rfq_invites i JOIN agents a ON a.id=i.agent_id JOIN rfqs r ON r.id=i.rfq_id
     WHERE i.source='email' AND r.created_at >= now() - ($1 || ' days')::interval
     GROUP BY a.id ORDER BY invited DESC`,
    [String(d)]
  );
  const cheapest = new Map();
  const rfqs = await q(`SELECT * FROM rfqs WHERE created_at >= now() - ($1 || ' days')::interval ORDER BY id DESC LIMIT 500`, [String(d)]);
  if (rfqs.length) {
    const ids = rfqs.map((r) => r.id);
    const invites = await q('SELECT i.*, a.company AS agent_company FROM rfq_invites i JOIN agents a ON a.id=i.agent_id WHERE i.rfq_id = ANY($1)', [ids]);
    const aq = await q('SELECT * FROM agent_quotes WHERE rfq_id = ANY($1) AND NOT superseded', [ids]);
    const lines = aq.length ? await q('SELECT * FROM quote_lines WHERE agent_quote_id = ANY($1)', [aq.map((x) => x.id)]) : [];
    for (const x of aq) x.lines = lines.filter((l) => l.agent_quote_id === x.id);
    for (const rfq of rfqs) {
      const inv = invites.filter((i) => i.rfq_id === rfq.id);
      const qs = aq.filter((x) => x.rfq_id === rfq.id);
      if (qs.length < 2) continue;
      try {
        const c = compare(rfq, inv, qs, fx);
        for (const b of Object.values(c.bestPerLeg)) {
          const i = inv.find((v) => v.id === b.inviteId);
          if (i) cheapest.set(i.agent_id, (cheapest.get(i.agent_id) || 0) + 1);
        }
      } catch { /* missing FX: skip */ }
    }
  }

  return {
    days: d,
    currency: fx.base,
    summary: { ...finish(total), avg_response_hours: response?.avg_hours ?? null },
    by_requester: [...byRequester.values()].map(finish).sort((a, b) => b.quotes - a.quotes),
    by_lane: [...byLane.values()].map(finish).sort((a, b) => b.quotes - a.quotes).slice(0, 50),
    lost_reasons: lostReasons,
    agents: agents.map((a) => ({ ...a, reply_rate: pct(a.replied, a.invited), cheapest_legs: cheapest.get(a.id) || 0 })),
  };
}
