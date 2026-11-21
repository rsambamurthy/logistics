import test from 'node:test';
import assert from 'node:assert/strict';
import { predictDelay, lanePunctuality } from '../engines/delayRisk.js';

const T = (s) => Date.parse(`${s}Z`);
const job = { mode: 'sea', status: 'booked', lane: 'FCL|MAA|HKG', carrier: 'ONE' };

test('on time when everything follows the plan', () => {
  const r = predictDelay({ job, plan: { etd: '2026-12-01', eta: '2026-12-12' }, snap: { eta: { at: '2026-12-12 08:00' } }, events: [], now: T('2026-11-28T00:00') });
  assert.equal(r.risk, 'on_time');
});

test('not departed two days after ETD: at risk, slip ≈ 2 days', () => {
  const r = predictDelay({ job, plan: { etd: '2026-12-01', eta: '2026-12-12' }, snap: { etd: { at: '2026-12-01 12:00' }, eta: { at: '2026-12-12 08:00' } }, events: [{ code: 'gate_in', at: '2026-11-30 10:00', actual: true }], now: T('2026-12-03T12:00') });
  assert.equal(r.risk, 'at_risk');
  assert.equal(r.signals[0].type, 'not_departed');
  assert.ok(r.delay_hours >= 47 && r.delay_hours <= 49);
  assert.equal(r.expected_eta, '2026-12-14 08:00');
});

test('rolled to another vessel', () => {
  const r = predictDelay({ job: { ...job, status: 'departed' }, plan: { vessel: 'ONE APUS', eta: '2026-12-12' }, snap: { vessel: 'ONE HARMONY', eta: { at: '2026-12-12 08:00' } }, events: [{ code: 'departed', at: '2026-12-01 10:00', actual: true }], now: T('2026-12-02T00:00') });
  assert.ok(r.signals.some((s) => s.type === 'rolled'));
  assert.equal(r.risk, 'at_risk');
});

test('ETA passed without arrival is late', () => {
  const r = predictDelay({ job: { ...job, status: 'departed' }, snap: { eta: { at: '2026-12-12 08:00' } }, events: [{ code: 'departed', at: '2026-12-01 10:00', actual: true }], now: T('2026-12-14T08:00') });
  assert.equal(r.risk, 'late');
});

test('long transshipment wait', () => {
  const r = predictDelay({ job: { ...job, status: 'departed' }, snap: { eta: { at: '2026-12-20 08:00' } }, events: [{ code: 'departed', at: '2026-12-01 10:00', actual: true }, { code: 'transshipment', at: '2026-12-05 10:00', location: 'Singapore', actual: true }], now: T('2026-12-12T10:00') });
  assert.ok(r.signals.some((s) => s.type === 'transshipment_wait'));
});

test('history: a lane that is usually late', () => {
  const past = Array.from({ length: 5 }, (_, i) => ({ lane: 'FCL|MAA|HKG', carrier: 'ONE', first_eta: '2026-10-10', arrived_at: `2026-10-1${3 + (i % 2)}` }));
  const p = lanePunctuality(past);
  assert.ok(p['FCL|MAA|HKG|ONE'].median >= 72);
  const r = predictDelay({ job, plan: { etd: '2026-12-01', eta: '2026-12-12' }, snap: { eta: { at: '2026-12-12 08:00' } }, punctuality: p, now: T('2026-11-28T00:00') });
  assert.ok(r.signals.some((s) => s.type === 'history'));
  assert.equal(r.risk, 'at_risk');
});

test('arrived shipments are not predicted', () => {
  assert.equal(predictDelay({ job: { ...job, status: 'arrived' } }).risk, 'arrived');
});
