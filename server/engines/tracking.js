// Pure tracking logic: provider responses -> one normalised shape, milestones, what changed.

/** Normalised event codes and the job milestone they imply. */
export const EVENT_CODES = {
  gate_in: 'Gated in at origin',
  loaded: 'Loaded on vessel',
  departed: 'Departed',
  transshipment: 'Transshipment',
  arrived: 'Arrived',
  discharged: 'Discharged',
  picked_up: 'Picked up at destination',
  delivered: 'Delivered',
  empty_return: 'Empty returned',
  other: 'Update',
};

const SEA_CODES = { GTIN: 'gate_in', LOAD: 'loaded', DEPA: 'departed', TSDI: 'transshipment', TSLO: 'transshipment', TSDE: 'transshipment', ARRI: 'arrived', DISC: 'discharged', PICK: 'picked_up', GTOT: 'picked_up', DLV: 'delivered', RETN: 'empty_return' };
const AIR_CODES = { BKD: 'other', RCS: 'gate_in', MAN: 'loaded', DEP: 'departed', ARR: 'arrived', RCF: 'discharged', NFD: 'arrived', DLV: 'delivered' };
const STATUS = { BOOKED: 'booked', RECEIVED: 'booked', IN_TRANSIT: 'in_transit', DEPARTED: 'in_transit', ARRIVED: 'arrived', NOTIFIED: 'arrived', DELIVERED: 'delivered', PLANNED: 'booked' };

const t16 = (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : null);
const placeName = (l) => (l ? [l.name, l.country_code].filter(Boolean).join(', ') + (l.locode ? ` (${l.locode})` : '') : null);

/** SeaRates /tracking (sea) -> { status, carrier, pol, pod, etd, eta, vessel, voyage, position, containers, events } */
export function normaliseSeaRatesSea(json) {
  const d = json?.data || {};
  const loc = Object.fromEntries((d.locations || []).map((l) => [l.id, l]));
  const ves = Object.fromEntries((d.vessels || []).map((v) => [v.id, v]));
  const r = d.route || {};
  const events = [];
  for (const c of d.containers || []) {
    for (const e of c.events || []) {
      events.push({
        code: SEA_CODES[e.event_code] || 'other',
        description: e.description || EVENT_CODES[SEA_CODES[e.event_code]] || e.event_code || 'Update',
        location: placeName(loc[e.location]),
        at: t16(e.date),
        actual: e.actual !== false,
        container: c.number || null,
        vessel: ves[e.vessel]?.name || null,
        voyage: e.voyage || null,
      });
    }
  }
  const lastVessel = [...events].reverse().find((e) => e.vessel && e.actual) || events.find((e) => e.vessel);
  const ais = d.route_data?.ais?.data;
  return {
    status: STATUS[d.metadata?.status] || 'unknown',
    carrier: d.metadata?.sealine_name || null,
    pol: placeName(loc[r.pol?.location]),
    pod: placeName(loc[r.pod?.location]),
    etd: r.pol?.date ? { at: t16(r.pol.date), actual: !!r.pol.actual } : null,
    eta: r.pod?.date ? { at: t16(r.pod.date), actual: !!r.pod.actual } : null,
    predicted_eta: t16(r.pod?.predictive_eta) || null,
    vessel: lastVessel?.vessel || ais?.vessel?.name || null,
    voyage: lastVessel?.voyage || null,
    position: ais?.last_vessel_position?.lat ? { lat: ais.last_vessel_position.lat, lng: ais.last_vessel_position.lng, at: t16(ais.last_vessel_position.updated_at) } : (d.route_data?.pin ? { lat: d.route_data.pin[0], lng: d.route_data.pin[1], at: null } : null),
    path: (d.route_data?.route || []).map((s) => ({ points: s.path || [], type: s.type })),
    containers: (d.containers || []).map((c) => ({ number: c.number, type: c.size_type || c.iso_code || null, status: c.status || null })),
    updated_at: t16(d.metadata?.updated_at),
    events,
  };
}

/** SeaRates /air -> same shape. */
export function normaliseSeaRatesAir(json) {
  const d = json?.data || {};
  const pick = (dt) => (dt?.actual ? { at: t16(dt.actual), actual: true } : dt?.estimated ? { at: t16(dt.estimated), actual: false } : null);
  const events = (d.events || []).map((e) => ({
    code: AIR_CODES[e.event_code] || 'other',
    description: e.description || e.event_code || 'Update',
    location: placeName(e.location),
    at: t16(e.datetime_local?.actual || e.datetime_local?.estimated),
    actual: !!e.datetime_local?.actual,
    container: null,
    vessel: e.flight_number || null,
    voyage: null,
  }));
  return {
    status: STATUS[d.status] || 'unknown',
    carrier: json?.metadata?.airline?.name || null,
    pol: placeName(d.from),
    pod: placeName(d.to),
    etd: pick(d.departure_datetime_local),
    eta: pick(d.arrival_datetime_local),
    predicted_eta: null,
    vessel: null,
    voyage: null,
    flight: d.flight_number || null,
    position: null,
    path: (d.routes || []).map((s) => ({ points: s.path || [], type: s.transport_type })),
    containers: [],
    updated_at: t16(json?.metadata?.updated_at),
    events,
  };
}

/** Job milestone implied by tracking (never moves backwards; completed / cancelled stay manual). */
const ORDER = ['open', 'booking_requested', 'booked', 'departed', 'arrived', 'completed', 'cancelled'];
export function milestoneFrom(currentStatus, snapshots) {
  const evs = snapshots.flatMap((s) => s.events || []).filter((e) => e.actual);
  let next = null;
  let date = null;
  const first = (codes) => evs.filter((e) => codes.includes(e.code)).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  const arrived = first(['arrived', 'discharged', 'picked_up', 'delivered']);
  const departed = first(['departed', 'loaded']);
  if (arrived || snapshots.some((s) => s.eta?.actual)) {
    next = 'arrived';
    date = arrived?.at || snapshots.find((s) => s.eta?.actual)?.eta.at;
  } else if (departed || snapshots.some((s) => s.etd?.actual)) {
    next = 'departed';
    date = departed?.at || snapshots.find((s) => s.etd?.actual)?.etd.at;
  }
  if (!next || ['completed', 'cancelled'].includes(currentStatus) || ORDER.indexOf(next) <= ORDER.indexOf(currentStatus)) return null;
  return { status: next, date: date ? String(date).slice(0, 10) : null };
}

/** Hours between two 'YYYY-MM-DD HH:MM' local times (null if either missing). */
export function hoursBetween(a, b) {
  if (!a || !b) return null;
  return (Date.parse(`${b.replace(' ', 'T')}Z`) - Date.parse(`${a.replace(' ', 'T')}Z`)) / 3600e3;
}

/** The ETA to show: actual arrival, else the provider's predicted ETA, else the carrier's estimate. */
export const bestEta = (s) => (s?.eta?.actual ? s.eta.at : s?.predicted_eta || s?.eta?.at || null);
