// Shared RFQ building blocks: shipment form, leg picker, agent picker, quote line editor.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useMeta } from './meta.jsx';
import { Field, Input, Select, Textarea, Button, Check, Badge, Table, useLoad } from './ui.jsx';

export const routeOf = (r) => [r.pickup_place, r.pol, r.pod, r.delivery_place].filter(Boolean).join(' → ') || '—';

export function cargoOf(r) {
  if (r.mode === 'FCL') return (r.containers || []).map((c) => `${c.qty}×${c.type}`).join(', ');
  return [r.packages && `${r.packages} pkgs`, r.gross_weight_kg && `${r.gross_weight_kg} kg`, r.volume_cbm && `${r.volume_cbm} cbm`].filter(Boolean).join(' / ');
}

function ContainerEditor({ value = [], onChange }) {
  const meta = useMeta();
  const rows = value.length ? value : [{ type: '40HC', qty: 1 }];
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="stack-sm">
      {rows.map((r, i) => (
        <div className="row gap" key={i}>
          <Input type="number" min="1" style={{ width: 70 }} value={r.qty} onChange={(e) => set(i, 'qty', Number(e.target.value))} />
          <Select options={meta.containerTypes} value={r.type} onChange={(e) => set(i, 'type', e.target.value)} />
          {rows.length > 1 && <button type="button" className="link" onClick={() => onChange(rows.filter((_, j) => j !== i))}>remove</button>}
        </div>
      ))}
      <button type="button" className="link" onClick={() => onChange([...rows, { type: '20GP', qty: 1 }])}>+ add container type</button>
    </div>
  );
}

export function LegPicker({ value = [], onChange }) {
  const meta = useMeta();
  const toggle = (c) => onChange(value.includes(c) ? value.filter((x) => x !== c) : meta.legs.map((l) => l.code).filter((x) => x === c || value.includes(x)));
  return (
    <div className="leg-picker">
      {meta.legs.map((l) => <Check key={l.code} label={l.name} checked={value.includes(l.code)} onChange={() => toggle(l.code)} />)}
    </div>
  );
}

