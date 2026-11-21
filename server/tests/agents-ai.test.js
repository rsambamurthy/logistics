import test from 'node:test';
import assert from 'node:assert/strict';
import { rankAgents, laneOf } from '../engines/agentRank.js';
import { fitWinModel, winProbability, adviseMargin } from '../engines/winModel.js';
import { checkInvoice } from '../engines/invoiceCheck.js';

const ctx = { mode: 'AIR', pol: 'Hong Kong (HKG)', pod: 'Chennai (MAA)', legs: ['freight'], places: ['Hong Kong'] };
const lane = laneOf(ctx);
const hist = (agent, n, { replied = n, cheap = 0.5, hours = 6, awarded = 0, onLane = true } = {}) => Array.from({ length: n }, (_, i) => ({
  agent_id: agent, lane: onLane ? lane : 'SEA|X|Y', replied: i < replied, declined: false, awarded: i < awarded, reply_hours: i < replied ? hours : null, price_rank: i < replied ? cheap : null, booking: i < awarded ? 'confirmed' : null,
}));

test('agent ranking prefers responsive, cheap agents and keeps one explore slot', () => {
  const agents = [1, 2, 3, 4, 5, 6].map((id) => ({ id, company: `A${id}`, services: ['freight'], ports: 'Hong Kong' }));
  const history = [
    ...hist(1, 10, { replied: 9, cheap: 0.1, hours: 4, awarded: 4 }), // good and cheap
    ...hist(2, 10, { replied: 3, cheap: 0.9, hours: 40 }), // slow, dear, rarely replies
    ...hist(3, 10, { replied: 8, cheap: 0.5, hours: 10, awarded: 2 }),
    ...hist(4, 8, { replied: 7, cheap: 0.3, hours: 8, awarded: 1 }),
    ...hist(5, 1, { replied: 1, cheap: 0, hours: 1 }), // one lucky reply: smoothed
    // agent 6: brand new
  ];
  const r = rankAgents(agents, history, ctx, { pick: 4 });
  assert.equal(r[0].id, 1);
  assert.equal(r.find((a) => a.id === 2).recommended, false);
  assert.ok(r.find((a) => a.id === 5).score < r[0].score, 'one reply does not beat a proven agent');
  const explore = r.find((a) => a.explore);
  assert.ok([5, 6].includes(explore.id));
  assert.equal(r.filter((a) => a.recommended).length, 4);
});

test('agents not covering the leg are left out', () => {
  const r = rankAgents([{ id: 1, services: ['origin_charges'] }, { id: 2, services: ['freight'] }], [], ctx);
  assert.deepEqual(r.map((a) => a.id), [2]);
});

test('win model: no data gives ~50% at the usual margin; data moves the advice', () => {
  const empty = fitWinModel([], { defaultMargin: 10 });
  assert.ok(Math.abs(winProbability(empty, 10) - 0.5) < 0.01);
  assert.ok(Math.abs(adviseMargin(empty, { buy: 1000 }).best.margin - 10) <= 1, 'with no history the advice stays at the usual margin');
  // customer wins below 8 %, loses above 12 %
  const samples = [];
  for (let i = 0; i < 20; i++) samples.push({ margin: 4 + (i % 4), won: true, customer: 'C1' }, { margin: 13 + (i % 4), won: false, customer: 'C1' });
  const m = fitWinModel(samples, { defaultMargin: 10 });
  assert.ok(winProbability(m, 5, { customer: 'C1' }) > winProbability(m, 15, { customer: 'C1' }));
  const adv = adviseMargin(m, { buy: 10000, customer: 'C1', current: 15 });
  assert.ok(adv.best.margin < 15, `best ${adv.best.margin}`);
  assert.ok(adv.best.expected >= adv.current.expected);
  assert.equal(adv.confidence, 'good');
});

test('invoice check: extras, over-charges and arithmetic', () => {
  const same = (a) => a; // one currency
  const expected = [
    { id: 1, description: 'Air freight', charge_code: 'AFR', amount: 6000, currency: 'HKD' },
    { id: 2, description: 'Terminal handling', amount: 400, currency: 'HKD' },
    { id: 3, description: 'AWB fee', amount: 150, currency: 'HKD' },
  ];
  const inv = { currency: 'HKD', total: 7450, lines: [
    { description: 'Air freight', charge_code: 'AFR', amount: 6000 },
    { description: 'Terminal handling charges', amount: 500 },
    { description: 'Security screening', amount: 300 },
    { description: 'AWB fee', amount: 150 },
  ] };
  const r = checkInvoice(inv, expected, same);
  const types = r.findings.map((f) => f.type).sort();
  assert.deepEqual(types, ['extra', 'over', 'sum']);
  assert.equal(r.leakage, 100 + 300 + 500); // +100 handling, 300 screening, total 500 above the lines
  assert.equal(r.status, 'to_check');
  const ok = checkInvoice({ currency: 'HKD', total: 6550, lines: [{ description: 'Air freight', charge_code: 'AFR', amount: 6000 }, { description: 'Terminal handling', amount: 400 }, { description: 'AWB fee', amount: 150 }] }, expected, same);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.leakage, 0);
});
