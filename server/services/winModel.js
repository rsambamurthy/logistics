// Win-probability margin: learns from this company's won and lost quotes (engines/winModel.js).
import { q, one, currentTenant } from '../db.js';
import { learningCache } from '../lib/learningCache.js';
import { fitWinModel, adviseMargin } from '../engines/winModel.js';
import { laneOf } from '../engines/agentRank.js';
import { getSetting, getApprovalLevels } from './settings.js';

const cache = learningCache();
const TTL = 10 * 60 * 1000;

/** Effective margin of the option the customer took (or the best-priced option when lost). */
function marginOf(cq) {
  const opts = cq.snapshot?.options || [];
  const o = opts[cq.accepted_option ?? 0] || opts[0];
  const m = o?.totals?.margin_pct_effective ?? cq.margin_pct;
  return m === null || m === undefined ? null : Number(m);
}

async function model() {
  const t = currentTenant();
  const hit = cache.get(t?.id);
  if (hit && Date.now() - hit.at < TTL) return hit.model;
  const rows = await q(`SELECT c.status, c.margin_pct, c.snapshot, c.accepted_option, c.valid_until, r.requester_id, r.mode, r.pol, r.pod
    FROM customer_quotes c JOIN rfqs r ON r.id=c.rfq_id
    WHERE c.sent_at IS NOT NULL AND c.created_at > now() - interval '24 months'
      AND (c.status IN ('accepted','lost','expired') OR (c.status='sent' AND c.valid_until < now() - interval '7 days'))`);
  const samples = rows.map((c) => ({
    margin: marginOf(c), won: c.status === 'accepted',
    weight: c.status === 'sent' || c.status === 'expired' ? 0.5 : 1, // expired without an answer: counted as half a loss
    customer: c.requester_id ? String(c.requester_id) : null, lane: laneOf(c),
  })).filter((s) => s.margin !== null);
  const pricing = await getSetting('pricing');
  const m = fitWinModel(samples, { defaultMargin: Number(pricing.default_margin_pct ?? 10) });
  cache.set(t?.id, { at: Date.now(), model: m });
  return m;
}

/** Margin advice for an RFQ: buy = buy cost of the option in the quote currency. */
export async function marginAdvice(rfqId, { buy, current }) {
  const rfq = await one('SELECT id, requester_id, mode, pol, pod FROM rfqs WHERE id=$1', [rfqId]);
  if (!rfq) throw Object.assign(new Error('RFQ not found'), { status: 404 });
  const m = await model();
  const advice = adviseMargin(m, { buy: Number(buy) || 0, customer: rfq.requester_id ? String(rfq.requester_id) : null, lane: laneOf(rfq), current });
  // say when the best margin needs approval
  const level = (await getApprovalLevels()).filter((l) => advice.best.margin < Number(l.below_pct)).sort((a, b) => a.below_pct - b.below_pct)[0];
  if (level) advice.reasons.push(`At ${advice.best.margin}% the quote needs approval (below ${level.below_pct}%).`);
  return advice;
}
