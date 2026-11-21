import test from 'node:test';
import assert from 'node:assert/strict';
import { houseWeights, masterWeights, consolEconomics, planConsols, piecesTotals, incompatibility } from '../engines/consol.js';

const cbmFor = (volKg) => volKg / (1e6 / 6000);
// the example from the whiteboard: a bulky pallet and a dense carton
const pallet = { id: 1, mode: 'AIR', origin: 'Hong Kong (HKG)', destination: 'Chennai (MAA)', gross_kg: 100, cbm: cbmFor(250) };
const carton = { id: 2, mode: 'AIR', origin: 'Hong Kong (HKG)', destination: 'Chennai (MAA)', gross_kg: 100, cbm: cbmFor(10) };

test('house chargeable weight is the higher of gross and volume', () => {
  assert.equal(houseWeights(pallet).chargeable, 250);
  assert.equal(houseWeights(carton).chargeable, 100);
  assert.equal(houseWeights(carton).dense, true);
});

test('master is charged on max(total gross, total volume): gain 90 kg', () => {
  const m = masterWeights([pallet, carton]);
  assert.equal(m.sold, 350);
  assert.equal(m.chargeable, 260);
  assert.equal(m.gain, 90);
  assert.equal(m.freeWeight, 60); // 60 kg of dense cargo could still fly free
});

test('economics at HK$27.10/kg', () => {
  const e = consolEconomics([{ ...pallet, sell_amount: 250 * 30 }, { ...carton, sell_amount: 100 * 30 }], { rate: 27.1 });
  assert.equal(e.cost, 7046);
  assert.equal(e.revenue, 10500);
  assert.equal(e.gainValue, 2439);
});

test('pieces: cm and inch divisors', () => {
  assert.equal(piecesTotals([{ count: 2, l: 120, w: 100, h: 150, unit: 'cm', kg: 50 }]).volKg, 600);
  assert.equal(piecesTotals([{ count: 1, l: 36.6, w: 10, h: 10, unit: 'in' }]).volKg, 10);
});

test('agent plans one consol per lane and date window, keeps incompatible cargo apart', () => {
  const jobs = [
    { ...pallet, ready_date: '2026-12-01' }, { ...carton, ready_date: '2026-12-02' },
    { id: 3, mode: 'AIR', origin: 'HKG', destination: 'MAA', gross_kg: 80, cbm: 0.1, ready_date: '2026-12-20' },
    { id: 4, mode: 'AIR', origin: 'HKG', destination: 'BOM', gross_kg: 80, cbm: 0.1, ready_date: '2026-12-01' },
    { id: 5, mode: 'AIR', origin: 'HKG', destination: 'MAA', gross_kg: 50, cbm: 0.1, ready_date: '2026-12-01', reefer_temp: '2-8 C' },
    { id: 6, mode: 'FCL', origin: 'HKG', destination: 'MAA' },
  ];
  const { plans, unplanned } = planConsols(jobs);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].houses.sort(), [1, 2]);
  assert.equal(plans[0].weights.gain, 90);
  assert.deepEqual(unplanned.map((u) => u.id).sort(), [3, 4, 5, 6]);
  assert.ok(incompatibility(jobs[0], jobs[4]));
});

test('with a capacity limit the agent pairs bulky with dense cargo', () => {
  const b = (id, g, v) => ({ id, mode: 'AIR', origin: 'HKG', destination: 'MAA', gross_kg: g, cbm: cbmFor(v) });
  // two bulky (100/250) and two dense (240/10); 500 kg per consol
  const { plans } = planConsols([b(1, 100, 250), b(2, 100, 250), b(3, 240, 10), b(4, 240, 10)], { capacityKg: 500 });
  assert.equal(plans.length, 2);
  for (const p of plans) assert.equal(p.weights.gain, 150); // each pairs one bulky with one dense (bulky+bulky or dense+dense gain 0)
});

test('sea LCL fills containers by cbm', () => {
  const s = (id, cbm) => ({ id, mode: 'LCL', origin: 'HKHKG', destination: 'INMAA', gross_kg: 1000, cbm });
  const { plans, unplanned } = planConsols([s(1, 30), s(2, 25), s(3, 20), s(4, 10)], { container: '40HC' });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].weights.cbm, 65); // 30 + 25 + 10 of 68 cbm
  assert.deepEqual(unplanned.map((u) => u.id), [3]);
});
