// Shared job / booking building blocks: status badge, party form, booking form, cut-off list, profit summary.
import { Link } from 'react-router-dom';
import { Field, Input, Textarea, Badge, Table, Stat, money } from './ui.jsx';
import { useMeta } from './meta.jsx';

export const JOB_STATUS = {
  open: ['Open', 'gray'],
  booking_requested: ['Booking requested', 'amber'],
  booked: ['Booked', 'blue'],
  departed: ['Departed', 'purple'],
  arrived: ['Arrived', 'purple'],
  completed: ['Completed', 'green'],
  cancelled: ['Cancelled', 'red'],
};
export const BOOKING_STATUS = {
  draft: ['Not sent', 'gray'],
  requested: ['Requested', 'amber'],
  confirmed: ['Confirmed', 'green'],
  rejected: ['Agent could not book', 'red'],
  cancelled: ['Cancelled', 'gray'],
};
export const CUTOFFS = [
  ['si', 'SI'],
  ['vgm', 'VGM'],
  ['gate_in', 'Gate-in'],
  ['docs', 'Docs'],
  ['customs', 'Customs'],
];

export function StatusBadge({ status, map = JOB_STATUS }) {
  const [label, color] = map[status] || [status, 'gray'];
  return <Badge color={color}>{label}</Badge>;
}

// Dates and cut-offs are local port times kept as text ('YYYY-MM-DD' / 'YYYY-MM-DDTHH:MM'); format without time-zone shifts.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtLocal(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(String(v || ''));
  return m ? `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}${m[4] ? ` ${m[4]}` : ''}` : '—';
}

