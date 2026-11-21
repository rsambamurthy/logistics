// Planning agent UI pieces, shared across screens: reply forecast, instant estimate, mode advice,
// best combination, ship-now-or-wait, lane forecast, rate-card renewals, document cross-check,
// customer payment risk and receivables.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Card, Button, Badge, Table, Field, Input, Select, useLoad, useAction, money, fmtDate, fmtDateTime } from './ui.jsx';
import { useMeta } from './meta.jsx';

const qty = (n, unit) => `${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: unit === 'kg' ? 0 : 1 })} ${unit}`;
const pct = (p) => `${Math.round((p || 0) * 100)}%`;
const hrs = (h) => (h === null || h === undefined ? '—' : h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} h`);

// ---------------------------------------------------------------- reply forecast
export function ReplyForecast({ f }) {
  if (!f) return null;
  const tone = f.probability >= 0.6 ? 'green' : f.probability >= 0.3 ? 'amber' : 'red';
  return (
    <div className="small" title={f.learnt ? 'Learnt from this agent\'s past replies' : 'Not enough history for this agent yet: mailbox reminder interval used'}>
      <Badge color={tone}>{`${pct(f.probability)} likely`}</Badge>
      {f.usual_hours !== null && <span className="muted"> · usually {hrs(f.usual_hours)}</span>}
      <div className="muted">{f.due_to_chase ? 'due a reminder now' : `chase ${fmtDateTime(f.chase_at)}`}</div>
    </div>
  );
}

export function ReadyBanner({ ready, onCompare }) {
  if (!ready?.text) return null;
  return (
    <div className={`alert ${ready.ready ? 'alert-green' : 'alert-blue'} small row gap-sm`}>
      <span>{ready.text}</span><span className="spacer" />
      {ready.ready && onCompare && <Button small onClick={onCompare}>Compare quotes →</Button>}
    </div>
  );
}

// ---------------------------------------------------------------- instant estimate + mode advice
export function RfqPlanning({ rfq }) {
  const meta = useMeta();
  const p = useLoad(() => api.get(`/rfqs/${rfq.id}/planning`), [rfq.id, rfq.mode, rfq.volume_cbm, rfq.gross_weight_kg, rfq.deliver_by]);
  if (!p.data) return null;
  const { estimate: e, modes: m } = p.data;
  const otherBetter = m?.best && m.best.mode !== m.current && m.options.length > 1;
  if (!e && !(m?.options?.length > 1)) return null;
  return (
    <Card title="Agent's estimate">
      {e && (
        <div className="stack-sm">
          <div><b>{money(e.low, e.currency)} – {money(e.high, e.currency)}</b> <span className="muted">likely {money(e.mid, e.currency)} · {e.confidence} confidence</span></div>
          <div className="small muted">
            From past agent quotes on this lane ({Object.entries(e.legs).map(([l, v]) => `${meta.legName(l)}: ${v.n}`).join(', ')}){e.unit && ` · freight scaled to ${e.freight_units} ${e.unit}`}
            {e.transit_days ? ` · usual transit ${e.transit_days} days` : ''}.
            {e.missing?.length > 0 && ` No history for ${e.missing.map(meta.legName).join(', ')}.`}
          </div>
        </div>
      )}
      {m?.options?.length > 1 && (
        <div className="stack-sm" style={{ marginTop: e ? 12 : 0 }}>
          <div><b>Mode advice</b>{otherBetter ? <Badge color="amber">consider {m.best.mode}</Badge> : <Badge color="green">{m.current} is the right choice</Badge>}</div>
          <Table
            rows={m.options.map((o) => ({ ...o, id: o.mode }))}
            columns={[
              { label: 'Mode', render: (o) => <b>{o.mode}{o.mode === m.current ? ' (requested)' : ''}</b> },
              { label: `Cost (${m.compared_legs.map(meta.legName).join(' + ')})`, render: (o) => money(o.cost, m.currency) },
              { label: 'Transit', render: (o) => (o.transit_days ? `${o.transit_days} days` : '—') },
              { label: 'Arrives', render: (o) => <>{o.arrive ? fmtDate(o.arrive) : '—'} {o.on_time === false && <Badge color="red">late</Badge>}{o.on_time && <Badge color="green">in time</Badge>}</> },
              { label: 'Priced from', render: (o) => <span className="small muted">{o.source || '—'}{o.containers ? ` · ${o.containers.map((c) => `${c.qty}×${c.type}`).join(', ')}` : ''}</span> },
            ]}
          />
          {m.reasons?.length > 0 && <ul className="reasons small">{m.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- best combination
export function SmartCombo({ smart, currency, onUse }) {
  if (!smart) return null;
  return (
    <div className="alert alert-blue small row gap-sm wrap">
      <span><b>Agent's best combination:</b> {smart.agent_names.join(' + ')} · {money(smart.cost, currency)} like-for-like
        {smart.agents > 1 ? ` (${smart.agents} agents; each extra agent counted as ${money(smart.handoff_cost, currency)} for hand-off)` : ' (one agent for everything)'}
        {smart.max_transit !== null && ` · arrives in time (transit ≤ ${smart.max_transit} days)`}.</span>
      {smart.note && <span className="muted">{smart.note}</span>}
      <span className="spacer" />
      <Button small onClick={() => onUse(smart.selection)}>Use this</Button>
    </div>
  );
}

// ---------------------------------------------------------------- ship now or wait
export function ShipOrWait({ s }) {
  if (!s) return null;
  return <div className="small"><Badge color={s.decision === 'wait' ? 'amber' : 'green'}>{s.decision === 'wait' ? `wait ${s.days}d` : 'ship now'}</Badge> <span className="muted">{s.text} ({s.per_week} similar shipments a week)</span></div>;
}

// ---------------------------------------------------------------- lane forecast (space planning)
const Spark = ({ values }) => {
  const max = Math.max(...values, 1);
  const w = 120;
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${28 - (v / max) * 26}`).join(' ');
  return <svg width={w} height={30} className="spark"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
};

