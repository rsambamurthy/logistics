// Consolidation engine (pure functions, no database).
//
// Air: each house (shipper) is charged on its own chargeable weight = max(gross kg, volume kg);
// the airline charges the consol (master) on max(total gross, total volume). Mixing bulky and
// dense cargo makes the master lighter than the sum of the houses: that difference is the
// consolidator's "weight gain".
// Sea LCL: each house pays per W/M (max of cbm and tonnes); the master is a container with a
// fixed cost, so the aim is to fill it (cbm and weight) as fully as possible.
//
// planConsols() is the consolidation agent's algorithm: group compatible jobs by lane and date,
// then pack them into consols that maximise the weight gain (air) or the fill (sea).

export const CM_DIVISOR = 6000; // IATA: L×W×H cm / 6000 = volume kg
export const IN_DIVISOR = 366; // L×W×H inches / 366 = volume kg
export const KG_PER_CBM = 1e6 / CM_DIVISOR; // 166.67
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** Container sizes for sea consols: usable cbm and payload kg. */
export const CONTAINERS = {
  '20GP': { cbm: 28, kg: 21000 },
  '40GP': { cbm: 58, kg: 26000 },
  '40HC': { cbm: 68, kg: 26000 },
};

/** Volume (kg and cbm) of a list of pieces: [{ count, l, w, h, unit: 'cm'|'in', kg }]. */
export function piecesTotals(pieces) {
  let volKg = 0;
  let cbm = 0;
  let kg = 0;
  let count = 0;
  for (const p of pieces || []) {
    const n = Number(p.count || 1);
    const l = Number(p.l || 0);
    const w = Number(p.w || 0);
    const h = Number(p.h || 0);
    const inch = p.unit === 'in';
    volKg += (n * l * w * h) / (inch ? IN_DIVISOR : CM_DIVISOR);
    cbm += (n * l * w * h * (inch ? 16.387064 : 1)) / 1e6;
    kg += n * Number(p.kg || 0);
    count += n;
  }
  return { volKg: r2(volKg), cbm: Math.round(cbm * 1000) / 1000, kg: r2(kg), count };
}

/**
 * Weights of one house. Uses the pieces' dimensions when given, otherwise the shipment's cbm.
 * house: { mode, gross_kg, cbm, pieces }
 */
export function houseWeights(h) {
  const p = h.pieces?.length ? piecesTotals(h.pieces) : null;
  const gross = Number(h.gross_kg || 0) || p?.kg || 0;
  const cbm = p && p.cbm ? p.cbm : Number(h.cbm || 0);
  const volKg = p && p.volKg ? p.volKg : cbm * KG_PER_CBM;
  if (h.mode === 'LCL') {
    const wm = Math.max(cbm, gross / 1000);
    return { gross: r2(gross), cbm: r2(cbm), volKg: r2(volKg), chargeable: r2(wm), unit: 'W/M' };
  }
  return { gross: r2(gross), cbm: r2(cbm), volKg: r2(volKg), chargeable: r2(Math.max(gross, volKg)), unit: 'kg', dense: gross >= volKg };
}

/** Weights of a consol from its houses, plus the weight gain and the "free" capacity left in it. */
export function masterWeights(houses, mode = houses[0]?.mode) {
  const ws = houses.map((h) => houseWeights({ ...h, mode }));
  const gross = ws.reduce((s, w) => s + w.gross, 0);
  const volKg = ws.reduce((s, w) => s + w.volKg, 0);
  const cbm = ws.reduce((s, w) => s + w.cbm, 0);
  const sold = ws.reduce((s, w) => s + w.chargeable, 0);
  if (mode === 'LCL') {
    return { mode, houses: ws.length, gross: r2(gross), cbm: r2(cbm), volKg: r2(volKg), sold: r2(sold), chargeable: null, gain: null, unit: 'W/M' };
  }
  const chargeable = Math.max(gross, volKg);
  return {
    mode, houses: ws.length, gross: r2(gross), volKg: r2(volKg), cbm: r2(cbm), sold: r2(sold), unit: 'kg',
    chargeable: r2(chargeable),
    gain: r2(sold - chargeable), // kg sold to shippers that the airline does not charge for
    // dense cargo up to this many kg flies free (volume already paid); bulky cargo up to this volume kg flies free
    freeWeight: r2(Math.max(0, volKg - gross)),
    freeVolumeKg: r2(Math.max(0, gross - volKg)),
  };
}

/**
 * Money side of a consol. buy: { rate, min, fixed, currency } in the consol's buy currency;
 * houses carry { sell_amount, standalone_cost } already converted to that currency.
 */
