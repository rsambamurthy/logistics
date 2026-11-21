// Pure job logic: costs from an accepted quotation option, profit, status from bookings, cut-offs.
import { convert } from './costing.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const JOB_STATUSES = ['open', 'booking_requested', 'booked', 'departed', 'arrived', 'completed', 'cancelled'];
export const MILESTONES = ['departed', 'arrived', 'completed', 'cancelled'];
export const CUTOFF_KEYS = [
  ['si', 'SI cut-off'],
  ['vgm', 'VGM cut-off'],
  ['gate_in', 'Gate-in cut-off'],
  ['docs', 'Docs cut-off'],
  ['customs', 'Customs cut-off'],
];

/**
 * Cost lines and bookings to create from one option of an accepted quotation snapshot.
 * Sell lines in the quotation currency; buy lines in the agent's currency; one booking per agent invite.
 */
export function jobPlanFromOption(option, currency) {
  const costs = [];
  const bookings = new Map();
  for (const s of option?.sections || []) {
    for (const l of s.lines || []) {
      costs.push({ kind: 'sell', leg: s.leg, description: l.description, amount: round2(l.sell_amount), currency, invite_id: s.invite_id || null });
      costs.push({ kind: 'buy', leg: s.leg, description: l.description, charge_code: l.charge_code || null, amount: round2(l.buy_amount), currency: l.buy_currency, invite_id: s.invite_id || null });
    }
    if (s.invite_id) {
      const b = bookings.get(s.invite_id) || { invite_id: s.invite_id, legs: [] };
      if (!b.legs.includes(s.leg)) b.legs.push(s.leg);
      bookings.set(s.invite_id, b);
    }
  }
  return { costs, bookings: [...bookings.values()] };
}

/** Buy, sell and profit in one currency. Lines that cannot be converted are reported, not guessed. */
export function jobProfit(costs, fx, currency = fx.base) {
  let buy = 0;
  let sell = 0;
  const errors = [];
  for (const c of costs || []) {
    let v;
    try {
      v = convert(Number(c.amount), c.currency, currency, fx);
    } catch (e) {
      errors.push(e.message);
      continue;
    }
    if (c.kind === 'sell') sell += v;
    else if (c.kind === 'buy') buy += v; // 'buy_replaced' = freight cost set aside by a consol
  }
  const profit = sell - buy;
  return { currency, buy: round2(buy), sell: round2(sell), profit: round2(profit), margin_pct: sell ? round2((profit / sell) * 100) : 0, errors: [...new Set(errors)] };
}

/**
 * Status from the bookings, unless a milestone (departed / arrived / completed / cancelled) was set by a person.
 */
export function deriveJobStatus(current, bookings) {
  if (MILESTONES.includes(current)) return current;
  const live = (bookings || []).filter((b) => b.status !== 'cancelled');
  if (live.length && live.every((b) => b.status === 'confirmed')) return 'booked';
  if (live.some((b) => ['requested', 'confirmed', 'rejected'].includes(b.status))) return 'booking_requested';
  return 'open';
}

/** Hours ahead of UTC for the tenant's home country (cut-offs are written in local port time). */
export const tzOffset = (country) => ({ HK: 8, SG: 8, CN: 8, AE: 4, IN: 5.5 }[String(country || 'IN').toUpperCase()] ?? 5.5);

/** A local port time ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM') as epoch ms. A date without a time counts as end of day. */
export const localTime = (v, offsetHours = 5.5) => {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(String(v || ''));
  return m ? Date.parse(`${m[1]}T${m[2] || '23:59'}:00Z`) - offsetHours * 3600e3 : NaN;
};

/** Cut-offs from bookings that fall between now and now + hours (also those already passed within the last 12 h). */
export function cutoffsDue(bookings, now = new Date(), hours = 72, offsetHours = 5.5) {
  const from = now.getTime() - 12 * 3600e3;
  const to = now.getTime() + hours * 3600e3;
  const out = [];
  for (const b of bookings || []) {
    if (b.status === 'cancelled') continue;
    for (const [k, label] of CUTOFF_KEYS) {
      const v = b.cutoffs?.[k];
      const t = v ? localTime(v, offsetHours) : NaN;
      if (Number.isFinite(t) && t >= from && t <= to) out.push({ booking_id: b.id, job_id: b.job_id, job_ref: b.job_ref, key: k, label, at: v, overdue: t < now.getTime() });
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** What a booking reply would change: only filled values, and only fields that differ. */
export function bookingChanges(booking, parsed) {
  const fields = ['booking_no', 'carrier', 'vessel', 'voyage', 'flight_no', 'mbl_awb', 'pol', 'pod', 'etd', 'eta', 'empty_pickup', 'remarks'];
  const out = {};
  for (const f of fields) {
    const v = parsed[f];
    if (v === null || v === undefined || v === '') continue;
    const cur = booking[f] instanceof Date ? booking[f].toISOString() : booking[f];
    if (String(cur ?? '') !== String(v)) out[f] = v;
  }
  const cut = { ...(booking.cutoffs || {}), ...(parsed.cutoffs || {}) };
  if (JSON.stringify(cut) !== JSON.stringify(booking.cutoffs || {})) out.cutoffs = cut;
  if (parsed.container_nos?.length) out.container_nos = [...new Set([...(booking.container_nos || []), ...parsed.container_nos])];
  return out;
}
