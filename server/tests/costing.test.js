import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, buildCustomerQuote, qtyFor, convert } from '../engines/costing.js';
import { normaliseCharge, normaliseBasis } from '../engines/charges.js';

const fx = { base: 'INR', rates: { USD: 84, HKD: 10.8 } };
const rfq = { mode: 'FCL', legs: ['pickup', 'export_customs', 'freight'], containers: [{ type: '40HC', qty: 2 }] };
const invites = [{ id: 1, legs: rfq.legs, status: 'replied' }, { id: 2, legs: rfq.legs, status: 'replied' }, { id: 3, legs: rfq.legs, status: 'sent' }];
const quotes = [
  { id: 10, invite_id: 1, agent: { company: 'A' }, verified: true, lines: [
    { leg: 'pickup', charge_code: 'TRUCK', basis: 'per_trip', rate: 18000, currency: 'INR' },
    { leg: 'export_customs', charge_code: 'CHA', basis: 'per_declaration', rate: 6500, currency: 'INR' },
    { leg: 'freight', charge_code: 'OFR', basis: 'per_40', rate: 610, currency: 'USD' } ] },
  { id: 11, invite_id: 2, agent: { company: 'B' }, verified: true, lines: [
    { leg: 'pickup', charge_code: 'TRUCK', basis: 'per_trip', rate: 16500, currency: 'INR' },
    { leg: 'freight', charge_code: 'OFR', basis: 'per_container', rate: 585, currency: 'USD' } ] },
];

test('qty and fx', () => {
  assert.equal(qtyFor('per_40', rfq), 2);
  assert.equal(qtyFor('per_trip', rfq), 2);
  assert.equal(convert(100, 'USD', 'HKD', fx), 100 * 84 / 10.8);
});

test('compare picks best per leg and flags missing', () => {
  const c = compare(rfq, invites, quotes, fx);
  assert.equal(c.bestPerLeg.pickup.quoteId, 11);
  assert.equal(c.bestPerLeg.export_customs.quoteId, 10);
  assert.equal(c.bestPerLeg.freight.quoteId, 11);
  assert.equal(c.bestSingle.quoteId, 10);
  assert.ok(c.columns[1].flags.some((f) => f.type === 'missing_leg'));
  assert.equal(c.columns[2].status, 'sent');
});

test('customer quote applies margin and tax', () => {
  const byId = { 10: quotes[0], 11: quotes[1] };
  const cq = buildCustomerQuote(rfq, { pickup: 11, export_customs: 10, freight: 11 }, byId, { currency: 'INR', marginPct: 10, taxPct: 18 }, fx);
  const buy = 16500 * 2 + 6500 + 585 * 84 * 2;
  assert.equal(cq.totals.buy, buy);
  assert.equal(cq.totals.sell, Math.round(buy * 1.1 * 100) / 100);
  assert.equal(cq.totals.tax, Math.round(cq.totals.sell * 0.18 * 100) / 100);
});

test('normalisers', () => {
  assert.equal(normaliseCharge('Ocean Freight'), 'OFR');
  assert.equal(normaliseCharge('B/L fee'), 'DOC');
  assert.equal(normaliseCharge('THC', 'destination_charges'), 'DTHC');
  assert.equal(normaliseBasis("per 40'HC"), 'per_40');
  assert.equal(normaliseBasis('per BL'), 'per_bl');
});
