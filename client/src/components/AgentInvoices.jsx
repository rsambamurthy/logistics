// Agent invoices for a job, checked against what was quoted and booked (cost-leakage check).
import { useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Badge, Table, Modal, Field, Select, Check, Textarea, Loading, ErrorBox, useLoad, useAction, money, fmtDate } from './ui.jsx';
import { useCan } from './session.js';

const STATUS = { to_check: ['amber', 'to check'], ok: ['green', 'matches quote'], approved: ['green', 'approved'], disputed: ['red', 'disputed'] };
const SEV = { high: 'alert-red', low: 'alert-amber', info: '' };

export default function AgentInvoices({ d }) {
  const can = useCan();
  const list = useLoad(() => api.get(`/jobs/${d.job.id}/invoices`), [d.job.id]);
  const [open, setOpen] = useState(null);
  const [pick, setPick] = useState(false);
  const [busy, run] = useAction();
  const agents = [...new Map(d.costs.filter((c) => c.agent_id).map((c) => [c.agent_id, c.agent])).entries()];
  const atts = d.emails.filter((e) => e.direction === 'in').flatMap((e) => (e.attachments || []).map((a) => ({ ...a, from: e.from_addr, subject: e.subject })));
  const readFile = (file) => run('read', async () => {
    const fd = new FormData();
    fd.append('file', file);
    const inv = await api.form(`/jobs/${d.job.id}/invoices/read`, fd);
    await list.reload();
    setOpen(inv.id);
  }, 'Invoice read and checked');
  const readAtt = (id) => run('read', async () => { const inv = await api.post(`/jobs/${d.job.id}/invoices/read`, { attachment_id: id }); setPick(false); await list.reload(); setOpen(inv.id); }, 'Invoice read and checked');
  return (
    <Card title="Agent invoices" actions={can('jobs.manage') && <div className="row gap-sm">
      {atts.length > 0 && <Button small variant="ghost" onClick={() => setPick(true)}>From an email</Button>}
      <label className={`btn btn-primary btn-sm${busy === 'read' ? ' disabled' : ''}`}>{busy === 'read' ? 'Reading…' : 'Upload invoice'}<input type="file" hidden accept=".pdf,image/*" onChange={(e) => e.target.files[0] && readFile(e.target.files[0])} /></label>
    </div>}>
      <p className="small muted">The agent reads each invoice and checks it against this job's quoted costs for that agent: charges that were not quoted, amounts above the quote, totals that don't add up and invoices entered twice. Invoices emailed to the job are read automatically.</p>
      {list.error ? <ErrorBox error={list.error} /> : !list.data ? <Loading /> : (
        <Table rows={list.data} onRowClick={(i) => setOpen(i.id)} empty="No agent invoices yet." columns={[
          { label: 'Invoice', render: (i) => <><b>{i.invoice_no || '—'}</b> <span className="muted small">{fmtDate(i.invoice_date)}</span></> },
          { label: 'Agent', render: (i) => i.agent || <span className="err">not set</span> },
          { label: 'Total', render: (i) => money(i.total, i.currency), align: 'right' },
          { label: 'Above quote', render: (i) => (Number(i.leakage) > 0 ? <b className="err">{money(i.leakage, i.currency)}</b> : '—'), align: 'right' },
          { label: 'Status', render: (i) => <Badge color={STATUS[i.status]?.[0]}>{STATUS[i.status]?.[1] || i.status}</Badge> },
        ]} />
      )}
      {pick && (
        <Modal title="Read an invoice from an email" onClose={() => setPick(false)}>
          <Table rows={atts} columns={[
            { label: 'File', key: 'filename' }, { label: 'From', key: 'from' }, { label: 'Subject', key: 'subject' },
            { label: '', render: (a) => <Button small busy={busy === 'read'} onClick={() => readAtt(a.id)}>Read</Button> },
          ]} />
        </Modal>
      )}
      {open && list.data && <InvoiceModal inv={list.data.find((x) => x.id === open)} agents={agents} onClose={() => setOpen(null)} onChanged={list.reload} />}
    </Card>
  );
}

