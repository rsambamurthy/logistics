// Smart agent selection (pure). Scores partner agents for an RFQ from their history:
// reply rate, reply speed, price competitiveness, award rate and booking reliability, measured
// on the same lane where there is enough history and overall otherwise. Small samples are pulled
// towards a neutral prior, so one lucky reply does not put an agent on top. One "explore" slot
// goes to an agent with little history on the lane, so new agents get a fair chance.

const WEIGHTS = { reply: 0.3, speed: 0.15, price: 0.3, win: 0.15, reliability: 0.1 };
const r1 = (n) => Math.round(n * 10) / 10;

const normPlace = (s) => {
  const t = String(s || '').toUpperCase();
  const code = t.match(/\b([A-Z]{5})\b/) || t.match(/\(([A-Z]{3})\)/) || t.match(/\b([A-Z]{3})\b/);
  return code ? code[1].slice(-3) : t.replace(/[^A-Z]/g, '').slice(0, 12);
};
export const laneOf = (r) => `${r.mode || ''}|${normPlace(r.pol)}|${normPlace(r.pod)}`;

/** Beta-smoothed rate: (hits + prior·m) / (n + m). */
const smooth = (hits, n, prior = 0.5, m = 2) => (hits + prior * m) / (n + m);

function stats(rows) {
  const invited = rows.length;
  const replied = rows.filter((r) => r.replied).length;
  const quoted = rows.filter((r) => r.replied && !r.declined).length;
  const awarded = rows.filter((r) => r.awarded).length;
  const hours = rows.filter((r) => r.reply_hours !== null && r.reply_hours !== undefined).map((r) => Number(r.reply_hours)).sort((a, b) => a - b);
  const median = hours.length ? hours[Math.floor(hours.length / 2)] : null;
  const ranks = rows.filter((r) => r.price_rank !== null && r.price_rank !== undefined).map((r) => Number(r.price_rank));
  const priceAvg = ranks.length ? ranks.reduce((s, x) => s + x, 0) / ranks.length : null;
  const booked = rows.filter((r) => r.booking === 'confirmed').length;
  const failed = rows.filter((r) => r.booking === 'cancelled').length;
  return { invited, replied, quoted, awarded, median, priceAvg, priced: ranks.length, booked, failed };
}

/** Blend lane and overall values: lane counts more as its sample grows. */
const blend = (lane, all, n) => (lane === null ? all : all === null ? lane : (lane * n + all * 3) / (n + 3));

/**
 * agents: [{ id, company, services: [legs], ports, city, country }]
 * history: [{ agent_id, lane, replied, declined, awarded, reply_hours, price_rank (0 cheapest … 1 dearest), booking }]
 * ctx: { mode, pol, pod, legs: [], places: [] }
 * Returns agents (only those covering the request) with score 0-100, parts, reasons, recommended / explore flags.
 */
export function rankAgents(agents, history, ctx, { pick = 4 } = {}) {
  const lane = laneOf(ctx);
  const legs = ctx.legs || [];
  const places = (ctx.places || []).map((p) => String(p).toLowerCase());
  const laneInvites = history.filter((h) => h.lane === lane).length;
  const out = [];
  for (const a of agents) {
    const legHits = legs.filter((l) => (a.services || []).includes(l));
    const text = `${a.ports || ''} ${a.city || ''} ${a.country || ''}`.toLowerCase();
    const placeHits = places.filter((p) => p.split(/[\s,()]+/).some((w) => w.length > 2 && text.includes(w))).length;
    const rows = history.filter((h) => h.agent_id === a.id);
    const laneRows = rows.filter((h) => h.lane === lane);
    // must cover what is asked, or have worked this lane before
    if (legs.length && !legHits.length && (a.services || []).length && !laneRows.length) continue;
    if (!legHits.length && !placeHits && !laneRows.length && !rows.length && (a.services || []).length) continue;
    const s = stats(rows);
    const l = stats(laneRows);
    const reply = blend(laneRows.length ? smooth(l.replied, l.invited, 0.5) : null, smooth(s.replied, s.invited, 0.5), l.invited);
    const speedOf = (h) => (h === null ? null : 1 / (1 + h / 24)); // replies within a day score high
    const speed = blend(speedOf(l.median), speedOf(s.median) ?? 0.5, l.invited);
    const priceOf = (st) => (st.priceAvg === null ? null : smooth((1 - st.priceAvg) * st.priced, st.priced, 0.5));
    const price = blend(priceOf(l), priceOf(s) ?? 0.5, l.priced);
    const win = blend(laneRows.length ? smooth(l.awarded, l.quoted, 0.25) : null, smooth(s.awarded, s.quoted, 0.25), l.quoted);
    const reliability = smooth(s.booked, s.booked + s.failed, 0.8, 3);
    const fit = Math.min(1, 0.6 + 0.2 * legHits.length + 0.1 * placeHits + (laneRows.length ? 0.2 : 0));
    const base = WEIGHTS.reply * reply + WEIGHTS.speed * speed + WEIGHTS.price * price + WEIGHTS.win * win + WEIGHTS.reliability * reliability;
    const reasons = [];
    if (l.invited) reasons.push(`${l.replied}/${l.invited} replies on this lane`);
    else if (s.invited) reasons.push(`no history on this lane; ${s.replied}/${s.invited} replies overall`);
    else reasons.push('new agent: no history yet');
    if (l.priced || s.priced) {
      const p = (l.priced ? l : s).priceAvg;
      reasons.push(p <= 0.25 ? 'usually among the cheapest' : p >= 0.75 ? 'usually among the dearest' : 'mid-priced');
    }
    const hrs = l.median ?? s.median;
    if (hrs !== null) reasons.push(hrs < 1 ? 'replies within the hour' : hrs < 48 ? `replies in ~${Math.round(hrs)} h` : `replies in ~${Math.round(hrs / 24)} days`);
    if (s.awarded) reasons.push(`won ${s.awarded} job${s.awarded > 1 ? 's' : ''}`);
    if (s.failed) reasons.push(`${s.failed} booking${s.failed > 1 ? 's' : ''} fell through`);
    out.push({
      ...a,
      suggested_legs: legHits.length ? legHits : legs.filter(() => !(a.services || []).length),
      score: Math.round(base * fit * 100),
      parts: { reply: r1(reply * 100), speed: r1(speed * 100), price: r1(price * 100), win: r1(win * 100), reliability: r1(reliability * 100) },
      lane_invites: l.invited, invited: s.invited, replied: s.replied, won: s.awarded,
      response_rate: s.invited ? Math.round((s.replied / s.invited) * 100) : null,
      // exploration bonus (UCB): agents tried less on this lane get a lift for the explore slot
      explore_score: base * fit + 0.25 * Math.sqrt(Math.log(laneInvites + 2) / (l.invited + 1)),
      reasons,
    });
  }
  out.sort((x, y) => y.score - x.score);
  const proven = out.filter((a) => a.lane_invites >= 3 || a.invited >= 5);
  const top = (proven.length >= pick - 1 ? proven : out).slice(0, Math.max(1, pick - 1));
  const rest = out.filter((a) => !top.includes(a) && a.lane_invites < 3);
  const explore = rest.sort((x, y) => y.explore_score - x.explore_score)[0];
  const chosen = new Set(top.map((a) => a.id));
  if (explore) chosen.add(explore.id);
  for (const a of out.filter((x) => !chosen.has(x.id))) { if (chosen.size >= pick) break; chosen.add(a.id); }
  return out.map((a) => ({ ...a, recommended: chosen.has(a.id), explore: explore?.id === a.id, explore_score: undefined }));
}
