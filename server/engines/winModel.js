// Win-probability margin (pure). Learns from won and lost customer quotes how the chance of
// winning falls as the margin rises, with a customer and a lane adjustment, and suggests the
// margin with the best expected profit: P(win | margin) × buy cost × margin.
//
// Model: logit P(win) = a + b·margin + customer offset + lane offset. a and b are fitted by
// maximum a posteriori (logistic regression with a prior), so with little history the advice stays
// close to the company's usual margin and gets sharper as quotes are won and lost.

const sig = (z) => 1 / (1 + Math.exp(-z));
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * samples: [{ margin, won (bool), weight?, customer?, lane? }]
 * opts: { defaultMargin = 10 }
 */
export function fitWinModel(samples, { defaultMargin = 10 } = {}) {
  // prior: 50 % chance at the usual margin, with a slope that makes the usual margin the best one
  // (for a logistic curve, expected profit peaks where margin = 2 / |slope| at a 50 % chance)
  const dm = Math.max(2, Number(defaultMargin || 10));
  const b0 = -2 / dm;
  const a0 = -b0 * dm;
  const pa = 1 / 1.5 ** 2; // prior precisions
  const pb = 1 / 0.08 ** 2;
  let a = a0;
  let b = b0;
  const data = samples.filter((s) => Number.isFinite(Number(s.margin))).map((s) => ({ ...s, x: Number(s.margin), y: s.won ? 1 : 0, w: Number(s.weight ?? 1) }));
  // Newton–Raphson on the 2 parameters
  for (let it = 0; it < 50; it++) {
    let ga = -pa * (a - a0);
    let gb = -pb * (b - b0);
    let haa = -pa;
    let hbb = -pb;
    let hab = 0;
    for (const d of data) {
      const p = sig(a + b * d.x);
      ga += d.w * (d.y - p);
      gb += d.w * (d.y - p) * d.x;
      const v = d.w * p * (1 - p);
      haa -= v; hbb -= v * d.x * d.x; hab -= v * d.x;
    }
    const det = haa * hbb - hab * hab;
    if (!det) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a -= da; b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-7) break;
  }
  b = Math.min(b, -0.01); // a higher margin never makes winning more likely
  // shrunken offsets per customer and lane (one Newton step with a prior of strength 2)
  const offsets = (key) => {
    const g = {};
    for (const d of data) {
      if (!d[key]) continue;
      const p = sig(a + b * d.x);
      const o = (g[d[key]] ??= { num: 0, den: 2, n: 0 });
      o.num += d.w * (d.y - p); o.den += d.w * p * (1 - p); o.n += 1;
    }
    return Object.fromEntries(Object.entries(g).map(([k, o]) => [k, { offset: o.num / o.den, n: o.n }]));
  };
  const won = data.filter((d) => d.y).length;
  return { a, b, customer: offsets('customer'), lane: offsets('lane'), n: data.length, won, lost: data.length - won, defaultMargin: Number(defaultMargin || 10) };
}

export function winProbability(model, margin, { customer, lane } = {}) {
  const z = model.a + model.b * Number(margin) + (model.customer[customer]?.offset || 0) + (model.lane[lane]?.offset || 0);
  return sig(z);
}

/**
 * Margin advice for one quote. buy = buy cost of the option; floor/ceiling bound the search.
 * Returns the best margin, its win chance and expected profit, the curve, and the current margin's numbers.
 */
export function adviseMargin(model, { buy, customer, lane, current, floor = 0, ceiling = 60, step = 0.5 }) {
  const curve = [];
  for (let m = Math.max(0, floor); m <= ceiling + 1e-9; m += step) {
    const p = winProbability(model, m, { customer, lane });
    curve.push({ margin: r2(m), p: r2(p), profit: r2((Number(buy) * m) / 100), expected: r2((p * Number(buy) * m) / 100) });
  }
  const best = curve.reduce((x, y) => (y.expected > x.expected ? y : x), curve[0]);
  const at = (m) => { const p = winProbability(model, m, { customer, lane }); return { margin: r2(m), p: r2(p), profit: r2((Number(buy) * m) / 100), expected: r2((p * Number(buy) * m) / 100) }; };
  const confidence = model.n >= 30 ? 'good' : model.n >= 10 ? 'fair' : 'low';
  const reasons = [];
  reasons.push(model.n ? `Learnt from ${model.n} decided quote${model.n > 1 ? 's' : ''} (${model.won} won, ${model.lost} lost).` : `No won or lost quotes yet: based on your usual ${model.defaultMargin}% margin.`);
  const c = model.customer[customer];
  if (c && c.n >= 2) reasons.push(c.offset > 0.2 ? `This customer accepts more often than average (${c.n} quotes).` : c.offset < -0.2 ? `This customer is price-sensitive: fewer quotes accepted (${c.n} quotes).` : `This customer behaves like your average (${c.n} quotes).`);
  const l = model.lane[lane];
  if (l && l.n >= 2) reasons.push(l.offset > 0.2 ? `You win more often on this lane (${l.n} quotes).` : l.offset < -0.2 ? `This lane is competitive: you win less often (${l.n} quotes).` : `Usual win rate on this lane (${l.n} quotes).`);
  return { best, current: current !== undefined && current !== null ? at(Number(current)) : null, curve, confidence, n: model.n, reasons };
}
