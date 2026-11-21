// Consolidation desk: the consolidation agent's plan for open air / LCL jobs, and the consols.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { ShipOrWait, LaneForecast } from '../components/planning.jsx';
import { PageHeader, Card, Button, Table, Tabs, Badge, Field, Input, Select, Modal, Loading, ErrorBox, useLoad, useAction, money, fmtDate } from '../components/ui.jsx';
import { ConsolStats, FreeSpace, HouseWeights, ConsolStatus, VERDICT } from '../components/consol.jsx';
import { useCan } from '../components/session.js';

export default function Consols() {
  const can = useCan();
  const [tab, setTab] = useState(can('costs.view') && can('jobs.manage') ? 'agent' : 'consols');
  return (
    <>
      <PageHeader title="Consolidation" sub="Several shipments under one master air waybill or in one container. The consolidation agent plans which ones travel together." />
      <Tabs active={tab} onChange={setTab} tabs={[...(can('costs.view') && can('jobs.manage') ? [{ key: 'agent', label: 'Consolidation agent' }] : []), { key: 'consols', label: 'Consols' }, { key: 'space', label: 'Space planning' }]} />
      {tab === 'agent' && <AgentPlan onAccepted={() => setTab('consols')} />}
      {tab === 'consols' && <ConsolList />}
      {tab === 'space' && <LaneForecast />}
    </>
  );
}

