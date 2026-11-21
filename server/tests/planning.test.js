import test from 'node:test';
import assert from 'node:assert/strict';
import { replyForecast, readyToCompare, modeAdvice, bestCombination, estimateFromHistory, shipNowOrWait, forecastLane, rateCardHealth, paymentRisk } from '../engines/planning.js';

test('reply forecast: a fast, reliable agent quiet for 3 days is unlikely to reply', () => {
  const hist = Array.from({ length: 10 }, (_, i) => ({ replied: i < 9, reply_hours: 2 + i }));
  const early = replyForecast(hist, 1);
  const late = replyForecast(hist, 72);
  assert.ok(early.probability > 0.8);
  assert.ok(late.probability < 0.2);
  assert.ok(early.chase_after_hours >= 4 && early.chase_after_hours <= 12);
  assert.equal(late.due_to_chase, true);
  assert.equal(readyToCompare(3, [late]).ready, true);
  assert.equal(readyToCompare(2, [early]).ready, false);
});

test('mode advice: cheapest mode that arrives in time', () => {
  const r = modeAdvice([{ mode: 'AIR', cost: 5000, transit_days: 2 }, { mode: 'LCL', cost: 1200, transit_days: 18 }, { mode: 'FCL', cost: 2500, transit_days: 16 }], { ready: '2026-12-01', deliverBy: '2026-12-15', kg: 800, cbm: 4 });
  assert.equal(r.best.mode, 'AIR');
  const r2 = modeAdvice([{ mode: 'AIR', cost: 5000, transit_days: 2 }, { mode: 'LCL', cost: 1200, transit_days: 18 }], { ready: '2026-12-01', deliverBy: '2027-01-15', kg: 800, cbm: 4 });
  assert.equal(r2.best.mode, 'LCL');
});

test('best combination respects transit and hand-offs', () => {
  const quotes = [
    { id: 1, legs: { pickup: 100, freight: 1000 }, transit_days: 20 },
    { id: 2, legs: { pickup: 90, freight: 1050 }, transit_days: 12 },
    { id: 3, legs: { freight: 980 }, transit_days: 25 },
  ];
  assert.deepEqual(bestCombination(quotes, ['pickup', 'freight']).selection, { pickup: 2, freight: 3 });
  assert.deepEqual(bestCombination(quotes, ['pickup', 'freight'], { maxTransit: 15 }).selection, { pickup: 2, freight: 2 });
  assert.deepEqual(bestCombination(quotes, ['pickup', 'freight'], { handoffCost: 200 }).selection, { pickup: 1, freight: 1 });
});

test('estimate scales per unit', () => {
  const e = estimateFromHistory([{ leg: 'freight', total: 2000, units: 1 }, { leg: 'freight', total: 4400, units: 2 }, { leg: 'freight', total: 2100, units: 1 }], 2, ['freight', 'pickup']);
  assert.equal(e.legs.freight.mid, 4200);
  assert.deepEqual(e.missing, ['pickup']);
});

test('ship now or wait', () => {
  assert.equal(shipNowOrWait({ ratePerDay: 1, gainPerPartner: 500, costPerDay: 50, slackDays: 3 }).decision, 'wait');
  assert.equal(shipNowOrWait({ ratePerDay: 1, gainPerPartner: 500, slackDays: 0 }).decision, 'ship_now');
  assert.equal(shipNowOrWait({ ratePerDay: 0.05, gainPerPartner: 100, costPerDay: 50, slackDays: 5 }).decision, 'ship_now');
});

test('lane forecast follows a trend', () => {
  const f = forecastLane([100, 120, 140, 160, 180, 200]);
  assert.ok(f.weeks[0].p50 > 190);
  assert.ok(f.weeks[0].p80 >= f.weeks[0].p50);
});

test('rate card health', () => {
  assert.equal(rateCardHealth({ valid_to: '2026-11-25', valid_from: '2026-11-01' }, [], '2026-11-20').issues[0].type, 'expiring');
  assert.ok(rateCardHealth({ valid_to: '2027-03-01', valid_from: '2026-11-01' }, [0.8, 0.82, 0.85], '2026-11-20').issues.some((i) => i.type === 'market_lower'));
  assert.equal(rateCardHealth({ valid_to: '2027-03-01', valid_from: '2026-11-01' }, [1, 1.02], '2026-11-20').ok, true);
});

test('payment risk grades', () => {
  const good = paymentRisk([{ amount: 1000, invoice_date: '2026-09-01', due_date: '2026-10-01', paid_at: '2026-09-30' }, { amount: 1000, due_date: '2026-11-01', paid_at: '2026-11-02' }], '2026-11-20');
  assert.equal(good.grade, 'A');
  const bad = paymentRisk([{ amount: 1000, due_date: '2026-09-01', paid_at: '2026-10-20' }, { amount: 2000, due_date: '2026-09-15' }], '2026-11-20');
  assert.equal(bad.grade, 'D');
  assert.equal(paymentRisk([], '2026-11-20').grade, 'new');
});

import { crossCheckDocs } from '../engines/docCheck.js';
test('document cross-check finds disagreements', () => {
  const r = crossCheckDocs([
    { key: 'invoice', name: 'Invoice', fields: { consignee: 'ACME TRADING LTD, HONG KONG', invoice_value: 'USD 12,500.00', hs_code: '8708.99.00', packages: 10, gross_weight_kg: 1250 } },
    { key: 'packing_list', name: 'Packing list', fields: { consignee: 'Acme Trading Ltd Hong Kong', packages: 10, gross_weight_kg: 1520 } },
    { key: 'bl', name: 'BL draft', fields: { consignee: 'ACME TRADING LTD', packages: 10, gross_weight_kg: 1250, hs_code: '870899' } },
  ]);
  const by = Object.fromEntries(r.checks.map((c) => [c.field, c]));
  assert.equal(by.packages.ok, true);
  assert.equal(by.gross_weight_kg.ok, false);
  assert.ok(by.gross_weight_kg.text.includes('Packing list'));
  assert.equal(by.hs_code.ok, true);
  assert.equal(r.issues, 1);
});

test('estimate scales freight per unit but customs per shipment', () => {
  const s = [1, 2, 3].flatMap((k) => [{ leg: 'freight', total: 1000 * k, units: k }, { leg: 'export_customs', total: 50, units: 1 }]);
  const e = estimateFromHistory(s, { freight: 2, export_customs: 1 }, ['freight', 'export_customs']);
  assert.equal(e.legs.freight.mid, 2000);
  assert.equal(e.legs.export_customs.mid, 50);
});

test('document cross-check finds the odd one out', () => {
  const r = crossCheckDocs([
    { key: 'inv', name: 'Invoice', fields: { packages: 120, gross_weight_kg: 2400, hs_code: '8471.30', invoice_value: 'USD 12,500.00' } },
    { key: 'pl', name: 'Packing list', fields: { packages: 120, gross_weight_kg: 2450, hs_code: '847130' } },
    { key: 'si', name: 'SI', fields: { packages: 120, gross_weight_kg: 2400, hs_code: '84713010', invoice_value: 12500 } },
  ]);
  const by = Object.fromEntries(r.checks.map((c) => [c.field, c]));
  assert.ok(by.packages.ok);
  assert.ok(by.hs_code.ok);
  assert.ok(by.invoice_value.ok);
  assert.ok(!by.gross_weight_kg.ok);
  assert.match(by.gross_weight_kg.text, /Packing list/);
  assert.equal(r.issues, 1);
});
