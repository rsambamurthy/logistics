import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSeaRatesSea, normaliseSeaRatesAir, milestoneFrom, hoursBetween, bestEta } from '../engines/tracking.js';

const sea = {
  status: 'success',
  data: {
    metadata: { type: 'BL', number: 'ONEYMAA00999', sealine_name: 'ONE', status: 'IN_TRANSIT', updated_at: '2026-11-25 09:00:25' },
    locations: [{ id: 1, name: 'Chennai', country_code: 'IN', locode: 'INMAA' }, { id: 2, name: 'Hong Kong', country_code: 'HK', locode: 'HKHKG' }],
    vessels: [{ id: 7, name: 'ONE HARMONY', imo: 9000000 }],
    route: { pol: { location: 1, date: '2026-11-24 18:00:00', actual: true }, pod: { location: 2, date: '2026-12-02 08:00:00', actual: false, predictive_eta: '2026-12-03 10:00:00' } },
    containers: [{ number: 'TCLU1234567', size_type: "40' High Cube", status: 'IN_TRANSIT', events: [
      { order_id: 1, location: 1, event_code: 'GTIN', description: 'Gate in', date: '2026-11-22 10:00:00', actual: true },
      { order_id: 2, location: 1, event_code: 'LOAD', description: 'Loaded', date: '2026-11-24 06:00:00', actual: true, vessel: 7, voyage: '045E' },
      { order_id: 3, location: 1, event_code: 'DEPA', description: 'Vessel departure', date: '2026-11-24 18:00:00', actual: true, vessel: 7, voyage: '045E' },
      { order_id: 4, location: 2, event_code: 'ARRI', description: 'Vessel arrival', date: '2026-12-02 08:00:00', actual: false, vessel: 7, voyage: '045E' },
    ] }],
    route_data: { ais: { data: { last_vessel_position: { lat: 10.5, lng: 92.1, updated_at: '2026-11-25 08:00:00' } } } },
  },
};

test('SeaRates sea response normalised', () => {
  const s = normaliseSeaRatesSea(sea);
  assert.equal(s.status, 'in_transit');
  assert.equal(s.pol, 'Chennai, IN (INMAA)');
  assert.deepEqual(s.etd, { at: '2026-11-24 18:00', actual: true });
  assert.equal(bestEta(s), '2026-12-03 10:00');
  assert.equal(s.vessel, 'ONE HARMONY');
  assert.equal(s.voyage, '045E');
  assert.deepEqual(s.position, { lat: 10.5, lng: 92.1, at: '2026-11-25 08:00' });
  assert.deepEqual(s.events.map((e) => e.code), ['gate_in', 'loaded', 'departed', 'arrived']);
  assert.equal(s.events[3].actual, false);
});

test('SeaRates air response normalised', () => {
  const s = normaliseSeaRatesAir({ metadata: { airline: { name: 'Cathay Cargo' } }, data: { status: 'DEPARTED', flight_number: 'CX632', from: { name: 'Chennai', locode: 'INMAA' }, to: { name: 'Hong Kong', locode: 'HKHKG' }, departure_datetime_local: { estimated: '2026-11-24 01:00:00', actual: '2026-11-24 01:20:00' }, arrival_datetime_local: { estimated: '2026-11-24 08:40:00' }, events: [{ event_code: 'DEP', description: 'Departed', location: { name: 'Chennai' }, datetime_local: { actual: '2026-11-24 01:20:00' } }] } });
  assert.equal(s.status, 'in_transit');
  assert.equal(s.flight, 'CX632');
  assert.deepEqual(s.etd, { at: '2026-11-24 01:20', actual: true });
  assert.equal(s.events[0].code, 'departed');
});

test('milestones only move forward', () => {
  const s = normaliseSeaRatesSea(sea);
  assert.deepEqual(milestoneFrom('booked', [s]), { status: 'departed', date: '2026-11-24' });
  assert.equal(milestoneFrom('departed', [s]), null);
  assert.equal(milestoneFrom('completed', [s]), null);
  assert.equal(hoursBetween('2026-12-02 08:00', '2026-12-03 10:00'), 26);
});
