// One consol: the master (carrier, MAWB, buy rate), its houses, totals and profit.
import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { PageHeader, Card, Button, Table, Field, Input, Select, Modal, Check, Loading, ErrorBox, ReadOnly, useLoad, useAction, money, fmtDate } from '../components/ui.jsx';
import { ConsolStats, FreeSpace, HouseWeights, ConsolStatus, PiecesEditor } from '../components/consol.jsx';
import { useMeta } from '../components/meta.jsx';
import { useCan } from '../components/session.js';

const NEXT = { planning: ['closed'], closed: ['planning', 'departed'], departed: ['arrived'] };
const LABEL = { closed: 'Close (cut-off)', planning: 'Reopen', departed: 'Mark departed', arrived: 'Mark arrived' };

export default function ConsolDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const can = useCan();
  const meta = useMeta();
  const d = useLoad(() => api.get(`/consols/${id}`), [id], { refresh: 30000 });
  const [form, setForm] = useState(null);
  const [adding, setAdding] = useState(null);
  const [pieces, setPieces] = useState(null);
  const [mile, setMile] = useState(null);
  const [busy, run] = useAction();
  useEffect(() => { if (d.data && !form) setForm(d.data.consol); }, [d.data, form]);
  if (d.error) return <ErrorBox error={d.error} />;
  if (!d.data || !form) return <Loading />;
  const { consol: c, houses, economics: e, capacity, card_rate: cardRate, warnings, candidates } = d.data;
  const set = (data) => { d.setData(data); setForm(data.consol); };
  const f = (k) => ({ value: form[k] ?? '', onChange: (ev) => setForm({ ...form, [k]: ev.target.value }) });
  const air = c.mode === 'AIR';
  const open = c.status === 'planning';
  const costs = can('costs.view');
  const lane = candidates.filter((h) => !c.origin || String(h.origin).toUpperCase().includes(String(c.origin).toUpperCase().replace(/.*\((\w+)\).*/, '$1')));
  return (
    <>
      <PageHeader title={<>{c.ref} <ConsolStatus status={c.status} /></>} sub={<>{air ? 'Air' : `Sea LCL · ${c.container_type}`} · {c.origin || '?'} → {c.destination || '?'}{c.mawb ? ` · ${air ? 'MAWB' : 'MBL'} ${c.mawb}` : ''}</>}
        actions={<div className="row gap-sm wrap">
          <a className="btn btn-ghost btn-sm" href={`/api/consols/${c.id}/manifest.pdf`} target="_blank" rel="noreferrer">Manifest PDF</a>
          {can('jobs.manage') && (NEXT[c.status] || []).map((s) => <Button key={s} small variant={s === 'planning' ? 'ghost' : 'primary'} onClick={() => (s === 'departed' || s === 'arrived' ? setMile({ status: s, date: new Date().toISOString().slice(0, 10), notify: true }) : run(s, async () => set(await api.post(`/consols/${c.id}/status`, { status: s }))))}>{LABEL[s]}</Button>)}
          {can('jobs.manage') && open && <Button small variant="ghost" busy={busy === 'del'} onClick={() => confirm(`Delete ${c.ref}? Its jobs go back to the agent's pool.`) && run('del', async () => { await api.del(`/consols/${c.id}`); nav('/consols'); })}>Delete</Button>}
        </div>} />
      <ReadOnly when={!can('jobs.manage')}>
      <div className="stack">
        <Card title="Totals">
          <ConsolStats e={e} currency={c.buy_currency} capacity={capacity} />
          {capacity?.kg && air && e.chargeable > capacity.kg && <div className="alert alert-red small">Over capacity: {e.chargeable} of {capacity.kg} kg.</div>}
          {!air && capacity && <div className="small muted">{Math.round((e.cbm / capacity.cbm) * 100)}% of the {c.container_type} by volume, {Math.round((e.gross / capacity.kg) * 100)}% by weight.</div>}
          <FreeSpace e={e} />
          {warnings.map((w) => <div key={w} className="alert alert-amber small">{w}</div>)}
          {costs && e.saving !== null && <div className="small muted">The agents quoted {money(e.standalone, c.buy_currency)} to fly these shipments one by one; consolidated the master costs {money(e.cost, c.buy_currency)}.</div>}
        </Card>

        <Card title="Master" actions={<Button small busy={busy === 'save'} onClick={() => run('save', async () => set(await api.put(`/consols/${c.id}`, form)), 'Saved')}>Save</Button>}>
          <div className="grid g4">
            <Field label="Carrier"><Input {...f('carrier')} placeholder={air ? 'e.g. Cathay Pacific (CX)' : 'e.g. ONE'} /></Field>
            {air ? <Field label="Flight"><Input {...f('flight_no')} placeholder="e.g. CX 631" /></Field> : <><Field label="Vessel"><Input {...f('vessel')} /></Field><Field label="Voyage"><Input {...f('voyage')} /></Field></>}
            <Field label={air ? 'MAWB' : 'Master BL'} hint="Every house is tracked on this number"><Input {...f('mawb')} /></Field>
            <Field label="ETD"><Input type="date" {...f('etd')} value={form.etd ? String(form.etd).slice(0, 10) : ''} /></Field>
            <Field label="ETA"><Input type="date" {...f('eta')} value={form.eta ? String(form.eta).slice(0, 10) : ''} /></Field>
            <Field label="From"><Input {...f('origin')} /></Field>
            <Field label="To"><Input {...f('destination')} /></Field>
            {air && <Field label="Capacity (chargeable kg)" hint="Optional"><Input type="number" {...f('capacity_kg')} /></Field>}
          </div>
          {costs && (
            <div className="grid g4">
              <Field label="Buy currency"><Select {...f('buy_currency')} options={meta.currencies} /></Field>
              {air ? <>
                <Field label="Buy rate per kg" hint={cardRate?.rate ? `Rate card: ${money(cardRate.rate, cardRate.currency)}/kg (${cardRate.card_name})` : 'No rate card for this route'}><Input type="number" {...f('buy_rate')} /></Field>
                <Field label="Minimum charge"><Input type="number" {...f('buy_min')} /></Field>
                <Field label="Fixed charges" hint="AWB fee, screening, handling…"><Input type="number" {...f('buy_fixed')} /></Field>
              </> : <Field label="Container cost" hint={cardRate?.total ? `Rate card: ${money(cardRate.total, cardRate.currency)}` : ''}><Input type="number" {...f('buy_fixed')} /></Field>}
            </div>
          )}
          {costs && cardRate && <Button small variant="ghost" onClick={() => setForm({ ...form, buy_currency: cardRate.currency, ...(air ? { buy_rate: cardRate.rate } : { buy_fixed: cardRate.total }) })}>Use the rate card</Button>}
        </Card>

        <Card title={`Shipments (${houses.length})`} actions={<div className="row gap-sm">
          {costs && houses.length > 0 && <Button small variant="ghost" busy={busy === 'costs'} onClick={() => run('costs', async () => set(await api.post(`/consols/${c.id}/apply-costs`)), "Cost shared across the jobs' cost sheets")}>Share cost to jobs</Button>}
          {open && <Button small onClick={() => setAdding([])}>+ Add jobs</Button>}
        </div>}>
          <Table rows={houses} empty="No shipments yet." columns={[
            { label: air ? 'HAWB' : 'HBL', render: (h) => <HawbInput h={h} consolId={c.id} onSaved={set} /> },
            { label: 'Job', render: (h) => <Link to={`/jobs/${h.id}`}>{h.ref}</Link> },
            { label: 'Customer', render: (h) => h.customer || '—' },
            { label: 'Commodity', render: (h) => h.commodity || '—' },
            { label: 'Weights', render: (h) => <HouseWeights w={h.weights} /> },
            ...(costs ? [{ label: 'Freight sold', render: (h) => money(h.sell_amount, c.buy_currency), align: 'right' }] : []),
            { label: '', render: (h) => <div className="row gap-sm">
              <Button small variant="ghost" onClick={() => setPieces(h)}>Dimensions</Button>
              {open && <Button small variant="ghost" busy={busy === `rm${h.id}`} onClick={() => run(`rm${h.id}`, async () => set(await api.del(`/consols/${c.id}/houses/${h.id}`)))}>Remove</Button>}
            </div> },
          ]} />
          {costs && <p className="small muted">“Share cost to jobs” puts this master's cost on each job's cost sheet in proportion to its chargeable weight, replacing the agent's stand-alone freight cost, so job profit shows the consolidation gain.</p>}
        </Card>
        {c.notes && <Card title="Notes"><p className="small">{c.notes}</p></Card>}
      </div>
      </ReadOnly>

      {adding && (
        <Modal wide title="Add jobs to this consol" onClose={() => setAdding(null)} footer={<Button disabled={!adding.length} busy={busy === 'add'} onClick={() => run('add', async () => { set(await api.post(`/consols/${c.id}/houses`, { job_ids: adding })); setAdding(null); })}>Add {adding.length || ''}</Button>}>
          <Table rows={lane.length ? lane : candidates} empty={`No open ${c.mode} jobs outside a consol.`} columns={[
            { label: '', render: (h) => <input type="checkbox" checked={adding.includes(h.id)} onChange={(ev) => setAdding(ev.target.checked ? [...adding, h.id] : adding.filter((x) => x !== h.id))} /> },
            { label: 'Job', key: 'ref' },
            { label: 'Customer', render: (h) => h.customer || '—' },
            { label: 'Route', render: (h) => `${h.origin || '?'} → ${h.destination || '?'}` },
            { label: 'Ready', render: (h) => fmtDate(h.ready_date) },
            { label: 'Weights', render: (h) => <HouseWeights w={h.weights} /> },
          ]} />
        </Modal>
      )}
      {pieces && (
        <Modal wide title={`Dimensions: ${pieces.ref}`} onClose={() => setPieces(null)}>
          <PiecesEditor value={pieces.pieces} busy={busy === 'pcs'} disabled={!can('jobs.manage')} onSave={(rows) => run('pcs', async () => { set(await api.put(`/consols/${c.id}/houses/${pieces.id}`, { pieces: rows })); setPieces(null); }, 'Dimensions saved')} />
        </Modal>
      )}
      {mile && (
        <Modal title={LABEL[mile.status]} onClose={() => setMile(null)} footer={<Button busy={busy === 'mile'} onClick={() => run('mile', async () => { set(await api.post(`/consols/${c.id}/status`, mile)); setMile(null); }, 'Every shipment in the consol updated')}>Save</Button>}>
          <Field label="Date"><Input type="date" value={mile.date} onChange={(ev) => setMile({ ...mile, date: ev.target.value })} /></Field>
          <Check label="Email each customer" checked={mile.notify} onChange={(v) => setMile({ ...mile, notify: v })} />
          <p className="small muted">All {houses.length} jobs in this consol are marked {mile.status} on this date.</p>
        </Modal>
      )}
    </>
  );
}

function HawbInput({ h, consolId, onSaved }) {
  const [v, setV] = useState(h.hawb || '');
  const [busy, run] = useAction();
  useEffect(() => setV(h.hawb || ''), [h.hawb]);
  const save = () => v !== (h.hawb || '') && run('h', async () => onSaved(await api.put(`/consols/${consolId}/houses/${h.id}`, { hawb: v })));
  return <Input style={{ width: 130 }} value={v} disabled={busy === 'h'} onChange={(e) => setV(e.target.value)} onBlur={save} />;
}