export function consolEconomics(houses, buy = {}, mode = houses[0]?.mode) {
  const m = masterWeights(houses, mode);
  const rate = Number(buy.rate || 0);
  const fixed = Number(buy.fixed || 0);
  let cost = null;
  if (mode === 'LCL') cost = fixed || (rate ? rate * m.cbm : null);
  else if (rate || fixed) cost = Math.max(rate * m.chargeable, Number(buy.min || 0)) + fixed;
  const revenue = houses.reduce((s, h) => s + Number(h.sell_amount || 0), 0);
  const standalone = houses.reduce((s, h) => s + Number(h.standalone_cost || 0), 0);
  return {
    ...m,
    cost: cost === null ? null : r2(cost),
    revenue: r2(revenue),
    profit: cost === null ? null : r2(revenue - cost),
    standalone: standalone ? r2(standalone) : null,
    saving: cost !== null && standalone ? r2(standalone - cost) : null,
    gainValue: mode !== 'LCL' && rate ? r2(m.gain * rate) : null,
  };
}

/** Why two houses can't share a consol (null when they can). */
export function incompatibility(a, b) {
  const ta = a.reefer_temp ? String(a.reefer_temp).trim() : '';
  const tb = b.reefer_temp ? String(b.reefer_temp).trim() : '';
  if (ta !== tb) return 'different temperature requirements';
  if (a.dangerous_goods && b.dangerous_goods && a.dg_class && b.dg_class && String(a.dg_class) !== String(b.dg_class)) return `DG class ${a.dg_class} with class ${b.dg_class}`;
  return null;
}

/** Warnings that do not block, but a person should check. */
export function consolWarnings(houses) {
  const out = [];
  if (houses.some((h) => h.dangerous_goods) && houses.some((h) => !h.dangerous_goods)) out.push('Contains dangerous goods with general cargo: check segregation and airline DG acceptance.');
  if (houses.some((h) => h.stackable === false)) out.push('Has non-stackable cargo: volume used may be higher than measured.');
  return out;
}

const normPlace = (s) => {
  const t = String(s || '').toUpperCase();
  const code = t.match(/\b([A-Z]{5})\b/) || t.match(/\(([A-Z]{3})\)/) || t.match(/\b([A-Z]{3})\b/);
  return code ? code[1].slice(-3) : t.replace(/[^A-Z]/g, '').slice(0, 12);
};
export const laneKey = (h) => `${h.mode}|${normPlace(h.origin)}|${normPlace(h.destination)}`;
const day = (d) => (d ? Math.floor(new Date(d).getTime() / 86400000) : null);

/**
 * The consolidation agent's algorithm.
 * jobs: [{ id, mode: 'AIR'|'LCL', origin, destination, ready_date, gross_kg, cbm, pieces, dangerous_goods, dg_class, reefer_temp, ... }]
 * opts: { windowDays = 3, capacityKg (air), container (sea, e.g. '40HC'), rateFor(lane) -> buy rate per kg }
 * Returns { plans: [{ lane, houses: [ids], weights, warnings, reasons }], unplanned: [{ id, reason }] }.
 */
export function planConsols(jobs, opts = {}) {
  const windowDays = opts.windowDays ?? 3;
  const plans = [];
  const unplanned = [];
  const lanes = new Map();
  for (const j of jobs) {
    if (!['AIR', 'LCL'].includes(j.mode)) { unplanned.push({ id: j.id, reason: 'Only air and LCL shipments can be consolidated' }); continue; }
    const w = houseWeights(j);
    if (!w.gross && !w.cbm) { unplanned.push({ id: j.id, reason: 'No weight or volume on the shipment' }); continue; }
    const k = laneKey(j);
    if (!lanes.has(k)) lanes.set(k, []);
    lanes.get(k).push({ ...j, w });
  }
  for (const [lane, list] of lanes) {
    // date windows: cargo ready within `windowDays` of the first in the window (no date = joins the earliest)
    list.sort((a, b) => (day(a.ready_date) ?? -Infinity) - (day(b.ready_date) ?? -Infinity));
    const windows = [];
    for (const j of list) {
      const d = day(j.ready_date);
      const cur = windows[windows.length - 1];
      if (cur && (d === null || cur.start === null || d - cur.start <= windowDays)) { cur.items.push(j); if (cur.start === null) cur.start = d; } else windows.push({ start: d, items: [j] });
    }
    for (const win of windows) {
      // split by compatibility first (temperature / DG class)
      const groups = [];
      for (const j of win.items) {
        const g = groups.find((x) => x.every((y) => !incompatibility(x[0], j) && !incompatibility(y, j)));
        if (g) g.push(j); else groups.push([j]);
      }
      for (const g of groups) {
        const mode = g[0].mode;
        const bins = mode === 'LCL' ? packSea(g, CONTAINERS[opts.container || '40HC'] || CONTAINERS['40HC']) : packAir(g, Number(opts.capacityKg || 0));
        for (const bin of bins) {
          if (bin.length < 2) { unplanned.push({ id: bin[0].id, reason: 'No other compatible shipment on this lane and date' }); continue; }
          const weights = masterWeights(bin, mode);
          plans.push({
            lane, mode, origin: bin[0].origin, destination: bin[0].destination,
            ready_from: bin.map((b) => b.ready_date).filter(Boolean).sort()[0] || null,
            houses: bin.map((b) => b.id), weights, warnings: consolWarnings(bin), reasons: explain(bin, weights, mode, opts),
          });
        }
      }
    }
  }
  plans.sort((a, b) => (b.weights.gain ?? b.weights.cbm) - (a.weights.gain ?? a.weights.cbm));
  return { plans, unplanned };
}

