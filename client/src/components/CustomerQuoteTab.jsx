// Sell-side quotation for an RFQ: options (incl. linked sea/air alternatives), revisions, approvals, sending, outcome.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useMeta } from './meta.jsx';
import { useSession, useCan } from './session.js';
import { Card, Button, Badge, Table, Modal, Field, Input, Textarea, Select, Loading, ErrorBox, useLoad, useAction, money, fmtDate } from './ui.jsx';
import { EmailPreviewNote } from './rfqBits.jsx';
import MarginAdvice from './MarginAdvice.jsx';

const letter = (i) => String.fromCharCode(65 + i);

/** Choose, per leg, which agent quote an option uses (defaults to cheapest). */
function OptionEditor({ value, onChange, family }) {
  const meta = useMeta();
  const cmp = useLoad(() => api.get(`/rfqs/${value.rfq_id}/compare`), [value.rfq_id]);
  useEffect(() => {
    if (cmp.data && !Object.keys(value.selection || {}).length) onChange({ ...value, selection: Object.fromEntries(Object.entries(cmp.data.bestPerLeg).map(([l, b]) => [l, b.quoteId])) });
  }, [cmp.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <div className="grid g2">
        <Field label="Option name"><Input value={value.label} onChange={(e) => onChange({ ...value, label: e.target.value })} placeholder="e.g. ONE direct, 9 days" /></Field>
        <Field label="From RFQ">
          <Select options={family.map((r) => ({ value: r.id, label: `${r.ref} · ${r.mode}` }))} value={value.rfq_id} onChange={(e) => onChange({ ...value, rfq_id: Number(e.target.value), selection: {} })} />
        </Field>
      </div>
      {cmp.loading ? <Loading /> : cmp.error ? <ErrorBox error={cmp.error} /> : (
        <table className="table compact">
          <thead><tr><th>Leg</th><th>Use quote from</th></tr></thead>
          <tbody>
            {cmp.data.legs.map((leg) => (
              <tr key={leg}>
                <td>{meta.legName(leg)}</td>
                <td>
                  <Select
                    placeholder="— not included —"
                    value={value.selection?.[leg] || ''}
                    options={cmp.data.columns.filter((c) => c.legs[leg]).map((c) => ({ value: c.quote.id, label: `${c.invite.agent_company} · ${money(c.legs[leg].total, cmp.data.currency)}${cmp.data.bestPerLeg[leg]?.quoteId === c.quote.id ? ' (cheapest)' : ''}` }))}
                    onChange={(e) => {
                      const sel = { ...value.selection };
                      if (e.target.value) sel[leg] = Number(e.target.value); else delete sel[leg];
                      onChange({ ...value, selection: sel });
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function CustomerQuoteTab({ data, selection, reload, goCompare }) {
  const meta = useMeta();
  const session = useSession();
  const { rfq, customerQuotes } = data;
  const isAgent = rfq.requester_role === 'agent';
  const can = useCan();
  const settings = useLoad(() => api.get('/settings'));
  const family = useLoad(() => api.get(`/rfqs/${rfq.id}/family`), [rfq.id]);
  const requester = useLoad(() => (rfq.requester_id ? api.get('/agents').then((l) => l.find((c) => c.id === rfq.requester_id)) : null), [rfq.requester_id]);
  const reasons = useLoad(() => api.get('/lost-reasons'));
  const [opts, setOpts] = useState(null);
  const [options, setOptions] = useState(null);
  const [editing, setEditing] = useState(null); // { index, value }
  const [preview, setPreview] = useState(null);
  const [busy, run] = useAction();
  const navTo = useNavigate();
  const jobOf = (r) => (data.jobs || []).find((j) => j.customer_quote_id === r.id);
  const [sendTo, setSendTo] = useState(null);
  const [lost, setLost] = useState(null);
  const [accepting, setAccepting] = useState(null);

  useEffect(() => {
    if (!settings.data || opts || requester.loading) return;
    const p = settings.data.pricing;
    const cur = requester.data?.currency || settings.data.fx.base;
    setOpts({
      currency: cur,
      margin_pct: requester.data?.margin_pct ?? (isAgent ? p.default_agent_margin_pct : p.default_margin_pct),
      tax_pct: requester.data?.tax_pct ?? (cur === 'INR' ? p.default_tax_pct : 0),
      language: requester.data?.quote_language || 'en',
      terms: p.terms,
      valid_until: '',
    });
  }, [settings.data, requester.data, requester.loading, opts, isAgent]);
  useEffect(() => {
    if (options === null && Object.keys(selection).length) setOptions([{ label: '', rfq_id: rfq.id, selection }]);
  }, [selection, options, rfq.id]);

  const body = useMemo(() => (opts && options?.length ? { ...opts, options: options.map((o, i) => ({ ...o, label: o.label || `Option ${letter(i)}` })) } : null), [opts, options]);
  useEffect(() => {
    if (!body) return setPreview(null);
    const t = setTimeout(() => api.post(`/rfqs/${rfq.id}/customer-quote/preview`, body).then(setPreview).catch((e) => setPreview({ error: e.message })), 250);
    return () => clearTimeout(t);
  }, [body, rfq.id]);

  if (!opts || settings.loading) return <Loading />;
  // approval level this margin falls into, and whether my roles can approve it (decided by the server)
  const approval = preview?.approval || null;
  const below = !!approval;
  const canApprove = !!approval?.can_approve;
  const floor = approval ? approval.below_pct : -Infinity;
  const save = () => run('save', async () => {
    const r = await api.post(`/rfqs/${rfq.id}/customer-quotes`, { ...body, approved_below_floor: below && canApprove });
    await reload();
    if (r.approval_status === 'pending') return 'pending';
  }, below && !canApprove ? `Saved. Someone with the ${approval.role_name} role must approve the margin before it can be sent.` : 'Quotation created');
  const addOption = (rid) => setEditing({ index: options?.length || 0, value: { label: '', rfq_id: rid || rfq.id, selection: {} } });
  const altRfqs = (family.data || []).filter((r) => r.id !== rfq.id);

  return (
    <>
      {can('quotes.prepare') && <Card
        title={isAgent ? `Quote for partner agent ${rfq.requester_name || ''}` : 'Build quotation'}
        actions={<>
          <Button small variant="ghost" onClick={() => addOption()}>+ Add option</Button>
          {altRfqs.map((r) => <Button key={r.id} small variant="ghost" onClick={() => addOption(r.id)}>+ Option from {r.ref} ({r.mode})</Button>)}
        </>}
      >
        {!options?.length ? (
          <div className="empty">Pick agent quotes on the Compare tab, or add an option here. <Button small variant="ghost" onClick={goCompare}>Go to Compare</Button></div>
        ) : (
          <div className="stack">
            <div className="chips">
              {options.map((o, i) => (
                <span key={i} className="chip on">
                  {o.label || `Option ${letter(i)}`} · {(family.data || []).find((r) => r.id === o.rfq_id)?.mode || rfq.mode}
                  {' '}<button className="link" onClick={() => setEditing({ index: i, value: o })}>edit</button>
                  {options.length > 1 && <> · <button className="link" onClick={() => setOptions(options.filter((_, j) => j !== i))}>remove</button></>}
                </span>
              ))}
            </div>
            <div className="grid g5">
              <Field label="Currency"><Select options={meta.currencies} value={opts.currency} onChange={(e) => setOpts({ ...opts, currency: e.target.value })} /></Field>
              <Field label="Margin %"><Input type="number" step="0.5" value={opts.margin_pct} onChange={(e) => setOpts({ ...opts, margin_pct: Number(e.target.value) })} /></Field>
              <Field label="Tax % (GST)" hint="18% India GST, 0 for Hong Kong / export"><Input type="number" value={opts.tax_pct} onChange={(e) => setOpts({ ...opts, tax_pct: Number(e.target.value) })} /></Field>
              <Field label="Valid until"><Input type="date" value={opts.valid_until} onChange={(e) => setOpts({ ...opts, valid_until: e.target.value })} /></Field>
              <Field label="PDF language"><Select options={meta.languages.map((l) => ({ value: l.code, label: l.name }))} value={opts.language} onChange={(e) => setOpts({ ...opts, language: e.target.value })} /></Field>
            </div>
            <Field label="Terms"><Textarea rows={3} value={opts.terms} onChange={(e) => setOpts({ ...opts, terms: e.target.value })} /></Field>
            {can('costs.view') && preview?.options?.[0]?.totals?.buy > 0 && <MarginAdvice rfqId={rfq.id} buy={preview.options[0].totals.buy} current={opts.margin_pct} currency={preview.currency} onUse={(m) => setOpts({ ...opts, margin_pct: m })} />}
            {preview?.error && <ErrorBox error={preview.error} />}
            {preview?.changes?.length > 0 && (
              <div className="alert alert-amber small"><b>Revision of {preview.previous.ref}.</b> Changes:<ul>{preview.changes.map((c, i) => <li key={i}>{c}</li>)}</ul></div>
            )}
            {preview?.options?.map((o, oi) => (
              <div key={oi} className="option-block">
                {preview.options.length > 1 && <h4>{o.label}</h4>}
                {o.sections.map((s) => (
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
                  <div>Buy <b>{money(o.totals.buy, preview.currency)}</b></div>
                  <div>Sell <b>{money(o.totals.sell, preview.currency)}</b></div>
                  <div>Profit <b className={o.totals.margin_pct_effective < floor ? 'err' : 'ok'}>{money(o.totals.profit, preview.currency)} ({o.totals.margin_pct_effective}%)</b></div>
                  <div>Tax <b>{money(o.totals.tax, preview.currency)}</b></div>
                  <div className="grand">Total <b>{money(o.totals.grand_total, preview.currency)}</b></div>
                </div>
              </div>
            ))}
            {below && <div className="alert alert-amber">Margin is below {approval.below_pct}%, so it needs approval by the <b>{approval.role_name}</b> role. {canApprove ? 'You hold that role and can approve it now.' : 'It will be sent to them for approval.'}</div>}
            {preview?.options && <div className="row end"><Button busy={busy === 'save'} onClick={save}>{below ? (canApprove ? 'Approve & create quotation' : 'Request approval') : 'Create quotation'}</Button></div>}
          </div>
        )}
      </Card>}

      <Card title={isAgent ? 'Quotations sent to the agent' : 'Quotations'}>
        <Table
          rows={customerQuotes}
          empty="None yet."
          columns={[
            { key: 'ref', label: 'Ref', render: (r) => <><b>{r.ref}</b>{r.snapshot?.options?.length > 1 && <div className="small muted">{r.snapshot.options.length} options</div>}</> },
            { label: 'Total', render: (r) => (r.snapshot?.options?.length > 1 ? r.snapshot.options.map((o, i) => <div key={i} className="small">{o.label}: {money(o.totals.grand_total, r.currency)}</div>) : money(r.snapshot?.totals?.grand_total, r.currency)) },
            ...(can('costs.view') ? [{ label: 'Profit', render: (r) => `${money(r.snapshot?.totals?.profit, r.currency)} (${r.snapshot?.totals?.margin_pct_effective}%)` }] : []),
            { label: 'Valid until', render: (r) => fmtDate(r.valid_until) },
            {
              label: 'Status', render: (r) => (
                <>
                  <Badge>{r.status}</Badge>{' '}
                  {r.approval_status === 'pending' && <Badge color="amber">awaiting {r.approval_role_name || 'approval'}</Badge>}
                  {r.approval_status === 'rejected' && <Badge color="red">not approved</Badge>}
                  {r.approval_note && <div className="small muted">{r.approval_note}</div>}
                  {r.accepted_option !== null && r.accepted_option !== undefined && r.snapshot?.options?.length > 1 && <div className="small ok">accepted: {r.snapshot.options[r.accepted_option]?.label}</div>}
                  {r.followup_count ? <div className="small muted">followed up {r.followup_count}×</div> : null}
                  {r.lost_reason && <div className="small err">{r.lost_reason}{r.lost_note ? ` — ${r.lost_note}` : ''}</div>}
                </>
              ),
            },
            {
              label: '', render: (r) => (
                <div className="row gap-sm wrap">
                  <a className="btn btn-ghost btn-sm" href={`/api/customer-quotes/${r.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
                  {r.approval_status === 'pending' && r.can_approve && <>
                    <Button small busy={busy === `ap${r.id}`} onClick={() => run(`ap${r.id}`, async () => { await api.post(`/customer-quotes/${r.id}/approval`, { approve: true }); await reload(); }, 'Approved')}>Approve</Button>
                    <Button small variant="ghost" onClick={() => { const note = prompt('Reason for not approving?') ?? ''; run(`rj${r.id}`, async () => { await api.post(`/customer-quotes/${r.id}/approval`, { approve: false, note }); await reload(); }, 'Not approved'); }}>Reject</Button>
                  </>}
                  {can('quotes.send') && ['draft', 'sent'].includes(r.status) && !['pending', 'rejected'].includes(r.approval_status) && <Button small variant="ghost" onClick={() => setSendTo({ quote: r, to: requester.data?.email || '' })}>{r.status === 'sent' ? 'Resend' : 'Email'}</Button>}
                  {can('quotes.send') && r.status === 'sent' && <Button small variant="ghost" busy={busy === `f${r.id}`} onClick={() => run(`f${r.id}`, async () => { await api.post(`/customer-quotes/${r.id}/follow-up`); await reload(); }, 'Follow-up email sent')}>Follow up</Button>}
                  {can('quotes.decide') && ['sent', 'expired', 'draft'].includes(r.status) && <Button small variant="ghost" onClick={() => setLost({ quote: r, reason: '', note: '' })}>Lost</Button>}
                  {can('quotes.decide') && ['sent', 'draft', 'expired'].includes(r.status) && !['pending', 'rejected'].includes(r.approval_status) && <Button small onClick={() => setAccepting({ quote: r, option: 0 })}>Accepted → award</Button>}
                  {r.status === 'accepted' && (jobOf(r) ? can('jobs.view') && <Link className="btn btn-primary btn-sm" to={`/jobs/${jobOf(r).id}`}>Job {jobOf(r).ref}</Link> : can('jobs.manage') && <Button small busy={busy === `j${r.id}`} onClick={() => run(`j${r.id}`, async () => { const x = await api.post(`/customer-quotes/${r.id}/job`, { option: r.accepted_option || 0 }); navTo(`/jobs/${x.job.id}`); })}>Open job</Button>)}
                </div>
              ),
            },
          ]}
        />
      </Card>

      {editing && (
        <Modal wide title={editing.index < (options?.length || 0) ? 'Edit option' : 'Add option'} onClose={() => setEditing(null)} footer={<Button disabled={!Object.keys(editing.value.selection || {}).length} onClick={() => {
          const next = [...(options || [])];
          next[editing.index] = editing.value;
          setOptions(next);
          setEditing(null);
        }}>Save option</Button>}>
          <OptionEditor value={editing.value} onChange={(v) => setEditing({ ...editing, value: v })} family={family.data || [rfq]} />
          <p className="muted small">To offer the same shipment by air as well as sea, use "Add alternative" at the top of the RFQ, collect air rates there, then add it as an option here.</p>
        </Modal>
      )}
      {accepting && (
        <Modal title={`${accepting.quote.ref} accepted`} onClose={() => setAccepting(null)} footer={<Button busy={busy === 'acc'} onClick={() => run('acc', async () => {
          const res = await api.post(`/customer-quotes/${accepting.quote.id}/accept`, { option: accepting.option });
          setAccepting(null);
          await reload();
          const f = res.results.filter((x) => !x.ok);
          if (f.length) throw new Error(`${f.length} email(s) failed: ${f[0].error}. Job ${res.job.ref} was opened.`);
          if (res.job) navTo(`/jobs/${res.job.id}`);
        }, 'Accepted. Winning agents notified; job opened.')}>Confirm, notify agents & open job</Button>}>
          {accepting.quote.snapshot?.options?.length > 1 && (
            <Field label="Which option did they choose?">
              <Select value={accepting.option} options={accepting.quote.snapshot.options.map((o, i) => ({ value: i, label: `${o.label} — ${money(o.totals.grand_total, accepting.quote.currency)}` }))} onChange={(e) => setAccepting({ ...accepting, option: Number(e.target.value) })} />
            </Field>
          )}
          <p>The winning agents get a confirmation email; agents who quoted but did not win get a polite decline. A job opens for the booking stage.</p>
        </Modal>
      )}
      {lost && (
        <Modal title={`Mark ${lost.quote.ref} as lost`} onClose={() => setLost(null)} footer={<Button busy={busy === 'lost'} disabled={!lost.reason} onClick={() => run('lost', async () => { await api.post(`/customer-quotes/${lost.quote.id}/lost`, lost); setLost(null); await reload(); }, 'Marked as lost')}>Save</Button>}>
          <Field label="Why was it lost?"><Select placeholder="— choose —" options={reasons.data || []} value={lost.reason} onChange={(e) => setLost({ ...lost, reason: e.target.value })} /></Field>
          <Field label={`Competitor's price, if known (${lost.quote.currency})`}><Input type="number" value={lost.competitor_price} onChange={(e) => setLost({ ...lost, competitor_price: e.target.value })} /></Field>
          <Field label="Note"><Textarea rows={3} value={lost.note} onChange={(e) => setLost({ ...lost, note: e.target.value })} /></Field>
        </Modal>
      )}
      {sendTo && (
        <Modal title={`Email ${sendTo.quote.ref} to ${rfq.requester_name || 'requester'}`} onClose={() => setSendTo(null)} footer={<Button busy={busy === 'send'} onClick={() => run('send', async () => { await api.post(`/customer-quotes/${sendTo.quote.id}/send`, { to: sendTo.to }); setSendTo(null); await reload(); }, 'Quotation emailed')}>Send with PDF</Button>}>
          <Field label="To"><Input value={sendTo.to} onChange={(e) => setSendTo({ ...sendTo, to: e.target.value })} /></Field>
          <EmailPreviewNote data={data} quote={sendTo.quote} />
        </Modal>
      )}
    </>
  );
}