/** Shipper / consignee / notify party. */
export function PartyFields({ label, value = {}, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div className="stack-sm">
      <b>{label}</b>
      <Field label="Name"><Input value={value.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label="Address"><Textarea rows={2} value={value.address} onChange={(e) => set('address', e.target.value)} /></Field>
      <div className="grid g2">
        <Field label="Contact"><Input value={value.contact} onChange={(e) => set('contact', e.target.value)} /></Field>
        <Field label="Phone"><Input value={value.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="Email"><Input value={value.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Tax ID (GSTIN / BR)"><Input value={value.tax_id} onChange={(e) => set('tax_id', e.target.value)} /></Field>
      </div>
    </div>
  );
}

/** Booking details a person can enter or correct. */
export function BookingForm({ value, onChange, mode }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const air = mode === 'AIR';
  return (
    <div className="stack">
      <div className="grid g4">
        <Field label="Booking no."><Input value={value.booking_no} onChange={(e) => set('booking_no', e.target.value)} /></Field>
        <Field label={air ? 'Airline' : 'Carrier'}><Input value={value.carrier} onChange={(e) => set('carrier', e.target.value)} /></Field>
        {air ? (
          <Field label="Flight no."><Input value={value.flight_no} onChange={(e) => set('flight_no', e.target.value)} /></Field>
        ) : (
          <>
            <Field label="Vessel"><Input value={value.vessel} onChange={(e) => set('vessel', e.target.value)} /></Field>
            <Field label="Voyage"><Input value={value.voyage} onChange={(e) => set('voyage', e.target.value)} /></Field>
          </>
        )}
        <Field label={air ? 'MAWB' : 'MBL'}><Input value={value.mbl_awb} onChange={(e) => set('mbl_awb', e.target.value)} /></Field>
        <Field label="Port of loading"><Input value={value.pol} onChange={(e) => set('pol', e.target.value)} /></Field>
        <Field label="Port of discharge"><Input value={value.pod} onChange={(e) => set('pod', e.target.value)} /></Field>
        <Field label="ETD"><Input type="date" value={value.etd} onChange={(e) => set('etd', e.target.value)} /></Field>
        <Field label="ETA"><Input type="date" value={value.eta} onChange={(e) => set('eta', e.target.value)} /></Field>
      </div>
      <div className="grid g5">
        {CUTOFFS.map(([k, l]) => (
          <Field key={k} label={`${l} cut-off`}>
            <Input type="datetime-local" value={value.cutoffs?.[k] || ''} onChange={(e) => set('cutoffs', { ...(value.cutoffs || {}), [k]: e.target.value || undefined })} />
          </Field>
        ))}
      </div>
      <div className="grid g2">
        {!air && <Field label="Empty pick-up depot"><Input value={value.empty_pickup} onChange={(e) => set('empty_pickup', e.target.value)} /></Field>}
        {!air && <Field label="Container numbers" hint="Comma separated"><Input value={(value.container_nos || []).join(', ')} onChange={(e) => set('container_nos', e.target.value.split(',').map((x) => x.trim()))} /></Field>}
        <Field label="Remarks" span={2}><Textarea rows={2} value={value.remarks} onChange={(e) => set('remarks', e.target.value)} /></Field>
      </div>
      <p className="small muted">Cut-off times are local port time.</p>
    </div>
  );
}

/** Read-only booking summary lines. */
export function BookingSummary({ b }) {
  const rows = [
    ['Booking no.', b.booking_no],
    ['Carrier', b.carrier],
    ['Vessel / voyage', [b.vessel, b.voyage].filter(Boolean).join(' / ')],
    ['Flight', b.flight_no],
    ['MBL / MAWB', b.mbl_awb],
    ['POL → POD', [b.pol, b.pod].filter(Boolean).join(' → ')],
    ['ETD', b.etd && fmtLocal(b.etd)],
    ['ETA', b.eta && fmtLocal(b.eta)],
    ...CUTOFFS.map(([k, l]) => [`${l} cut-off`, b.cutoffs?.[k] && fmtLocal(b.cutoffs[k])]),
    ['Empty pick-up', b.empty_pickup],
    ['Containers', (b.container_nos || []).join(', ')],
    ['Remarks', b.remarks],
  ].filter(([, v]) => v);
  if (!rows.length) return <div className="muted small">No booking details yet.</div>;
  return (
    <dl className="kv">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

/** Cut-offs due soon, with links to their jobs. */
export function CutoffList({ rows, empty = 'No cut-offs in the next 3 days.' }) {
  return (
    <Table
      rows={(rows || []).map((r, i) => ({ ...r, id: `${r.booking_id}-${r.key}-${i}` }))}
      empty={empty}
      columns={[
        { label: 'When', render: (r) => <span className={r.overdue && !r.done ? 'err' : ''}><b>{fmtLocal(r.at)}</b>{r.overdue ? ' (passed)' : ''}</span> },
        { label: 'Cut-off', render: (r) => <>{r.label} {r.done ? <Badge color="green">done</Badge> : null}</> },
        { label: 'Job', render: (r) => <Link to={`/jobs/${r.job_id}`}>{r.job_ref}</Link> },
        { key: 'agent', label: 'Agent' },
      ]}
    />
  );
}

/** Buy, sell and profit; conversion problems are listed rather than hidden. */
export function ProfitSummary({ profit }) {
  if (!profit) return null;
  return (
    <div className="stack-sm">
      <div className="stats">
        <Stat label="Sell" value={money(profit.sell, profit.currency)} />
        <Stat label="Buy" value={money(profit.buy, profit.currency)} />
        <Stat label={`Profit (${profit.margin_pct}% of sell)`} value={money(profit.profit, profit.currency)} tone={profit.profit < 0 ? 'warn' : ''} />
      </div>
      {profit.errors?.length ? <div className="alert alert-amber">Some lines are left out: {profit.errors.join('; ')}. Add the exchange rate in Settings → Pricing.</div> : null}
    </div>
  );
}

export function LegList({ legs }) {
  const meta = useMeta();
  return <span>{(legs || []).map(meta.legName).join(', ')}</span>;
}