/** Gain (kg) of putting these houses in one air consol. */
const airGain = (items) => masterWeights(items, 'AIR').gain;

/**
 * Air: without a capacity limit every compatible shipment shares one consol (the gain never goes
 * down by adding one). With a capacity (chargeable kg per consol) bins are filled greedily with the
 * shipment that adds the most gain, pairing bulky and dense cargo, then improved by swaps.
 */
function packAir(items, capacityKg) {
  if (!capacityKg) return [items];
  const left = [...items].sort((a, b) => b.w.chargeable - a.w.chargeable);
  const bins = [];
  while (left.length) {
    const bin = [left.shift()];
    for (;;) {
      let best = -1;
      let bestScore = -Infinity;
      left.forEach((c, i) => {
        const next = [...bin, c];
        if (masterWeights(next, 'AIR').chargeable > capacityKg) return;
        const score = airGain(next) - airGain(bin) + 1e-6 * c.w.chargeable; // prefer gain, then fill
        if (score > bestScore) { bestScore = score; best = i; }
      });
      if (best < 0) break;
      bin.push(left.splice(best, 1)[0]);
    }
    bins.push(bin);
  }
  improveBySwaps(bins, capacityKg);
  return bins;
}

/** Swap pairs of shipments between consols while that raises the total gain and fits. */
function improveBySwaps(bins, capacityKg) {
  const total = () => bins.reduce((s, b) => s + airGain(b), 0);
  for (let pass = 0; pass < 4; pass++) {
    let improved = false;
    for (let a = 0; a < bins.length; a++) for (let b = a + 1; b < bins.length; b++) {
      for (let i = 0; i < bins[a].length; i++) for (let j = 0; j < bins[b].length; j++) {
        const before = total();
        [bins[a][i], bins[b][j]] = [bins[b][j], bins[a][i]];
        const fits = masterWeights(bins[a], 'AIR').chargeable <= capacityKg && masterWeights(bins[b], 'AIR').chargeable <= capacityKg;
        if (fits && total() > before + 0.01) improved = true;
        else [bins[a][i], bins[b][j]] = [bins[b][j], bins[a][i]];
      }
    }
    if (!improved) break;
  }
}

/** Sea: first-fit decreasing by cbm into containers, respecting payload. */
function packSea(items, box) {
  const bins = [];
  for (const it of [...items].sort((a, b) => b.w.cbm - a.w.cbm)) {
    const bin = bins.find((b) => b.cbm + it.w.cbm <= box.cbm && b.kg + it.w.gross <= box.kg);
    if (bin) { bin.items.push(it); bin.cbm += it.w.cbm; bin.kg += it.w.gross; } else bins.push({ items: [it], cbm: it.w.cbm, kg: it.w.gross });
  }
  return bins.map((b) => b.items);
}

/** Plain-language reasons the agent shows with each plan. */
function explain(bin, w, mode, opts) {
  const out = [];
  if (mode === 'LCL') {
    const box = CONTAINERS[opts.container || '40HC'] || CONTAINERS['40HC'];
    out.push(`${w.cbm} cbm of ${box.cbm} cbm (${Math.round((w.cbm / box.cbm) * 100)}% full), ${w.gross} kg.`);
    return out;
  }
  const bulky = bin.filter((b) => !b.w.dense).length;
  const dense = bin.length - bulky;
  out.push(`${bin.length} shipments: ${bulky} bulky, ${dense} dense. Shippers pay ${w.sold} kg; the airline charges ${w.chargeable} kg, a gain of ${w.gain} kg.`);
  if (opts.capacityKg) out.push(`Uses ${w.chargeable} of ${opts.capacityKg} kg capacity.`);
  return out;
}
