import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { PageHeader, Card, Button, Badge, Table, Tabs, Modal, Field, Input, Textarea, Select, Check, Loading, ErrorBox, useLoad, useAction, money, fmtDate, fmtDateTime } from '../components/ui.jsx';
import { useMeta } from '../components/meta.jsx';
import { routeOf, cargoOf } from '../components/rfq.jsx';
import { StatusBadge, BOOKING_STATUS, PartyFields, BookingForm, BookingSummary, ProfitSummary, LegList } from '../components/jobs.jsx';
import ActivityList from '../components/ActivityList.jsx';
import JobDocuments from '../components/JobDocuments.jsx';
import JobTracking from '../components/JobTracking.jsx';


function Overview({ d, set, reload }) {
  const { job, rfq } = d;
  const [form, setForm] = useState(job);
  const [busy, run] = useAction();
  const [notify, setNotify] = useState(null);
  const [mile, setMile] = useState(null);
  useEffect(() => setForm(job), [job]);
  const field = (k) => ({ value: form[k] ?? '', onChange: (e) => setForm({ ...form, [k]: e.target.value }) });
  const confirmed = d.bookings.filter((b) => b.status === 'confirmed').length;
  const milestones = { open: [], booking_requested: [], booked: ['departed'], departed: ['arrived'], arrived: ['completed'] }[job.status] || [];
  return (
    <div className="stack">
      <Card title="Progress" actions={
        <div className="row gap-sm wrap">
          {confirmed > 0 && <Button small variant={job.customer_notified_at ? 'ghost' : 'primary'} onClick={() => setNotify({ to: job.customer_email || '', note: '' })}>{job.customer_notified_at ? 'Resend booking details to customer' : 'Send booking details to customer'}</Button>}
          {milestones.map((m) => <Button key={m} small onClick={() => setMile({ status: m, date: new Date().toISOString().slice(0, 10), notify: true })}>Mark {m}</Button>)}
          {!['completed', 'cancelled'].includes(job.status) && <Button small variant="ghost" onClick={() => setMile({ status: 'cancelled' })}>Cancel job</Button>}
          {['completed', 'cancelled'].includes(job.status) && <Button small variant="ghost" busy={busy === 're'} onClick={() => run('re', async () => set(await api.post(`/jobs/${job.id}/milestone`, { status: 'reopen' })), 'Job reopened')}>Reopen</Button>}
        </div>
      }>
        <dl className="kv">
          <div><dt>Status</dt><dd><StatusBadge status={job.status} /></dd></div>
          <div><dt>Bookings confirmed</dt><dd>{confirmed} of {d.bookings.filter((b) => b.status !== 'cancelled').length}</dd></div>
          <div><dt>Customer told</dt><dd>{job.customer_notified_at ? fmtDateTime(job.customer_notified_at) : 'Not yet'}</dd></div>
          <div><dt>Departed</dt><dd>{job.atd ? fmtDate(job.atd) : '—'}</dd></div>
          <div><dt>Arrived</dt><dd>{job.ata ? fmtDate(job.ata) : '—'}</dd></div>
          <div><dt>Profit</dt><dd className={d.profit.profit < 0 ? 'err' : ''}>{money(d.profit.profit, d.profit.currency)}</dd></div>
        </dl>
      </Card>
      <JobTracking d={d} set={set} />
      <Card title="Shipment" actions={<Link to={`/rfqs/${rfq?.id}`}>Open {job.rfq_ref}</Link>}>
        <dl className="kv">
          <div><dt>Customer</dt><dd>{job.customer || '—'}</dd></div>
          <div><dt>Quotation</dt><dd>{job.quote_ref || '—'}</dd></div>
          <div><dt>Mode</dt><dd>{rfq?.mode}</dd></div>
          <div><dt>Route</dt><dd>{rfq ? routeOf(rfq) : '—'}</dd></div>
          <div><dt>Cargo</dt><dd>{rfq ? cargoOf(rfq) || '—' : '—'}</dd></div>
          <div><dt>Commodity</dt><dd>{rfq?.commodity || '—'}</dd></div>
        </dl>
      </Card>
      <Card title="Parties and dates" actions={<Button small busy={busy === 'save'} onClick={() => run('save', async () => set(await api.put(`/jobs/${job.id}`, form)), 'Saved')}>Save</Button>}>
        <div className="grid g4">
          <Field label="Cargo ready date"><Input type="date" {...field('cargo_ready_date')} /></Field>
          <Field label="Customer reference"><Input {...field('customer_ref')} /></Field>
          <Field label="Notes" span={2}><Input {...field('notes')} /></Field>
        </div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 14 }}>
          <PartyFields label="Shipper" value={form.shipper} onChange={(v) => setForm({ ...form, shipper: v })} />
          <PartyFields label="Consignee" value={form.consignee} onChange={(v) => setForm({ ...form, consignee: v })} />
          <PartyFields label="Notify party" value={form.notify_party} onChange={(v) => setForm({ ...form, notify_party: v })} />
        </div>
        <p className="small muted">These details go into the booking requests to agents. Save before sending.</p>
      </Card>
      {notify && (
        <Modal title="Booking details to customer" onClose={() => setNotify(null)} footer={<Button busy={busy === 'n'} onClick={() => run('n', async () => { set(await api.post(`/jobs/${job.id}/notify-customer`, notify)); setNotify(null); }, 'Sent to customer')}>Send</Button>}>
          <Field label="To" hint="Sent in the customer's enquiry thread when there is one"><Input value={notify.to} onChange={(e) => setNotify({ ...notify, to: e.target.value })} /></Field>
          <Field label="Note (optional)"><Textarea rows={3} value={notify.note} onChange={(e) => setNotify({ ...notify, note: e.target.value })} /></Field>
          <p className="small muted">Includes each confirmed booking: booking number, vessel or flight, ETD/ETA and cut-offs. Costs are not included.</p>
        </Modal>
      )}
      {mile && (
        <Modal title={mile.status === 'cancelled' ? 'Cancel this job?' : `Mark job ${mile.status}`} onClose={() => setMile(null)} footer={<Button busy={busy === 'm'} onClick={() => run('m', async () => { set(await api.post(`/jobs/${job.id}/milestone`, mile)); setMile(null); }, 'Updated')}>{mile.status === 'cancelled' ? 'Cancel job' : 'Save'}</Button>}>
          {mile.status !== 'cancelled' && <Field label="Date"><Input type="date" value={mile.date} onChange={(e) => setMile({ ...mile, date: e.target.value })} /></Field>}
          {mile.status !== 'cancelled' && <Check label="Email this update to the customer (with tracking link)" checked={mile.notify} onChange={(v) => setMile({ ...mile, notify: v })} />}
          {mile.status === 'cancelled' && <p>Agents are not told automatically. Email them if a booking needs cancelling.</p>}
        </Modal>
      )}
    </div>
  );
}