function InvoiceModal({ inv, agents, onClose, onChanged }) {
  const [busy, run] = useAction();
  const [addCosts, setAddCosts] = useState(true);
  const [dispute, setDispute] = useState(null);
  if (!inv) return null;
  const r = inv.result || { findings: [], matches: [] };
  const high = r.findings.filter((f) => f.severity === 'high');
  const decide = (decision) => run(decision, async () => { const x = await api.post(`/agent-invoices/${inv.id}/decide`, { decision, add_costs: addCosts }); await onChanged(); if (decision === 'disputed') setDispute(x.dispute_text); else onClose(); }, decision === 'approved' ? 'Approved' : 'Marked disputed');
  return (
    <Modal wide title={`Invoice ${inv.invoice_no || ''} ${inv.agent ? `from ${inv.agent}` : ''}`} onClose={onClose} footer={<>
      <a className="btn btn-ghost btn-sm" href={inv.file_id ? `/api/job-files/${inv.file_id}` : inv.attachment_id ? `/api/attachments/${inv.attachment_id}` : '#'} target="_blank" rel="noreferrer">Open the invoice</a>
      <Button variant="ghost" busy={busy === 'del'} onClick={() => confirm('Delete this invoice record?') && run('del', async () => { await api.del(`/agent-invoices/${inv.id}`); await onChanged(); onClose(); })}>Delete</Button>
      <Button variant="ghost" busy={busy === 'disputed'} onClick={() => decide('disputed')}>Dispute</Button>
      <Button busy={busy === 'approved'} onClick={() => decide('approved')}>Approve for payment</Button>
    </>}>
      <div className="stack">
        <div className="row gap wrap">
          <Field label="Agent"><Select placeholder="— choose —" value={inv.agent_id || ''} options={agents.map(([value, label]) => ({ value, label }))} onChange={(e) => run('ag', async () => { await api.put(`/agent-invoices/${inv.id}`, { agent_id: e.target.value }); await onChanged(); })} /></Field>
          <div className="small">Billed <b>{money(r.invoiced_total, r.currency)}</b> · matched quote lines <b>{money(r.expected_total, r.currency)}</b>{r.leakage > 0 && <> · above quote <b className="err">{money(r.leakage, r.currency)}</b></>}</div>
        </div>
        {!high.length && <div className="alert alert-green small">Every line matches the quote (within 2%).</div>}
        {r.findings.map((f, i) => <div key={i} className={`alert small ${SEV[f.severity] || ''}`}>{f.text}</div>)}
        <Table rows={r.matches.map((m, i) => ({ ...m, id: i }))} columns={[
          { label: 'Invoice line', render: (m) => <>{m.line.description} <span className="muted small">{m.line.code}</span></> },
          { label: 'Billed', render: (m) => money(m.line.amount, m.line.currency || r.currency), align: 'right' },
          { label: 'Quoted', render: (m) => (m.expected ? money(m.expected.amount, m.expected.currency) : <Badge color="red">not quoted</Badge>), align: 'right' },
          { label: 'Difference', render: (m) => (m.diff ? <span className={m.diff > 0 ? 'err' : ''}>{m.diff > 0 ? '+' : ''}{money(m.diff, r.currency)}</span> : '—'), align: 'right' },
        ]} />
        {high.length > 0 && <Check label="When approving, add the extra and over-quote amounts to the job's buy costs (so job profit stays true)" checked={addCosts} onChange={setAddCosts} />}
        {dispute && (
          <Field label="Email to the agent" hint="Copy it, or open it in your mail app.">
            <Textarea rows={10} value={dispute} onChange={(e) => setDispute(e.target.value)} />
            <div className="row gap-sm"><Button small variant="ghost" onClick={() => navigator.clipboard?.writeText(dispute)}>Copy</Button>
              <a className="btn btn-ghost btn-sm" href={`mailto:${inv.agent_email || ''}?subject=${encodeURIComponent(`Invoice ${inv.invoice_no || ''}`)}&body=${encodeURIComponent(dispute)}`}>Open in mail</a></div>
          </Field>
        )}
      </div>
    </Modal>
  );
}
