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

import { cardMatches, cardLines, priceFromCards, placeMatches } from '../engines/ratecards.js';

test('rate card matching and lines', () => {
  const r = { mode: 'FCL', legs: ['pickup', 'freight'], pol: 'Chennai (INMAA)', pod: 'Hong Kong (HKHKG)', pickup_place: 'Sriperumbudur', containers: [{ type: '40HC', qty: 2 }, { type: '20GP', qty: 1 }] };
  const card = { id: 1, active: true, leg: 'freight', mode: 'FCL', origin: 'Chennai, INMAA', destination: 'Hong Kong', valid_from: '2026-01-01', valid_to: '2099-01-01',
    lines: [ { charge_code: 'OFR', basis: 'per_container', rate: 600, currency: 'USD', equipment: '40HC' }, { charge_code: 'OFR', basis: 'per_container', rate: 400, currency: 'USD', equipment: '20GP' }, { charge_code: 'BAF', basis: 'per_container', rate: 50, currency: 'USD' } ] };
  assert.ok(placeMatches('Chennai, INMAA', 'Chennai (INMAA)'));
  assert.ok(!placeMatches('Mumbai, INNSA', 'Chennai (INMAA)'));
  assert.ok(cardMatches(card, r));
  assert.ok(!cardMatches({ ...card, valid_to: '2020-01-01' }, r));
  assert.ok(!cardMatches({ ...card, destination: 'Singapore' }, r));
  const lines = cardLines(card, r);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].qty, 2);
  assert.equal(lines[1].qty, 1);
  const own2 = { ...card, id: 2, lines: [{ charge_code: 'OFR', basis: 'per_container', rate: 500, currency: 'USD' }] };
  const res = priceFromCards(r, [card, own2], fx);
  assert.equal(res.length, 1);
  assert.equal(res[0].legs.freight.card.id, 2); // 1750 USD vs 3 x 500 = 1500 USD -> card 2 is cheaper
});

test('air weight breaks and minimum', () => {
  const r = { mode: 'AIR', legs: ['freight'], pol: 'Chennai MAA', pod: 'HKG Hong Kong', gross_weight_kg: 50, volume_cbm: 0.1 };
  const card = { active: true, leg: 'freight', mode: 'AIR', origin: 'MAA', destination: 'HKG', lines: [
    { charge_code: 'AFR', basis: 'per_kg', rate: 2.5, currency: 'USD', qty_from: 0, qty_to: 99.99, min_amount: 150 },
    { charge_code: 'AFR', basis: 'per_kg', rate: 2.1, currency: 'USD', qty_from: 100, qty_to: 500 } ] };
  const lines = cardLines(card, r);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].basis, 'per_shipment');
  assert.equal(lines[0].rate, 150);
});
