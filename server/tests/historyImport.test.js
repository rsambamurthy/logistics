import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHistory, parseContainers, parseLeg } from '../engines/historyImport.js';
import { normaliseRows } from '../lib/sheets.js';

test('containers and legs are read the way people write them', () => {
  assert.deepEqual(parseContainers("2x40HC, 1 x 20' GP, 40HQ").containers, [{ type: '40HC', qty: 2 }, { type: '20GP', qty: 1 }, { type: '40HC', qty: 1 }]);
  assert.deepEqual(parseContainers('3 x banana').bad, ['3 x banana']);
  assert.equal(parseLeg('Main freight (sea / air)'), 'freight');
  assert.equal(parseLeg('export customs'), 'export_customs');
  assert.equal(parseLeg('Export CHA'), 'export_customs');
  assert.equal(parseLeg('nonsense'), null);
});

test('headers are normalised', () => {
  assert.deepEqual(Object.keys(normaliseRows([{ 'Gross weight (kg)': 1, ' Enquiry Ref ': 2 }])[0]), ['gross_weight', 'enquiry_ref']);
});

const sheets = () => ({
  enquiries: [
    { ref: 'E1', date: '04/05/2026', customer: 'Acme', customer_email: 'B@Acme.in', mode: 'fcl', origin: 'Chennai', destination: 'Hong Kong', legs: 'pickup, freight', containers: '1x40HC', quoted_price: 1000, quoted_currency: 'usd', outcome: 'Lost', lost_reason: 'price', competitor_price: 950 },
    { ref: 'E2', date: '2026-05-06', mode: 'AIR', origin: 'MAA', destination: 'HKG', gross_weight_kg: 500, outcome: '' },
    { ref: 'E3', date: 'yesterday', mode: 'AIR', origin: 'MAA', destination: 'HKG' },
    { ref: 'E4', date: '2026-05-07', mode: 'FCL', origin: 'MAA', destination: 'HKG' },
  ],
  quotes: [
    { enquiry_ref: 'E1', agent: 'Alpha', agent_email: 'rates@alpha.com', asked_on: '2026-05-04', replied_on: '2026-05-05', used: 'yes', leg: 'freight', charge_code: 'OFR', rate: 800, currency: 'USD', transit_days: 9 },
    { enquiry_ref: 'E1', agent: 'Alpha', agent_email: 'rates@alpha.com', leg: 'pickup', description: 'Trucking', rate: 16000, currency: 'INR' },
    { enquiry_ref: 'E1', agent: 'Bravo', asked_on: '2026-05-04' },
    { enquiry_ref: 'E2', agent: 'Charlie', declined: 'Y', replied_on: '2026-05-07' },
    { enquiry_ref: 'E9', agent: 'Ghost', rate: 1, currency: 'USD' },
  ],
  jobs: [{ enquiry_ref: 'E1', job_ref: 'J1', etd: '2026-05-15', eta_booked: '2026-05-24', arrived_on: '2026-05-27', invoice_amount: 1000 }],
});

test('history rows become enquiries with agent quotes and a job; bad rows are reported', () => {
  const r = parseHistory(sheets());
  assert.equal(r.enquiries.length, 2);
  const e1 = r.enquiries.find((e) => e.ref === 'E1');
  assert.equal(e1.date, '2026-05-04');
  assert.equal(e1.rfq.mode, 'FCL');
  assert.deepEqual(e1.rfq.legs, ['pickup', 'freight']);
  assert.equal(e1.customer.email, 'b@acme.in');
  // a job means the enquiry was won, even though the sheet said lost
  assert.equal(e1.outcome, 'accepted');
  const alpha = e1.agents.find((a) => a.name === 'Alpha');
  assert.equal(alpha.lines.length, 2);
  assert.equal(alpha.lines[0].basis, 'per_container');
  assert.equal(alpha.lines[1].leg, 'pickup');
  assert.ok(alpha.used);
  const bravo = e1.agents.find((a) => a.name === 'Bravo');
  assert.equal(bravo.replied_on, null); // asked, never answered: teaches reply rates
  assert.deepEqual(bravo.legs, ['pickup', 'freight']);
  assert.equal(e1.job.invoice_date, '2026-05-15'); // no invoice date: departure (else ETD, else enquiry date)
  const e2 = r.enquiries.find((e) => e.ref === 'E2');
  assert.ok(e2.agents[0].declined);
  const msgs = r.errors.map((x) => `${x.sheet}:${x.row}:${x.message}`).join('\n');
  assert.match(msgs, /Enquiries:4:date/);
  assert.match(msgs, /Enquiries:5:FCL needs containers/);
  assert.match(msgs, /Agent quotes:6:enquiry_ref "E9"/);
  assert.equal(r.counts.no_reply, 1);
  assert.equal(r.counts.jobs, 1);
});

test('lost reason maps to the list; unknown text kept as a note', () => {
  const s = sheets();
  s.jobs = [];
  s.enquiries[0].lost_reason = 'Customer went quiet for months';
  const e1 = parseHistory(s).enquiries.find((e) => e.ref === 'E1');
  assert.equal(e1.outcome, 'lost');
  assert.equal(e1.lost_reason, 'Other');
  assert.equal(e1.lost_note, 'Customer went quiet for months');
  s.enquiries[0].lost_reason = 'Price';
  assert.equal(parseHistory(s).enquiries.find((e) => e.ref === 'E1').lost_reason, 'Price too high');
});