export function LaneForecast() {
  const f = useLoad(() => api.get('/consols/forecast'), []);
  return (
    <Card title="Space planning: volume forecast per lane">
      <p className="small muted">Weekly volume from your jobs over the last 16 weeks, projected 4 weeks ahead. Block the "next week" space with your carrier or airline; the 80% figure covers most weeks.</p>
      <Table
        rows={(f.data || []).map((l) => ({ ...l, id: `${l.mode}${l.pol}${l.pod}` }))}
        empty={f.loading ? 'Loading…' : 'Not enough history yet: a lane needs at least 4 jobs in the last 16 weeks.'}
        columns={[
          { label: 'Lane', render: (l) => <div><b>{l.pol} → {l.pod}</b><div className="small muted">{l.mode} · {l.jobs} jobs</div></div> },
          { label: 'Last 16 weeks', render: (l) => <Spark values={l.history} /> },
          { label: 'Average / week', render: (l) => qty(l.average, l.unit) },
          { label: 'Next week', render: (l) => <b>{qty(l.block, l.unit)}</b> },
          { label: '80% cover', render: (l) => qty(l.weeks[0].p80, l.unit) },
          { label: 'Trend', render: (l) => <span className={l.trend > 0 ? 'ok' : l.trend < 0 ? 'err' : 'muted'}>{l.trend > 0 ? '↑' : l.trend < 0 ? '↓' : '→'} {qty(Math.abs(l.trend), l.unit)} / week</span> },
          { label: 'Weeks 2–4', render: (l) => <span className="small">{l.weeks.slice(1).map((w) => qty(w.p50, l.unit)).join(' · ')}</span> },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- rate-card renewals
export function RateCardRenewals({ canManage }) {
  const [busy, run] = useAction();
  const r = useLoad(() => api.get('/rate-cards/renewals'), []);
  if (!r.data?.length) return null;
  return (
    <Card title={`Rate cards to renew (${r.data.length})`}>
      <Table
        rows={r.data}
        columns={[
          { label: 'Card', render: (c) => <div><b>{c.name}</b><div className="small muted">{c.vendor || 'Your own rates'} · {c.mode} {c.leg?.replace(/_/g, ' ')}</div></div> },
          { label: 'Why', render: (c) => <div className="small">{c.issues.map((i) => <div key={i.type}><Badge color={i.severity === 'high' ? 'red' : 'amber'}>{i.type}</Badge> {i.text}</div>)}</div> },
          { label: '', render: (c) => (canManage && c.can_ask
            ? <Button small variant="ghost" busy={busy === c.id} onClick={() => run(c.id, () => api.post(`/rate-cards/${c.id}/ask-rates`), `Asked ${c.vendor} for new rates`)}>Ask for new rates</Button>
            : <span className="small muted">{c.vendor ? 'vendor has no email' : 'edit the card'}</span>) },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- document cross-check
export function DocCheck({ jobId, canManage }) {
  const [busy, run] = useAction();
  const d = useLoad(() => api.get(`/jobs/${jobId}/doc-check`), [jobId]);
  const res = d.data;
  const check = () => run('chk', async () => { await api.post(`/jobs/${jobId}/doc-check`); await d.reload(); });
  return (
    <Card
      title={<>Document cross-check {res && (res.issues ? <Badge color="red">{`${res.issues} mismatch${res.issues > 1 ? 'es' : ''}`}</Badge> : res.checks.length ? <Badge color="green">all agree</Badge> : null)}</>}
      actions={canManage && <Button small variant="ghost" busy={busy === 'chk'} onClick={check}>{res ? 'Check again' : 'Check documents'}</Button>}
    >
      {!res && <p className="small muted">Compares shipper, consignee, packages, weight, volume, HS code, description, invoice value and container numbers across the invoice, packing list, shipping instructions, BL / AWB and the booking, before customs or the carrier finds the difference.</p>}
      {res && (
        <>
          <div className="small muted">Checked {fmtDateTime(res.checked_at)} across: {res.sources.join(', ')}.{!res.ai && ' AI is not set up, so uploaded invoices and packing lists were not read.'}{res.unread?.length > 0 && ` Not read: ${res.unread.join(', ')}.`}</div>
          {!res.checks.length && <p className="small">Nothing to compare yet: at least two documents must show the same fact.</p>}
          {res.checks.length > 0 && (
            <Table
              rows={res.checks.map((c) => ({ ...c, id: c.field }))}
              rowClass={(c) => (c.ok ? '' : 'row-warn')}
              columns={[
                { label: '', render: (c) => (c.ok ? <span className="ok">✓</span> : <span className="err">✗</span>) },
                { label: 'Field', render: (c) => <b>{c.label}</b> },
                { label: 'What each document says', render: (c) => <div className="small">{c.values.map((v) => <div key={v.key}><span className="muted">{v.source}:</span> {String(v.value).slice(0, 90)}</div>)}</div> },
              ]}
            />
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- customer payment risk
const GRADE = { new: ['grey', 'new customer'], A: ['green', 'A · pays on time'], B: ['amber', 'B · sometimes late'], C: ['red', 'C · often late'], D: ['red', 'D · high risk'] };
export const PaymentBadge = ({ r }) => (r ? <Badge color={GRADE[r.grade]?.[0]}>{GRADE[r.grade]?.[1]}</Badge> : null);

export function PaymentRisk({ customerId, compact }) {
  const r = useLoad(() => (customerId ? api.get(`/agents/${customerId}/payment-risk`) : Promise.resolve(null)), [customerId]);
  const x = r.data;
  if (!x || (compact && ['new', 'A'].includes(x.grade) && !x.overdue)) return null;
  const tone = ['C', 'D'].includes(x.grade) || x.overdue ? 'alert-amber' : 'alert-blue';
  return (
    <div className={`alert ${tone} small`}>
      <div className="row gap-sm wrap"><b>Customer payment record:</b> <PaymentBadge r={x} />
        {x.outstanding > 0 && <span>Outstanding {money(x.outstanding, x.currency)}{x.overdue > 0 && <>, <b>{money(x.overdue, x.currency)} overdue</b></>}.</span>}
      </div>
      <div>{x.advice}{x.suggested_limit > 0 && ` Suggested credit limit about ${money(x.suggested_limit, x.currency)}.`}</div>
      {x.reasons?.length > 0 && <ul className="reasons">{x.reasons.map((t) => <li key={t}>{t}</li>)}</ul>}
    </div>
  );
}

/** The customer invoice on a job (receivables): number, date, amount, due date, paid. */
export function JobInvoice({ job, canManage, onChanged }) {
  const meta = useMeta();
  const [busy, run] = useAction();
  const [f, setF] = useState(null);
  const edit = () => setF({ invoice_no: job.invoice_no || '', invoice_date: job.invoice_date?.slice(0, 10) || new Date().toISOString().slice(0, 10), invoice_amount: job.invoice_amount ?? '', invoice_currency: job.invoice_currency || job.sell_currency || '', due_date: job.due_date?.slice(0, 10) || '', paid_at: job.paid_at?.slice(0, 10) || '' });
  const save = (body) => run('inv', async () => { await api.put(`/jobs/${job.id}`, body); setF(null); await onChanged(); }, 'Saved');
  const overdue = job.due_date && !job.paid_at && new Date(job.due_date) < new Date(new Date().toDateString());
  return (
    <Card
      title={<>Customer invoice {job.invoice_amount !== null && job.invoice_amount !== undefined && (job.paid_at ? <Badge color="green">paid</Badge> : overdue ? <Badge color="red">overdue</Badge> : <Badge>unpaid</Badge>)}</>}
      actions={canManage && !f && <>
        {job.invoice_amount !== null && job.invoice_amount !== undefined && !job.paid_at && <Button small busy={busy === 'inv'} onClick={() => save({ paid_at: new Date().toISOString().slice(0, 10) })}>Mark paid today</Button>}
        <Button small variant="ghost" onClick={edit}>{job.invoice_amount !== null && job.invoice_amount !== undefined ? 'Edit' : 'Record invoice'}</Button>
      </>}
    >
      {!f && (job.invoice_amount === null || job.invoice_amount === undefined
        ? <p className="small muted">No invoice recorded. Recording invoices and payments lets the agent grade how each customer pays.</p>
        : <div className="row gap wrap small">
            <span>No. <b>{job.invoice_no || '—'}</b></span><span>Dated {fmtDate(job.invoice_date)}</span>
            <span>Amount <b>{money(job.invoice_amount, job.invoice_currency || job.sell_currency)}</b></span>
            <span>Due {fmtDate(job.due_date)}</span><span>Paid {fmtDate(job.paid_at)}</span>
          </div>)}
      {f && (
        <>
          <div className="grid cols-3">
            <Field label="Invoice no."><Input value={f.invoice_no} onChange={(e) => setF({ ...f, invoice_no: e.target.value })} /></Field>
            <Field label="Invoice date"><Input type="date" value={f.invoice_date} onChange={(e) => setF({ ...f, invoice_date: e.target.value })} /></Field>
            <Field label="Amount"><div className="row gap-sm"><Select options={meta.currencies} value={f.invoice_currency} onChange={(e) => setF({ ...f, invoice_currency: e.target.value })} /><Input type="number" value={f.invoice_amount} onChange={(e) => setF({ ...f, invoice_amount: e.target.value })} /></div></Field>
            <Field label="Due date" hint="Blank = customer's credit days (or 30)"><Input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
            <Field label="Paid on"><Input type="date" value={f.paid_at} onChange={(e) => setF({ ...f, paid_at: e.target.value })} /></Field>
          </div>
          <div className="row gap-sm"><Button small busy={busy === 'inv'} onClick={() => save(f)}>Save</Button><Button small variant="ghost" onClick={() => setF(null)}>Cancel</Button></div>
        </>
      )}
    </Card>
  );
}

export function Receivables() {
  const r = useLoad(() => api.get('/receivables'), [], { refresh: 120 });
  const rows = r.data?.rows || [];
  if (!rows.length) return null;
  const overdue = rows.filter((x) => x.days_overdue > 0);
  return (
    <Card title={<>Customer invoices unpaid ({rows.length}) {overdue.length > 0 && <Badge color="red">{`${overdue.length} overdue`}</Badge>}</>}>
      <Table
        rows={rows.slice(0, 15)}
        rowClass={(x) => (x.days_overdue > 0 ? 'row-warn' : '')}
        columns={[
          { label: 'Job', render: (x) => <Link to={`/jobs/${x.id}`}><b>{x.ref}</b></Link> },
          { label: 'Customer', render: (x) => x.customer || '—' },
          { label: 'Invoice', render: (x) => <span className="small">{x.invoice_no || '—'} · {fmtDate(x.invoice_date)}</span> },
          { label: 'Amount', render: (x) => money(x.invoice_amount, x.currency), align: 'right' },
          { label: 'Due', render: (x) => <>{fmtDate(x.due_date)} {x.days_overdue > 0 && <Badge color="red">{`${x.days_overdue} days overdue`}</Badge>}</> },
        ]}
      />
    </Card>
  );
}