function ConsolList() {
  const nav = useNavigate();
  const can = useCan();
  const [status, setStatus] = useState('active');
  const [add, setAdd] = useState(null);
  const [busy, run] = useAction();
  const list = useLoad(() => api.get(`/consols${status ? `?status=${status}` : ''}`), [status], { refresh: 60000 });
  return (
    <Card actions={<div className="row gap-sm">
      <Select value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: 'active', label: 'Active' }, { value: '', label: 'All' }, { value: 'arrived', label: 'Arrived' }, { value: 'cancelled', label: 'Cancelled' }]} />
      {can('jobs.manage') && <Button small onClick={() => setAdd({ mode: 'AIR' })}>+ New consol</Button>}
    </div>}>
      {list.error ? <ErrorBox error={list.error} /> : !list.data ? <Loading /> : (
        <Table rows={list.data} onRowClick={(c) => nav(`/consols/${c.id}`)} empty="No consols yet. Let the consolidation agent plan them, or create one." columns={[
          { label: 'Consol', render: (c) => <><b>{c.ref}</b> <ConsolStatus status={c.status} /></> },
          { label: 'Mode', key: 'mode' },
          { label: 'Route', render: (c) => `${c.origin || '?'} → ${c.destination || '?'}` },
          { label: 'Carrier / flight', render: (c) => [c.carrier, c.flight_no || c.vessel].filter(Boolean).join(' ') || '—' },
          { label: 'MAWB / MBL', render: (c) => c.mawb || '—' },
          { label: 'ETD', render: (c) => fmtDate(c.etd) },
          { label: 'Shipments', render: (c) => c.houses },
          { label: 'Gain', render: (c) => (c.economics?.gain ? `${c.economics.gain} kg` : '—'), align: 'right' },
          { label: 'Profit', render: (c) => (c.economics?.profit !== null && c.economics?.profit !== undefined ? money(c.economics.profit, c.buy_currency) : '—'), align: 'right' },
        ]} />
      )}
      {add && (
        <Modal title="New consol" onClose={() => setAdd(null)} footer={<Button busy={busy === 'new'} onClick={() => run('new', async () => { const c = await api.post('/consols', add); nav(`/consols/${c.id}`); })}>Create</Button>}>
          <div className="grid g2">
            <Field label="Mode"><Select value={add.mode} onChange={(e) => setAdd({ ...add, mode: e.target.value })} options={[{ value: 'AIR', label: 'Air' }, { value: 'LCL', label: 'Sea LCL (container)' }]} /></Field>
            {add.mode === 'LCL' && <Field label="Container"><Select value={add.container_type || '40HC'} onChange={(e) => setAdd({ ...add, container_type: e.target.value })} options={['20GP', '40GP', '40HC']} /></Field>}
            <Field label="From"><Input value={add.origin} placeholder="e.g. Hong Kong (HKG)" onChange={(e) => setAdd({ ...add, origin: e.target.value })} /></Field>
            <Field label="To"><Input value={add.destination} placeholder="e.g. Chennai (MAA)" onChange={(e) => setAdd({ ...add, destination: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function AgentPlan({ onAccepted }) {
  const nav = useNavigate();
  const settings = useLoad(() => api.get('/settings'));
  const [opts, setOpts] = useState(null);
  const o = opts || { window_days: settings.data?.consol?.window_days ?? 3, capacity_kg: settings.data?.consol?.capacity_kg ?? '', container: settings.data?.consol?.container || '40HC' };
  const [query, setQuery] = useState('');
  const plan = useLoad(() => api.get(`/consols/plan${query}`), [query], { refresh: 120000 });
  const [review, setReview] = useState(null);
  const [busy, run] = useAction();
  const rerun = () => setQuery(`?windowDays=${o.window_days}&capacityKg=${o.capacity_kg || 0}&container=${o.container}`);
  const saveDefaults = () => run('def', async () => { await api.put('/settings/consol', o); }, 'Saved as defaults');
  const ask = () => run('ai', async () => setReview(await api.post('/consols/plan/review', plan.data)));
  const accept = (p, i) => run(`acc${i}`, async () => { const c = await api.post('/consols/plan/accept', p); nav(`/consols/${c.consol.id}`); onAccepted?.(); }, 'Consol created');
  const p = plan.data;
  return (
    <div className="stack">
      <Card title="How the agent plans" actions={<div className="row gap-sm wrap">
        <Button small variant="ghost" busy={busy === 'def'} onClick={saveDefaults}>Save as defaults</Button>
        <Button small onClick={rerun}>Plan again</Button>
      </div>}>
        <p className="small muted">The agent takes every open air and LCL job not yet in a consol, groups them by route and cargo-ready date, keeps cargo that cannot travel together apart (temperature, DG class), then packs them to get the biggest weight gain: bulky cargo with dense cargo, so shippers pay more chargeable kg than the airline charges you. Sea LCL is packed to fill the container. The master is priced from your rate cards, using the weight break for the total.</p>
        <div className="row gap wrap">
          <Field label="Ready dates within (days)"><Input type="number" min="0" style={{ width: 110 }} value={o.window_days} onChange={(e) => setOpts({ ...o, window_days: e.target.value })} /></Field>
          <Field label="Max chargeable kg per air consol" hint="Blank = no limit"><Input type="number" style={{ width: 160 }} value={o.capacity_kg ?? ''} onChange={(e) => setOpts({ ...o, capacity_kg: e.target.value })} /></Field>
          <Field label="LCL container"><Select style={{ width: 110 }} value={o.container} onChange={(e) => setOpts({ ...o, container: e.target.value })} options={['20GP', '40GP', '40HC']} /></Field>
        </div>
      </Card>

      {plan.error ? <ErrorBox error={plan.error} /> : !p ? <Loading /> : (
        <>
          <div className="row gap-sm wrap">
            <span className="muted small">{p.candidates} open air / LCL job{p.candidates === 1 ? '' : 's'} looked at · {p.plans.length} consol{p.plans.length === 1 ? '' : 's'} proposed</span>
            <span className="spacer" />
            {p.plans.length > 0 && <Button small variant="ghost" busy={busy === 'ai'} disabled={!p.ai} title={p.ai ? '' : 'Add an AI key in Settings → AI'} onClick={ask}>Ask the agent to review the cargo (AI)</Button>}
          </div>
          {review?.summary && <div className="alert alert-blue small"><b>Agent review:</b> {review.summary}</div>}
          {!p.plans.length && <Card><div className="empty">Nothing to consolidate right now: no two compatible air or LCL jobs on the same route and dates. {p.unplanned.length ? 'See why below.' : ''}</div></Card>}
          {p.plans.map((pl, i) => {
            const r = review?.consols?.find((x) => x.consol === i + 1);
            return (
              <Card key={pl.houses.join('-')} title={<>Consol {i + 1}: {pl.origin} → {pl.destination} <Badge color="blue">{pl.mode}</Badge> {r && <Badge color={VERDICT[r.verdict]?.[0]}>{VERDICT[r.verdict]?.[1]}</Badge>}</>}
                actions={<Button small busy={busy === `acc${i}`} onClick={() => accept(pl, i)}>Create this consol</Button>}>
                <ConsolStats e={pl.economics} currency={pl.currency} />
                <ul className="small reasons">{pl.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
                <FreeSpace e={pl.economics} />
                {pl.buy ? <div className="small muted">Master priced from rate card “{pl.buy.card_name}” ({pl.buy.vendor}): {pl.mode === 'AIR' ? `${money(pl.buy.rate, pl.buy.currency)}/kg` : money(pl.buy.total, pl.buy.currency)}.</div>
                  : <div className="small muted">No rate card for this route: enter the master buy rate on the consol to see cost and profit.</div>}
                {pl.warnings.map((w) => <div key={w} className="alert alert-amber small">{w}</div>)}
                {r && (r.issues.length > 0 || r.advice) && <div className={`alert ${r.verdict === 'split' ? 'alert-red' : r.verdict === 'check' ? 'alert-amber' : 'alert-green'} small`}>{r.issues.map((x) => <div key={x}>• {x}</div>)}{r.advice && <div><b>Advice:</b> {r.advice}</div>}</div>}
                <Table rows={pl.house_rows} columns={[
                  { label: 'Job', render: (h) => <a href={`/jobs/${h.id}`} onClick={(e) => { e.preventDefault(); nav(`/jobs/${h.id}`); }}>{h.ref}</a> },
                  { label: 'Customer', render: (h) => h.customer || '—' },
                  { label: 'Commodity', render: (h) => <>{h.commodity || '—'}{h.dangerous_goods && <Badge color="red">DG</Badge>}{h.reefer_temp && <Badge color="blue">{h.reefer_temp}</Badge>}</> },
                  { label: 'Ready', render: (h) => fmtDate(h.ready_date) },
                  { label: 'Weights', render: (h) => <HouseWeights w={h} /> },
                ]} />
              </Card>
            );
          })}
          {p.unplanned.length > 0 && (
            <Card title={`Not consolidated (${p.unplanned.length})`}>
              <Table rows={p.unplanned} columns={[
                { label: 'Job', render: (u) => (u.ref ? <a href={`/jobs/${u.id}`} onClick={(e) => { e.preventDefault(); nav(`/jobs/${u.id}`); }}>{u.ref}</a> : u.id) },
                { label: 'Mode', render: (u) => u.mode || '—' },
                { label: 'Lane', render: (u) => <span className="small">{u.lane || '—'}{u.customer ? <div className="muted">{u.customer}</div> : null}</span> },
                { label: 'Why', key: 'reason' },
                { label: 'Ship now or wait?', render: (u) => <ShipOrWait s={u.ship_or_wait} /> },
              ]} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
