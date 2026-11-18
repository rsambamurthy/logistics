import test from 'node:test';
import assert from 'node:assert/strict';
import { jobPlanFromOption, jobProfit, deriveJobStatus, cutoffsDue, bookingChanges } from '../engines/jobs.js';

const fx = { base: 'INR', rates: { USD: 83, INR: 1 } };
const option = {
  sections: [
    { leg: 'MAIN', invite_id: 7, lines: [{ description: 'Ocean freight', buy_amount: 1000, buy_currency: 'USD', sell_amount: 91300 }] },
    { leg: 'ORIGIN', invite_id: 7, lines: [{ description: 'THC', buy_amount: 8000, buy_currency: 'INR', sell_amount: 9000 }] },
    { leg: 'CUSTOMS_EXP', invite_id: 9, lines: [{ description: 'Customs clearance', buy_amount: 3000, buy_currency: 'INR', sell_amount: 3500 }] },
  ],
};

test('job plan: buy and sell lines, one booking per agent', () => {
  const p = jobPlanFromOption(option, 'INR');
  assert.equal(p.costs.length, 6);
  assert.deepEqual(p.bookings, [{ invite_id: 7, legs: ['MAIN', 'ORIGIN'] }, { invite_id: 9, legs: ['CUSTOMS_EXP'] }]);
  const r = jobProfit(p.costs, fx);
  assert.equal(r.buy, 83000 + 8000 + 3000);
  assert.equal(r.sell, 91300 + 9000 + 3500);
  assert.equal(r.profit, 9800);
});

test('profit reports missing exchange rates instead of guessing', () => {
  const r = jobProfit([{ kind: 'buy', amount: 10, currency: 'XYZ' }], fx);
  assert.equal(r.buy, 0);
  assert.equal(r.errors.length, 1);
});

test('status follows bookings; milestones stick', () => {
  assert.equal(deriveJobStatus('open', []), 'open');
  assert.equal(deriveJobStatus('open', [{ status: 'requested' }, { status: 'draft' }]), 'booking_requested');
  assert.equal(deriveJobStatus('booking_requested', [{ status: 'confirmed' }, { status: 'cancelled' }]), 'booked');
  assert.equal(deriveJobStatus('departed', [{ status: 'requested' }]), 'departed');
});

test('cut-offs due in the window, sorted', () => {
  const now = new Date('2026-11-20T00:00:00Z');
  const due = cutoffsDue([{ id: 1, status: 'confirmed', cutoffs: { vgm: '2026-11-22T10:00', si: '2026-11-21T10:00', gate_in: '2026-12-10T00:00' } }], now);
  assert.deepEqual(due.map((d) => d.key), ['si', 'vgm']);
});

test('booking changes only include new information', () => {
  const ch = bookingChanges({ booking_no: 'A1', cutoffs: { si: 'x' }, container_nos: ['C1'] }, { booking_no: 'A1', vessel: 'MSC X', cutoffs: { vgm: 'y' }, container_nos: ['C2'] });
  assert.deepEqual(ch, { vessel: 'MSC X', cutoffs: { si: 'x', vgm: 'y' }, container_nos: ['C1', 'C2'] });
});
