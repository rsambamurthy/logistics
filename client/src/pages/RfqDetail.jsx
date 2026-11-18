import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useMeta } from '../components/meta.jsx';
import { PageHeader, Card, Button, Badge, Table, Tabs, Modal, Field, Input, Textarea, Select, Check, Loading, ErrorBox, useLoad, useAction, money, fmtDate, fmtDateTime } from '../components/ui.jsx';
import { ShipmentForm, AgentPicker, QuoteEditor, routeOf, cargoOf } from '../components/rfq.jsx';

export default function RfqDetail() {
  const { id } = useParams();
  const d = useLoad(() => api.get(`/rfqs/${id}`), [id]);
  const [tab, setTab] = useState('agents');
  const [selection, setSelection] = useState({});
  // refresh while waiting for replies / AI
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') d.reload(); }, 30000);
    return () => clearInterval(t);
  }, [d.reload]);
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  const { rfq, invites, quotes, emails, customerQuotes } = d.data;
  const current = quotes.filter((q) => !q.superseded);
  const toReview = current.filter((q) => !q.verified && !q.declined).length;
  return (
    <>
      <PageHeader
        title={<>{rfq.ref} <Badge>{rfq.status}</Badge></>}
        sub={`${rfq.customer_name || 'No customer'} · ${rfq.mode} · ${routeOf(rfq)} · ${cargoOf(rfq) || ''}`}
      />
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'agents', label: 'Agents & emails', count: invites.length },
          { key: 'review', label: 'Agent quotes', count: toReview || null },
          { key: 'compare', label: 'Compare' },
          { key: 'customer', label: 'Customer quote', count: customerQuotes.length || null },
          { key: 'shipment', label: 'Shipment details' },
        ]}
      />
      {tab === 'agents' && <AgentsTab data={d.data} reload={d.reload} />}
      {tab === 'review' && <ReviewTab data={d.data} reload={d.reload} />}
      {tab === 'compare' && <CompareTab rfq={rfq} selection={selection} setSelection={setSelection} goQuote={() => setTab('customer')} />}
      {tab === 'customer' && <CustomerTab data={d.data} selection={selection} reload={d.reload} goCompare={() => setTab('compare')} />}
      {tab === 'shipment' && <ShipmentTab data={d.data} reload={d.reload} />}
    </>
  );
}