/** Shipment details form, used for new and existing RFQs. */
export function ShipmentForm({ value, onChange, parties = [], mailboxes = [] }) {
  const meta = useMeta();
  const set = (k, v) => onChange({ ...value, [k]: v });
  const inp = (k, props = {}) => <Input {...props} value={value[k]} onChange={(e) => set(k, props.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />;
  return (
    <div className="stack">
      <div className="grid g4">
        <Field label="Requested by">
          <Select
            options={parties.filter((p) => p.active !== false).map((p) => ({ value: p.id, label: `${p.company}${p.is_agent && !p.is_customer ? ' (partner agent)' : p.is_agent ? ' (customer + agent)' : ''}` }))}
            value={value.requester_id}
            placeholder="— select —"
            onChange={(e) => {
              const p = parties.find((x) => x.id === Number(e.target.value));
              onChange({ ...value, requester_id: p ? p.id : '', requester_role: p ? (p.is_agent && !p.is_customer ? 'agent' : value.requester_role || 'customer') : value.requester_role });
            }}
          />
        </Field>
        <Field label="Requester is">
          <Select options={[{ value: 'customer', label: 'Our customer' }, { value: 'agent', label: 'A partner agent (for their customer)' }]} value={value.requester_role || 'customer'} onChange={(e) => set('requester_role', e.target.value)} />
        </Field>
        <Field label="Their reference">{inp('requester_ref', { placeholder: 'Their enquiry / job no.' })}</Field>
        <Field label="Mode"><Select options={meta.modes.map((m) => ({ value: m.code, label: m.name }))} value={value.mode} onChange={(e) => set('mode', e.target.value)} /></Field>
        <Field label="Incoterm"><Select options={meta.incoterms} placeholder="—" value={value.incoterm} onChange={(e) => set('incoterm', e.target.value)} /></Field>
        <Field label="Send from mailbox">
          <Select options={mailboxes.filter((m) => m.active).map((m) => ({ value: m.id, label: `${m.label} <${m.from_email}>` }))} placeholder="Default mailbox" value={value.mailbox_id} onChange={(e) => set('mailbox_id', e.target.value ? Number(e.target.value) : '')} />
        </Field>
        <Field label="Pickup place (door)">{inp('pickup_place', { placeholder: 'e.g. Sriperumbudur factory' })}</Field>
        <Field label="Port / airport of loading">{inp('pol', { placeholder: 'e.g. Chennai (INMAA)' })}</Field>
        <Field label="Port / airport of discharge">{inp('pod', { placeholder: 'e.g. Hong Kong (HKHKG)' })}</Field>
        <Field label="Delivery place (door)">{inp('delivery_place')}</Field>
        {value.mode === 'FCL' ? (
          <Field label="Containers" span={2}><ContainerEditor value={value.containers} onChange={(v) => set('containers', v)} /></Field>
        ) : (
          <>
            <Field label="Packages">{inp('packages', { type: 'number' })}</Field>
            <Field label="Volume (cbm)">{inp('volume_cbm', { type: 'number', step: '0.01' })}</Field>
          </>
        )}
        <Field label="Gross weight (kg)">{inp('gross_weight_kg', { type: 'number' })}</Field>
        <Field label="Commodity">{inp('commodity')}</Field>
        <Field label="Cargo ready date">{inp('ready_date', { type: 'date' })}</Field>
        <Field label="Agents reply by">{inp('deadline', { type: 'datetime-local' })}</Field>
        <Field label="HS code">{inp('hs_code', { placeholder: 'e.g. 8708.99' })}</Field>
        <Field label="Dimensions">{inp('dimensions', { placeholder: 'e.g. 4 pallets 120x100x150 cm' })}</Field>
        {value.mode !== 'AIR' && <Field label="Reefer temperature">{inp('reefer_temp', { placeholder: 'e.g. -18 C (blank = dry)' })}</Field>}
        <Field label="Cargo value (for insurance)">
          <div className="row gap-sm"><Input type="number" value={value.cargo_value} onChange={(e) => set('cargo_value', e.target.value === '' ? '' : Number(e.target.value))} /><Select options={meta.currencies} placeholder="—" value={value.cargo_value_currency} onChange={(e) => set('cargo_value_currency', e.target.value)} /></div>
        </Field>
        <Field label="Dangerous goods">
          <div className="row gap-sm">
            <Check label="DG" checked={value.dangerous_goods} onChange={(v) => set('dangerous_goods', v)} />
            {value.dangerous_goods && <><Input placeholder="Class" style={{ width: 70 }} value={value.dg_class} onChange={(e) => set('dg_class', e.target.value)} /><Input placeholder="UN no." style={{ width: 90 }} value={value.un_number} onChange={(e) => set('un_number', e.target.value)} /></>}
          </div>
        </Field>
        {value.mode !== 'FCL' && <Field label="Stackable"><Check label="Cargo can be stacked" checked={value.stackable !== false} onChange={(v) => set('stackable', v)} /></Field>}
        <Field label="Notes for agents" span={2}><Textarea rows={2} value={value.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Hazardous, temperature, special equipment…" /></Field>
      </div>
      <Field label="Legs to price"><LegPicker value={value.legs} onChange={(v) => set('legs', v)} /></Field>
    </div>
  );
}

/** Choose partner agents and which legs each should quote. invites: [{agent_id, legs}] */
export function AgentPicker({ rfq, invites, onChange, locked = [] }) {
  const meta = useMeta();
  const all = useLoad(() => api.get('/agents?role=agent'));
  const [sugg, setSugg] = useState([]);
  const [search, setSearch] = useState('');
  useEffect(() => {
    const p = new URLSearchParams({ legs: (rfq.legs || []).join(','), pol: rfq.pol || '', pod: rfq.pod || '', pickup: rfq.pickup_place || '', delivery: rfq.delivery_place || '', exclude: rfq.requester_id || '' });
    api.get(`/agents/suggest?${p}`).then(setSugg).catch(() => setSugg([]));
  }, [rfq.legs, rfq.pol, rfq.pod, rfq.pickup_place, rfq.delivery_place, rfq.requester_id]);
  const agents = (all.data || []).filter((a) => a.active && a.is_agent && a.id !== rfq.requester_id);
  const chosen = new Map(invites.map((i) => [i.agent_id, i]));
  const add = (a, legs) => onChange([...invites, { agent_id: a.id, legs: legs?.length ? legs.filter((l) => rfq.legs.includes(l)) : rfq.legs }]);
  const remove = (aid) => onChange(invites.filter((i) => i.agent_id !== aid));
  const toggleLeg = (aid, leg) => onChange(invites.map((i) => (i.agent_id === aid ? { ...i, legs: i.legs.includes(leg) ? i.legs.filter((l) => l !== leg) : [...i.legs, leg] } : i)));
  const filtered = agents.filter((a) => !chosen.has(a.id) && (!search || `${a.company} ${a.ports} ${a.country} ${a.city}`.toLowerCase().includes(search.toLowerCase())));
  const suggested = sugg.filter((s) => !chosen.has(s.id)).slice(0, 6);
  return (
    <div className="stack">
      {invites.length > 0 && (
        <Table
          rowKey="agent_id"
          rows={invites}
          columns={[
            { label: 'Agent', render: (i) => { const a = agents.find((x) => x.id === i.agent_id) || {}; return <div><b>{a.company}</b><div className="muted small">{a.email}</div></div>; } },
            { label: 'Legs to quote', render: (i) => <div className="chips">{(rfq.legs || []).map((l) => <button type="button" key={l} disabled={locked.includes(i.agent_id)} className={`chip${i.legs.includes(l) ? ' on' : ''}`} onClick={() => toggleLeg(i.agent_id, l)}>{meta.legName(l)}</button>)}</div> },
            { label: '', render: (i) => (locked.includes(i.agent_id) ? <Badge color="blue">sent</Badge> : <button type="button" className="link" onClick={() => remove(i.agent_id)}>remove</button>) },
          ]}
        />
      )}
      {suggested.length > 0 && (
        <div>
          <div className="field-l">Suggested for this route</div>
          <div className="sugg">
            {suggested.map((s) => (
              <button type="button" key={s.id} className="sugg-item" onClick={() => add(s, s.suggested_legs)}>
                <b>+ {s.company}</b>
                <span className="muted small">{[s.city, s.country].filter(Boolean).join(', ')}{s.response_rate !== null ? ` · replies ${s.response_rate}%` : ''}{s.won ? ` · won ${s.won}` : ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="row gap">
        <Input placeholder="Search all agents…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {search && (
        <div className="sugg">
          {filtered.slice(0, 12).map((a) => (
            <button type="button" key={a.id} className="sugg-item" onClick={() => { add(a); setSearch(''); }}>
              <b>+ {a.company}</b><span className="muted small">{a.ports || a.country}</span>
            </button>
          ))}
          {!filtered.length && <span className="muted">No match. Add agents in Settings → Partner agents.</span>}
        </div>
      )}
    </div>
  );
}

const blankLine = (leg = 'freight') => ({ leg, charge_code: 'OFR', description: '', basis: 'per_container', rate: '', currency: 'USD', qty: '' });

/**
 * Editable table of charge lines. Shared by agent-quote review/entry and rate cards.
 * opts: { leg: show leg column (legs = allowed), qty: show qty override, equipment: show container type, breaks: show weight breaks + minimum }
 */
export function ChargeLinesTable({ lines, onChange, legs, opts = {}, newLine }) {
  const meta = useMeta();
  const setLine = (i, k, v) => onChange(lines.map((l, j) => (j === i ? { ...l, [k]: v, ...(k !== 'confidence' ? { confidence: 1 } : {}) } : l)));
  const onCode = (i, code) => {
    const c = meta.charges.find((x) => x.code === code);
    onChange(lines.map((l, j) => {
      if (j !== i) return l;
      // replace text/basis that were auto-filled from the previous charge; keep anything the user typed
      const prev = meta.charges.find((x) => x.code === l.charge_code);
      const autoDesc = !l.description || l.description === prev?.name;
      const autoBasis = !l.basis || l.basis === prev?.basis;
      return { ...l, charge_code: code, confidence: 1, description: autoDesc ? c?.name : l.description, basis: autoBasis ? c?.basis : l.basis };
    }));
  };
  const numIn = (i, k, w = 80, ph) => <Input type="number" step="0.01" style={{ width: w, textAlign: 'right' }} placeholder={ph} value={lines[i][k]} onChange={(e) => setLine(i, k, e.target.value === '' ? '' : Number(e.target.value))} />;
  const low = (l) => l.confidence !== undefined && l.confidence !== null && l.confidence < 0.75;
  return (
    <div className="stack-sm">
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              {opts.leg && <th>Leg</th>}
              <th>Charge</th><th>Description</th><th>Basis</th>
              {opts.equipment && <th>Container</th>}
              <th>Cur</th><th style={{ textAlign: 'right' }}>Rate</th>
              {opts.breaks && <><th>From</th><th>To</th><th>Minimum</th></>}
              {opts.qty && <th>Qty override</th>}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className={low(l) ? 'low-conf' : ''}>
                {opts.leg && <td><Select options={meta.legOptions.filter((o) => !legs || legs.includes(o.value) || o.value === l.leg)} value={l.leg} onChange={(e) => setLine(i, 'leg', e.target.value)} /></td>}
                <td><Select options={meta.chargeOptions} value={l.charge_code} onChange={(e) => onCode(i, e.target.value)} /></td>
                <td><Input value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} /></td>
                <td><Select options={meta.basisOptions} value={l.basis} onChange={(e) => setLine(i, 'basis', e.target.value)} /></td>
                {opts.equipment && <td><Select options={meta.containerTypes} placeholder="All" value={l.equipment} onChange={(e) => setLine(i, 'equipment', e.target.value)} /></td>}
                <td><Select options={meta.currencies.includes(l.currency) ? meta.currencies : [...meta.currencies, l.currency]} value={l.currency} onChange={(e) => setLine(i, 'currency', e.target.value)} /></td>
                <td>{numIn(i, 'rate', 100)}</td>
                {opts.breaks && <><td>{numIn(i, 'qty_from', 70, '—')}</td><td>{numIn(i, 'qty_to', 70, '—')}</td><td>{numIn(i, 'min_amount', 80, '—')}</td></>}
                {opts.qty && <td>{numIn(i, 'qty', 70, 'auto')}</td>}
                <td>
                  {low(l) && <span title="AI was unsure" className="warn-dot">!</span>}
                  <button type="button" className="link" onClick={() => onChange(lines.filter((_, j) => j !== i))}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div><Button type="button" variant="ghost" small onClick={() => onChange([...lines, newLine ? newLine() : blankLine(legs?.[0])])}>+ Add charge</Button></div>
    </div>
  );
}

/** Edit the lines and terms of an agent quote. Used for AI review and manual entry. */
export function QuoteEditor({ value, onChange, legs }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div className="stack">
      <div className="grid g6">
        <Field label="Valid until"><Input type="date" value={value.valid_until?.slice?.(0, 10)} onChange={(e) => set('valid_until', e.target.value)} /></Field>
        <Field label="Transit (days)"><Input type="number" value={value.transit_days} onChange={(e) => set('transit_days', e.target.value === '' ? null : Number(e.target.value))} /></Field>
        <Field label="Free days"><Input type="number" value={value.free_days} onChange={(e) => set('free_days', e.target.value === '' ? null : Number(e.target.value))} /></Field>
        <Field label="Carrier"><Input value={value.carrier} onChange={(e) => set('carrier', e.target.value)} /></Field>
        <Field label="Routing" span={2}><Input value={value.routing} onChange={(e) => set('routing', e.target.value)} /></Field>
        <Field label="Exclusions / at actuals" span={3}><Input value={value.exclusions} onChange={(e) => set('exclusions', e.target.value)} /></Field>
        <Field label="Remarks" span={3}><Input value={value.remarks} onChange={(e) => set('remarks', e.target.value)} /></Field>
      </div>
      <ChargeLinesTable lines={value.lines || []} onChange={(l) => set('lines', l)} legs={legs} opts={{ leg: true, qty: true }} />
    </div>
  );
}