function Bookings({ d, set }) {
  const { job, rfq } = d;
  const [busy, run] = useAction();
  const [send, setSend] = useState(null);
  const [edit, setEdit] = useState(null);
  const pending = d.bookings.filter((b) => b.status === 'draft' && b.source !== 'own');
  const replies = (b) => d.emails.filter((e) => e.booking_id === b.id && e.direction === 'in');
  return (
    <div className="stack">
      {pending.length > 1 && (
        <div className="alert alert-blue row between">
          <span>{pending.length} agents have not been sent a booking request yet.</span>
          <Button small onClick={() => setSend({ all: true, fileIds: [], note: '' })}>Send all booking requests</Button>
        </div>
      )}
      {d.bookings.map((b) => (
        <div key={b.id} className="booking">
          <div className="booking-head">
            <div>
              <b>{b.source === 'own' ? 'Own rates' : b.agent}</b> <StatusBadge status={b.status} map={BOOKING_STATUS} />
              {b.source?.startsWith('ai') && !b.verified && <> <Badge color="amber">read by AI — please check</Badge></>}
              {b.confidence !== null && b.source?.startsWith('ai') && <span className="small muted"> confidence {Math.round(b.confidence * 100)}%</span>}
              <div className="small muted"><LegList legs={b.legs} />{b.requested_at ? ` · requested ${fmtDateTime(b.requested_at)}` : ''}</div>
              {b.last_error && <div className="small err">{b.last_error}</div>}
            </div>
            <div className="row gap-sm wrap">
              {b.source !== 'own' && b.status !== 'cancelled' && <Button small variant={b.status === 'draft' ? 'primary' : 'ghost'} onClick={() => setSend({ booking: b, to: b.agent_email || '', fileIds: [], note: '' })}>{b.status === 'draft' ? 'Send booking request' : 'Send again'}</Button>}
              <Button small variant="ghost" onClick={() => setEdit({ booking: b, value: { ...b } })}>{b.source === 'own' ? 'Enter booking' : 'Edit details'}</Button>
              {b.source?.startsWith('ai') && !b.verified && <Button small variant="ghost" busy={busy === `v${b.id}`} onClick={() => run(`v${b.id}`, async () => set(await api.put(`/bookings/${b.id}`, { verified: true })), 'Marked as checked')}>Looks right</Button>}
            </div>
          </div>
          <BookingSummary b={b} />
          {replies(b).map((e) => (
            <details key={e.id} className="small" style={{ marginTop: 8 }}>
              <summary>Agent reply {fmtDateTime(e.at)} — {e.subject} {e.parse_status === 'review' && <Badge color="amber">check</Badge>}{e.parse_status === 'error' && <Badge color="red">AI error</Badge>}</summary>
              {e.parse_error && <div className="muted">{e.parse_error}</div>}
              <pre className="email-body">{e.body_text}</pre>
              {(e.attachments || []).map((a) => <a key={a.id} href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">{a.filename} </a>)}
              <div><Button small variant="ghost" busy={busy === `r${e.id}`} onClick={() => run(`r${e.id}`, async () => set(await api.post(`/emails/${e.id}/read-booking`)), 'Read again')}>Read again with AI</Button></div>
            </details>
          ))}
        </div>
      ))}
      {!d.bookings.length && <Card><div className="empty">No bookings: the accepted option had no agent legs.</div></Card>}

      {send && (
        <Modal title={send.all ? 'Send booking requests' : `Booking request to ${send.booking.agent}`} onClose={() => setSend(null)} footer={
          <Button busy={busy === 'send'} onClick={() => run('send', async () => {
            if (send.all) {
              const r = await api.post(`/jobs/${job.id}/send-bookings`, send);
              set(r.job);
              const f = r.results.filter((x) => !x.ok);
              if (f.length) throw new Error(`${f.length} failed: ${f[0].error}`);
            } else set(await api.post(`/bookings/${send.booking.id}/send`, send));
            setSend(null);
          }, 'Booking request sent')}>Send</Button>
        }>
          {!send.all && <Field label="To"><Input value={send.to} onChange={(e) => setSend({ ...send, to: e.target.value })} /></Field>}
          {!job.shipper?.name && <div className="alert alert-amber">Shipper is empty. Fill in Parties on the Overview tab first if the agent needs it.</div>}
          <Field label="Attach documents">
            {d.files.length ? d.files.map((f) => (
              <Check key={f.id} label={`${f.filename} (${d.docs.doc_types.find((t) => t.code === f.kind)?.name || 'Other'})`} checked={send.fileIds.includes(f.id)} onChange={(v) => setSend({ ...send, fileIds: v ? [...send.fileIds, f.id] : send.fileIds.filter((x) => x !== f.id) })} />
            )) : <span className="small muted">No documents yet. Upload them on the Documents tab.</span>}
          </Field>
          <Field label="Note to agent (optional)"><Textarea rows={3} value={send.note} onChange={(e) => setSend({ ...send, note: e.target.value })} /></Field>
          <p className="small muted">Sent in the agent's quotation thread with the job reference in the subject. Their reply is read by AI and filled in here.</p>
        </Modal>
      )}
      {edit && (
        <Modal wide title={`Booking — ${edit.booking.source === 'own' ? 'own rates' : edit.booking.agent}`} onClose={() => setEdit(null)} footer={
          <div className="row gap-sm">
            {edit.booking.status !== 'cancelled' && <Button variant="ghost" busy={busy === 'bc'} onClick={() => run('bc', async () => { set(await api.put(`/bookings/${edit.booking.id}`, { status: 'cancelled' })); setEdit(null); }, 'Booking cancelled')}>Cancel booking</Button>}
            <Button variant="ghost" busy={busy === 'bs'} onClick={() => run('bs', async () => { set(await api.put(`/bookings/${edit.booking.id}`, { ...edit.value, verified: true })); setEdit(null); }, 'Saved')}>Save</Button>
            <Button busy={busy === 'bcf'} onClick={() => run('bcf', async () => { set(await api.put(`/bookings/${edit.booking.id}`, { ...edit.value, status: 'confirmed', verified: true })); setEdit(null); }, 'Booking confirmed')}>Save as confirmed</Button>
          </div>
        }>
          <BookingForm value={edit.value} onChange={(v) => setEdit({ ...edit, value: v })} mode={rfq?.mode} />
        </Modal>
      )}
    </div>
  );
}

function Costs({ d, set }) {
  const meta = useMeta();
  const { job } = d;
  const [busy, run] = useAction();
  const blank = { kind: 'buy', description: '', amount: '', currency: job.sell_currency || 'INR', leg: '' };
  const [add, setAdd] = useState(null);
  const agents = [...new Map(d.bookings.filter((b) => b.agent_id).map((b) => [b.agent_id, b.agent])).entries()];
  return (
    <div className="stack">
      <Card title={`Profit in ${d.profit.currency}`}><ProfitSummary profit={d.profit} /></Card>
      {d.profit_quote_currency && d.profit_quote_currency.currency !== d.profit.currency && <Card title={`Profit in quotation currency (${d.profit_quote_currency.currency})`}><ProfitSummary profit={d.profit_quote_currency} /></Card>}
      <Card title="Costs and charges" actions={<Button small onClick={() => setAdd(blank)}>+ Add extra charge or cost</Button>}>
        <Table
          rows={d.costs}
          columns={[
            { label: '', render: (c) => <Badge color={c.kind === 'sell' ? 'green' : 'blue'}>{c.kind === 'sell' ? 'Sell' : 'Buy'}</Badge> },
            { label: 'Leg', render: (c) => (c.leg ? meta.legName(c.leg) : '—') },
            { key: 'description', label: 'Description' },
            { label: 'Agent', render: (c) => c.agent || '' },
            { label: 'Amount', render: (c) => money(c.amount, c.currency), align: 'right' },
            { label: 'Source', render: (c) => <span className="small muted">{c.source === 'quote' ? 'from quotation' : 'added'}</span> },
            { label: '', render: (c) => <Button small variant="ghost" busy={busy === `d${c.id}`} onClick={() => confirm('Delete this line?') && run(`d${c.id}`, async () => set(await api.del(`/job-costs/${c.id}`)))}>Delete</Button> },
          ]}
        />
        <p className="small muted">Buy lines start from the agents' quotes; sell lines from the accepted quotation. Add detention, extra handling, re-billed charges and so on as they come.</p>
      </Card>
      {add && (
        <Modal title="Add charge or cost" onClose={() => setAdd(null)} footer={<Button busy={busy === 'add'} onClick={() => run('add', async () => { set(await api.post(`/jobs/${job.id}/costs`, add)); setAdd(null); }, 'Added')}>Add</Button>}>
          <div className="grid g2">
            <Field label="Type"><Select value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value })} options={[{ value: 'buy', label: 'Buy (cost to us)' }, { value: 'sell', label: 'Sell (billed to customer)' }]} /></Field>
            <Field label="Leg"><Select value={add.leg} placeholder="—" onChange={(e) => setAdd({ ...add, leg: e.target.value })} options={meta.legOptions} /></Field>
            <Field label="Description" span={2}><Input value={add.description} onChange={(e) => setAdd({ ...add, description: e.target.value })} /></Field>
            <Field label="Amount"><Input type="number" value={add.amount} onChange={(e) => setAdd({ ...add, amount: e.target.value })} /></Field>
            <Field label="Currency"><Select value={add.currency} onChange={(e) => setAdd({ ...add, currency: e.target.value })} options={meta.currencies} /></Field>
            {add.kind === 'buy' && agents.length > 0 && <Field label="Agent" span={2}><Select value={add.agent_id || ''} placeholder="—" onChange={(e) => setAdd({ ...add, agent_id: e.target.value })} options={agents.map(([value, label]) => ({ value, label }))} /></Field>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Emails({ d, set }) {
  const [busy, run] = useAction();
  return (
    <Card title="Emails for this job">
      <Table
        rows={d.emails}
        empty="No emails yet."
        columns={[
          { label: 'When', render: (e) => <span className="small">{fmtDateTime(e.at)}</span> },
          { label: '', render: (e) => <Badge color={e.direction === 'in' ? 'blue' : 'gray'}>{e.direction === 'in' ? 'in' : 'out'}</Badge> },
          { label: 'Email', render: (e) => (
            <details>
              <summary>{e.subject} {e.parse_status === 'review' && <Badge color="amber">check</Badge>}{e.parse_status === 'error' && <Badge color="red">AI error</Badge>}</summary>
              <div className="small muted">{e.direction === 'in' ? `From ${e.from_addr}` : `To ${e.to_addr}`}</div>
              {e.parse_error && <div className="small muted">{e.parse_error}</div>}
              <pre className="email-body">{e.body_text}</pre>
              {(e.attachments || []).map((a) => <a key={a.id} href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">{a.filename} </a>)}
              {e.direction === 'in' && <div><Button small variant="ghost" busy={busy === `r${e.id}`} onClick={() => run(`r${e.id}`, async () => set(await api.post(e.booking_id ? `/emails/${e.id}/read-booking` : `/emails/${e.id}/read-customer`)), 'Read again')}>Read again with AI</Button></div>}
            </details>
          ) },
        ]}
      />
    </Card>
  );
}

export default function JobDetail() {
  const { id } = useParams();
  const d = useLoad(() => api.get(`/jobs/${id}`), [id]);
  const history = useLoad(() => api.get(`/audit?job=${id}&days=3650`), [id, d.data]);
  const [tab, setTab] = useState('overview');
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') d.reload(); }, 30000);
    return () => clearInterval(t);
  }, [d.reload]);
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  const { job, rfq } = d.data;
  const set = (data) => d.setData(data);
  const toCheck = d.data.bookings.filter((b) => b.source?.startsWith('ai') && !b.verified).length;
  return (
    <>
      <PageHeader title={<>{job.ref} <StatusBadge status={job.status} /></>} sub={<>{job.customer || '—'} · {rfq?.mode} · {rfq ? routeOf(rfq) : ''}{job.customer_ref ? ` · ref ${job.customer_ref}` : ''}</>} />
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'bookings', label: 'Bookings', count: toCheck || null },
          { key: 'costs', label: 'Costs & profit' },
          { key: 'docs', label: 'Documents', count: d.data.docs.checklist.filter((r) => r.status === 'missing').length + d.data.docs.bls.filter((b) => ['received', 'customer_corrections', 'customer_approved'].includes(b.status)).length || null },
          { key: 'emails', label: 'Emails', count: d.data.emails.length || null },
          { key: 'history', label: 'History' },
        ]}
      />
      {tab === 'overview' && <Overview d={d.data} set={set} />}
      {tab === 'bookings' && <Bookings d={d.data} set={set} />}
      {tab === 'costs' && <Costs d={d.data} set={set} />}
      {tab === 'docs' && <JobDocuments d={d.data} set={set} />}
      {tab === 'emails' && <Emails d={d.data} set={set} />}
      {tab === 'history' && <Card title="History">{history.loading && !history.data ? <Loading /> : <ActivityList rows={history.data || []} showRfq={false} />}</Card>}
    </>
  );
}