// ---------------- Agents & emails ----------------
function AgentsTab({ data, reload }) {
  const meta = useMeta();
  const { rfq, invites, emails } = data;
  const [busy, run] = useAction();
  const [open, setOpen] = useState(null);
  const [manual, setManual] = useState(null);
  const [counter, setCounter] = useState(null);
  const [adding, setAdding] = useState(false);
  const act = (key, fn, msg) => run(key, async () => { await fn(); await reload(); }, msg);
  const pending = invites.filter((i) => ['pending', 'failed'].includes(i.status)).length;
  return (
    <>
      <Card
        title="Partner agents"
        actions={<>
          <Button variant="ghost" small onClick={() => setAdding(true)}>+ Add agents</Button>
          {pending > 0 && <Button small busy={busy === 'sendall'} onClick={() => act('sendall', async () => { const r = await api.post(`/rfqs/${rfq.id}/send`); const f = r.filter((x) => !x.ok); if (f.length) throw new Error(`${f.length} failed: ${f[0].error}`); }, 'RFQ emails sent')}>Email {pending} agent(s)</Button>}
        </>}
      >
        <Table
          rows={invites}
          empty="No agents added yet."
          columns={[
            { label: 'Agent', render: (i) => <div><b>{i.agent_company}</b><div className="muted small">{i.agent_email} · ref {rfq.ref}/{i.tag}</div></div> },
            { label: 'Legs', render: (i) => <span className="small">{i.legs.map(meta.legName).join(', ')}</span> },
            { label: 'Status', render: (i) => <><Badge>{i.status}</Badge>{i.last_error && <div className="err small">{i.last_error}</div>}</> },
            { label: 'Sent', render: (i) => fmtDateTime(i.sent_at) },
            { label: 'Replied', render: (i) => fmtDateTime(i.replied_at) },
            { label: 'Reminders', render: (i) => i.reminder_count || '', align: 'center' },
            {
              label: '', render: (i) => (
                <div className="row gap-sm wrap">
                  <Button variant="ghost" small onClick={() => setOpen(i)}>Emails ({emails.filter((e) => e.invite_id === i.id).length})</Button>
                  {['pending', 'failed'].includes(i.status) && <Button small busy={busy === `s${i.id}`} onClick={() => act(`s${i.id}`, () => api.post(`/invites/${i.id}/send`), 'Sent')}>Send</Button>}
                  {['sent', 'reminded'].includes(i.status) && <Button variant="ghost" small busy={busy === `r${i.id}`} onClick={() => act(`r${i.id}`, () => api.post(`/invites/${i.id}/remind`), 'Reminder sent')}>Remind</Button>}
                  {i.status === 'replied' && <Button variant="ghost" small onClick={() => setCounter(i)}>Counter-offer</Button>}
                  <Button variant="ghost" small onClick={() => setManual(i)}>Log reply</Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      {open && <ThreadModal invite={open} emails={emails.filter((e) => e.invite_id === open.id)} onClose={() => setOpen(null)} />}
      {manual && <ManualReplyModal invite={manual} onClose={() => setManual(null)} onDone={() => { setManual(null); reload(); }} />}
      {counter && <CounterModal invite={counter} onClose={() => setCounter(null)} onDone={() => { setCounter(null); reload(); }} />}
      {adding && <AddAgentsModal data={data} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </>
  );
}

function ThreadModal({ invite, emails, onClose }) {
  return (
    <Modal title={`Emails with ${invite.agent_company}`} onClose={onClose} wide>
      {!emails.length && <div className="empty">No emails yet.</div>}
      <div className="stack">
        {emails.map((e) => <EmailView key={e.id} email={e} />)}
      </div>
    </Modal>
  );
}

export function EmailView({ email }) {
  return (
    <div className={`email ${email.direction}`}>
      <div className="email-h">
        <b>{email.direction === 'out' ? `→ ${email.to_addr}` : `← ${email.from_addr}`}</b>
        <span className="muted small">{fmtDateTime(email.at)} {email.kind && `· ${email.kind.replace('_', ' ')}`}</span>
        {email.parse_status && <Badge>{email.parse_status}</Badge>}
      </div>
      <div className="small"><b>{email.subject}</b></div>
      {email.parse_error && <div className="small muted">AI: {email.parse_error}</div>}
      <pre className="email-body">{email.body_text}</pre>
      {email.attachments?.length > 0 && (
        <div className="row gap-sm wrap">{email.attachments.map((a) => <a key={a.id} className="att" href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">📎 {a.filename}</a>)}</div>
      )}
    </div>
  );
}

function ManualReplyModal({ invite, onClose, onDone }) {
  const [f, setF] = useState({ text: '', from: invite.agent_email, files: [] });
  const [busy, run] = useAction();
  const submit = () => run('x', async () => {
    const fd = new FormData();
    fd.append('text', f.text);
    fd.append('from', f.from);
    fd.append('subject', `Reply logged manually for ${invite.agent_company}`);
    for (const file of f.files) fd.append('files', file);
    await api.form(`/invites/${invite.id}/manual-reply`, fd);
    onDone();
  }, 'Reply saved. AI is reading it…');
  return (
    <Modal title={`Log a reply from ${invite.agent_company}`} onClose={onClose} footer={<Button busy={busy} onClick={submit}>Save & read with AI</Button>}>
      <p className="muted small">Use this if the agent replied somewhere else (personal inbox, WhatsApp). Paste the text and/or attach their rate sheet.</p>
      <Field label="Reply text"><Textarea rows={8} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></Field>
      <Field label="Attachments"><input type="file" multiple onChange={(e) => setF({ ...f, files: [...e.target.files] })} /></Field>
    </Modal>
  );
}

function CounterModal({ invite, onClose, onDone }) {
  const [msg, setMsg] = useState('Your rates are higher than other offers we have received. Could you please revise and share your best rate?');
  const [busy, run] = useAction();
  return (
    <Modal title={`Counter-offer to ${invite.agent_company}`} onClose={onClose} footer={<Button busy={busy} onClick={() => run('x', async () => { await api.post(`/invites/${invite.id}/counter`, { message: msg }); onDone(); }, 'Counter-offer sent')}>Send email</Button>}>
      <Field label="Message (sent in the same email thread)"><Textarea rows={6} value={msg} onChange={(e) => setMsg(e.target.value)} /></Field>
    </Modal>
  );
}

function AddAgentsModal({ data, onClose, onDone }) {
  const { rfq, invites } = data;
  const [list, setList] = useState(invites.map((i) => ({ agent_id: i.agent_id, legs: i.legs })));
  const [busy, run] = useAction();
  const locked = invites.filter((i) => i.status !== 'pending').map((i) => i.agent_id);
  return (
    <Modal wide title="Add partner agents" onClose={onClose} footer={<Button busy={busy} onClick={() => run('x', async () => { await api.put(`/rfqs/${rfq.id}`, { invites: list }); onDone(); }, 'Agents updated')}>Save</Button>}>
      <AgentPicker rfq={rfq} invites={list} onChange={setList} locked={locked} />
    </Modal>
  );
}

// ---------------- Review agent quotes ----------------
function ReviewTab({ data, reload }) {
  const { rfq, invites, quotes, emails } = data;
  const [edit, setEdit] = useState(null);
  const [busy, run] = useAction();
  const current = quotes.filter((q) => !q.superseded);
  const inbound = emails.filter((e) => e.direction === 'in');
  const problem = inbound.filter((e) => ['error', 'no_quote', 'pending', 'parsing'].includes(e.parse_status));
  const inviteOf = (iid) => invites.find((i) => i.id === iid);
  const emailOf = (eid) => emails.find((e) => e.id === eid);
  const reparse = (eid) => run(`p${eid}`, async () => { await api.post(`/emails/${eid}/parse`); await reload(); }, 'Re-read with AI');
  return (
    <>
      {problem.length > 0 && (
        <Card title="Replies not yet turned into quotes">
          <Table rows={problem} columns={[
            { label: 'From', render: (e) => inviteOf(e.invite_id)?.agent_company || e.from_addr },
            { label: 'Subject', key: 'subject' },
            { label: 'Received', render: (e) => fmtDateTime(e.at) },
            { label: 'Status', render: (e) => <><Badge>{e.parse_status}</Badge>{e.parse_error && <div className="small muted">{e.parse_error}</div>}</> },
            { label: '', render: (e) => <Button small variant="ghost" busy={busy === `p${e.id}`} onClick={() => reparse(e.id)}>Read with AI</Button> },
          ]} />
        </Card>
      )}
      <Card title="Agent quotes" actions={<Button small variant="ghost" onClick={() => setEdit({ invite_id: invites[0]?.id, lines: [], manual: true })} disabled={!invites.length}>+ Enter quote manually</Button>}>
        {!current.length && <div className="empty">No quotes yet. Replies are read automatically when they arrive.</div>}
        <div className="stack">
          {current.map((q) => {
            const inv = inviteOf(q.invite_id);
            const em = emailOf(q.email_id);
            return (
              <div key={q.id} className={`quote-card${q.verified ? '' : ' needs-review'}`}>
                <div className="row between">
                  <div>
                    <b>{inv?.agent_company}</b>{' '}
                    {q.declined ? <Badge color="red">declined</Badge> : q.verified ? <Badge color="green">checked</Badge> : <Badge color="amber">needs review</Badge>}{' '}
                    <span className="muted small">{q.source === 'ai' ? `read by AI · confidence ${Math.round((q.confidence || 0) * 100)}%` : 'entered manually'}</span>
                  </div>
                  <div className="row gap-sm">
                    {em && <Button small variant="ghost" busy={busy === `p${em.id}`} onClick={() => reparse(em.id)}>Re-read</Button>}
                    {!q.declined && <Button small variant={q.verified ? 'ghost' : 'primary'} onClick={() => setEdit({ ...q, email: em })}>{q.verified ? 'Edit' : 'Review'}</Button>}
                  </div>
                </div>
                {q.remarks && <div className="small muted">{q.remarks}</div>}
                {!q.declined && <QuoteLinesTable quote={q} rfq={rfq} />}
              </div>
            );
          })}
        </div>
      </Card>
      {edit && <EditQuoteModal quote={edit} data={data} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function QuoteLinesTable({ quote }) {
  const meta = useMeta();
  return (
    <>
      <div className="small muted">
        {[quote.carrier, quote.routing, quote.transit_days && `transit ${quote.transit_days}d`, quote.free_days && `${quote.free_days} free days`, quote.valid_until && `valid till ${fmtDate(quote.valid_until)}`].filter(Boolean).join(' · ')}
        {quote.exclusions && <span className="err"> · excludes: {quote.exclusions}</span>}
      </div>
      <table className="table compact">
        <thead><tr><th>Leg</th><th>Charge</th><th>Basis</th><th style={{ textAlign: 'right' }}>Rate</th></tr></thead>
        <tbody>
          {quote.lines.map((l) => (
            <tr key={l.id} className={!quote.verified && l.confidence < 0.75 ? 'low-conf' : ''}>
              <td>{meta.legName(l.leg)}</td>
              <td>{l.description || meta.chargeName(l.charge_code)} <span className="muted small">{l.charge_code}</span></td>
              <td>{meta.basisName(l.basis)}{l.qty !== null && l.qty !== undefined ? ` × ${l.qty}` : ''}</td>
              <td style={{ textAlign: 'right' }}>{money(l.rate, l.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function EditQuoteModal({ quote, data, onClose, onDone }) {
  const [q, setQ] = useState({ ...quote, valid_until: quote.valid_until ? String(quote.valid_until).slice(0, 10) : '' });
  const [busy, run] = useAction();
  const inv = data.invites.find((i) => i.id === q.invite_id);
  const save = () => run('x', async () => {
    if (quote.manual) await api.post('/agent-quotes', q);
    else await api.put(`/agent-quotes/${quote.id}`, { ...q, verified: true });
    onDone();
  }, 'Quote saved');
  return (
    <Modal wide title={quote.manual ? 'Enter agent quote' : `Review quote from ${inv?.agent_company}`} onClose={onClose} footer={<Button busy={busy} onClick={save}>{quote.manual ? 'Save quote' : 'Save & mark checked'}</Button>}>
      <div className={quote.email ? 'split' : ''}>
        {quote.email && <div className="split-l"><div className="field-l">Agent's email</div><EmailView email={quote.email} /></div>}
        <div className="split-r">
          {quote.manual && (
            <Field label="Agent">
              <Select options={data.invites.map((i) => ({ value: i.id, label: i.agent_company }))} value={q.invite_id} onChange={(e) => setQ({ ...q, invite_id: Number(e.target.value) })} />
            </Field>
          )}
          <QuoteEditor value={q} onChange={setQ} legs={data.rfq.legs} />
        </div>
      </div>
    </Modal>
  );
}

// ---------------- Compare ----------------
function CompareTab({ rfq, selection, setSelection, goQuote }) {
  const meta = useMeta();
  const [currency, setCurrency] = useState('');
  const c = useLoad(() => api.get(`/rfqs/${rfq.id}/compare${currency ? `?currency=${currency}` : ''}`), [rfq.id, currency]);
  useEffect(() => {
    if (c.data && !Object.keys(selection).length) setSelection(Object.fromEntries(Object.entries(c.data.bestPerLeg).map(([l, b]) => [l, b.quoteId])));
  }, [c.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (c.loading && !c.data) return <Loading />;
  if (c.error) return <ErrorBox error={c.error} />;
  const cmp = c.data;
  const cols = cmp.columns;
  const selTotal = Object.entries(selection).reduce((s, [leg, qid]) => s + (cols.find((x) => x.quote?.id === qid)?.legs[leg]?.total || 0), 0);
  const useSingle = () => cmp.bestSingle && setSelection(Object.fromEntries(cmp.legs.map((l) => [l, cmp.bestSingle.quoteId])));
  const useBest = () => setSelection(Object.fromEntries(Object.entries(cmp.bestPerLeg).map(([l, b]) => [l, b.quoteId])));
  return (
    <Card
      title={`Comparison in ${cmp.currency}`}
      actions={<>
        <Select options={meta.currencies} value={currency || cmp.currency} onChange={(e) => setCurrency(e.target.value)} />
        <Button small variant="ghost" onClick={useBest}>Best per leg</Button>
        <Button small variant="ghost" onClick={useSingle} disabled={!cmp.bestSingle}>Best single agent</Button>
      </>}
    >
      <div className="table-wrap">
        <table className="table cmp">
          <thead>
            <tr><th>Leg</th>{cols.map((col) => <th key={col.invite.id}>{col.invite.agent_company}<div><Badge>{col.status}</Badge></div></th>)}</tr>
          </thead>
          <tbody>
            {cmp.legs.map((leg) => (
              <tr key={leg}>
                <td><b>{meta.legName(leg)}</b></td>
                {cols.map((col) => {
                  const cell = col.legs[leg];
                  const best = cmp.bestPerLeg[leg]?.quoteId === col.quote?.id;
                  const picked = selection[leg] === col.quote?.id;
                  if (!cell) return <td key={col.invite.id} className="muted">{col.status === 'quoted' && col.invite.legs.includes(leg) ? 'not quoted' : '—'}</td>;
                  return (
                    <td key={col.invite.id} className={`${best ? 'best' : ''} ${picked ? 'picked' : ''}`}>
                      <label className="pick">
                        <input type="radio" name={leg} checked={picked} onChange={() => setSelection({ ...selection, [leg]: col.quote.id })} />
                        <b>{money(cell.total)}</b>
                      </label>
                      <details className="small"><summary>{cell.lines.length} charge(s)</summary>
                        {cell.lines.map((l) => <div key={l.id}>{l.charge_code} {money(l.rate, l.currency)} × {l.qty}</div>)}
                      </details>
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="tot"><td>Total (quoted legs)</td>{cols.map((col) => <td key={col.invite.id}>{col.total !== null ? money(col.total) : ''}</td>)}</tr>
            <tr><td>Transit / free days</td>{cols.map((col) => <td key={col.invite.id} className="small">{col.quote ? `${col.quote.transit_days ?? '—'}d / ${col.quote.free_days ?? '—'}` : ''}</td>)}</tr>
            <tr><td>Valid till</td>{cols.map((col) => <td key={col.invite.id} className="small">{col.quote ? fmtDate(col.quote.valid_until) : ''}</td>)}</tr>
            <tr><td>Flags</td>{cols.map((col) => <td key={col.invite.id} className="small">{col.flags.map((f, i) => <div key={i} className="flag">⚠ {f.text}</div>)}</td>)}</tr>
          </tbody>
        </table>
      </div>
      <div className="row between selbar">
        <div>Selected cost: <b>{money(selTotal, cmp.currency)}</b> · {Object.keys(selection).length}/{cmp.legs.length} legs covered</div>
        <Button onClick={goQuote} disabled={!Object.keys(selection).length}>Build customer quote →</Button>
      </div>
    </Card>
  );
}

// ---------------- Customer quote ----------------
function CustomerTab({ data, selection, reload, goCompare }) {
  const meta = useMeta();
  const { rfq, customerQuotes } = data;
  const settings = useLoad(() => api.get('/settings'));
  const customer = useLoad(() => (rfq.customer_id ? api.get('/customers').then((l) => l.find((c) => c.id === rfq.customer_id)) : null), [rfq.customer_id]);
  const [opts, setOpts] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, run] = useAction();
  const [sendTo, setSendTo] = useState(null);
  useEffect(() => {
    if (!settings.data || opts || customer.loading) return;
    const p = settings.data.pricing;
    const cur = customer.data?.currency || settings.data.fx.base;
    setOpts({ currency: cur, margin_pct: customer.data?.margin_pct ?? p.default_margin_pct, tax_pct: cur === 'INR' ? p.default_tax_pct : 0, terms: p.terms, valid_until: '' });
  }, [settings.data, customer.data, customer.loading, opts]);
  const hasSel = Object.keys(selection).length > 0;
  const body = useMemo(() => (opts ? { ...opts, selection } : null), [opts, selection]);
  useEffect(() => {
    if (!body || !hasSel) return;
    const t = setTimeout(() => api.post(`/rfqs/${rfq.id}/customer-quote/preview`, body).then(setPreview).catch((e) => setPreview({ error: e.message })), 250);
    return () => clearTimeout(t);
  }, [body, hasSel, rfq.id]);
  if (!opts) return <Loading />;
  const floor = settings.data.pricing.floor_margin_pct;
  const below = preview?.totals && preview.totals.margin_pct_effective < floor;
  const save = (approved) => run('save', async () => { await api.post(`/rfqs/${rfq.id}/customer-quotes`, { ...body, approved_below_floor: approved }); await reload(); }, 'Customer quote created');
  return (
    <>
      {!hasSel ? (
        <Card><div className="empty">Pick agent quotes on the Compare tab first. <Button small variant="ghost" onClick={goCompare}>Go to Compare</Button></div></Card>
      ) : (
        <Card title="Build customer quote">
          <div className="grid g5">
            <Field label="Currency"><Select options={meta.currencies} value={opts.currency} onChange={(e) => setOpts({ ...opts, currency: e.target.value })} /></Field>
            <Field label="Margin %"><Input type="number" step="0.5" value={opts.margin_pct} onChange={(e) => setOpts({ ...opts, margin_pct: Number(e.target.value) })} /></Field>
            <Field label="Tax % (GST)" hint="18% India GST, 0 for Hong Kong"><Input type="number" value={opts.tax_pct} onChange={(e) => setOpts({ ...opts, tax_pct: Number(e.target.value) })} /></Field>
            <Field label="Valid until"><Input type="date" value={opts.valid_until} onChange={(e) => setOpts({ ...opts, valid_until: e.target.value })} /></Field>
          </div>
          <Field label="Terms"><Textarea rows={3} value={opts.terms} onChange={(e) => setOpts({ ...opts, terms: e.target.value })} /></Field>
          {preview?.error && <ErrorBox error={preview.error} />}
          {preview?.sections && (
            <div className="stack">
              {preview.sections.map((s) => (
                <div key={s.leg}>
                  <div className="row between"><b>{s.name}</b><span className="muted small">from {s.agent}</span></div>
                  <table className="table compact">
                    <thead><tr><th>Charge</th><th>Basis</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Buy</th><th style={{ textAlign: 'right' }}>Sell rate</th><th style={{ textAlign: 'right' }}>Sell amount</th></tr></thead>
                    <tbody>{s.lines.map((l, i) => (
                      <tr key={i}><td>{l.description}</td><td>{meta.basisName(l.basis)}</td><td style={{ textAlign: 'right' }}>{l.qty}</td><td style={{ textAlign: 'right' }} className="muted">{money(l.buy_rate, l.buy_currency)}</td><td style={{ textAlign: 'right' }}>{money(l.sell_rate)}</td><td style={{ textAlign: 'right' }}>{money(l.sell_amount)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              ))}
              <div className="totals">
                <div>Buy cost <b>{money(preview.totals.buy, preview.currency)}</b></div>
                <div>Sell <b>{money(preview.totals.sell, preview.currency)}</b></div>
                <div>Profit <b className={below ? 'err' : 'ok'}>{money(preview.totals.profit, preview.currency)} ({preview.totals.margin_pct_effective}%)</b></div>
                <div>Tax <b>{money(preview.totals.tax, preview.currency)}</b></div>
                <div className="grand">Grand total <b>{money(preview.totals.grand_total, preview.currency)}</b></div>
              </div>
              {below && <div className="alert alert-amber">Margin is below the {floor}% floor. Saving needs your approval.</div>}
              <div className="row end"><Button busy={busy === 'save'} onClick={() => save(below)}>{below ? 'Approve & create quote' : 'Create customer quote'}</Button></div>
            </div>
          )}
        </Card>
      )}
      <Card title="Customer quotes">
        <Table
          rows={customerQuotes}
          empty="None yet."
          columns={[
            { key: 'ref', label: 'Ref', render: (r) => <b>{r.ref}</b> },
            { label: 'Total', render: (r) => money(r.snapshot?.totals?.grand_total, r.currency) },
            { label: 'Profit', render: (r) => `${money(r.snapshot?.totals?.profit, r.currency)} (${r.snapshot?.totals?.margin_pct_effective}%)` },
            { label: 'Valid until', render: (r) => fmtDate(r.valid_until) },
            { label: 'Status', render: (r) => <Badge>{r.status}</Badge> },
            {
              label: '', render: (r) => (
                <div className="row gap-sm">
                  <a className="btn btn-ghost btn-sm" href={`/api/customer-quotes/${r.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
                  <Button small variant="ghost" onClick={() => setSendTo({ quote: r, to: customer.data?.email || '' })}>Email</Button>
                  {r.status !== 'accepted' && <Button small busy={busy === `a${r.id}`} onClick={() => run(`a${r.id}`, async () => {
                    if (!confirm('Mark accepted and email confirmations to the winning agents (and regret emails to the others)?')) return;
                    const res = await api.post(`/customer-quotes/${r.id}/accept`, {});
                    await reload();
                    const f = res.results.filter((x) => !x.ok);
                    if (f.length) throw new Error(`${f.length} email(s) failed: ${f[0].error}`);
                  }, 'Accepted. Agents notified.')}>Accepted → award</Button>}
                </div>
              ),
            },
          ]}
        />
      </Card>
      {sendTo && (
        <Modal title={`Email ${sendTo.quote.ref} to customer`} onClose={() => setSendTo(null)} footer={<Button busy={busy === 'send'} onClick={() => run('send', async () => { await api.post(`/customer-quotes/${sendTo.quote.id}/send`, { to: sendTo.to }); setSendTo(null); await reload(); }, 'Quote emailed')}>Send with PDF</Button>}>
          <Field label="To"><Input value={sendTo.to} onChange={(e) => setSendTo({ ...sendTo, to: e.target.value })} /></Field>
        </Modal>
      )}
    </>
  );
}

// ---------------- Shipment ----------------
function ShipmentTab({ data, reload }) {
  const customers = useLoad(() => api.get('/customers'));
  const mailboxes = useLoad(() => api.get('/mailboxes'));
  const toLocal = (d) => (d ? new Date(d).toISOString().slice(0, 16) : '');
  const [f, setF] = useState({ ...data.rfq, ready_date: data.rfq.ready_date?.slice?.(0, 10) || '', deadline: toLocal(data.rfq.deadline) });
  const [busy, run] = useAction();
  const save = () => run('x', async () => { await api.put(`/rfqs/${data.rfq.id}`, { ...f, deadline: f.deadline ? new Date(f.deadline).toISOString() : null }); await reload(); }, 'Saved');
  return (
    <Card title="Shipment details" actions={<>
      <Select value={data.rfq.status} options={['draft', 'sent', 'quoting', 'quoted', 'awarded', 'closed', 'cancelled']} onChange={(e) => run('st', async () => { await api.post(`/rfqs/${data.rfq.id}/status`, { status: e.target.value }); await reload(); }, 'Status updated')} />
      <Button busy={busy === 'x'} onClick={save}>Save</Button>
    </>}>
      <p className="muted small">Changes apply to future emails; already-sent RFQ emails are not changed.</p>
      <ShipmentForm value={f} onChange={setF} customers={customers.data || []} mailboxes={mailboxes.data || []} />
    </Card>
  );
}
