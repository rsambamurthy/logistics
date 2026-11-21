import { Receivables } from '../components/planning.jsx';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { PageHeader, Card, Table, Input, Select, Loading, ErrorBox, useLoad, money, fmtDate } from '../components/ui.jsx';
import { useCan } from '../components/session.js';
import { RiskBadge } from '../components/DelayRisk.jsx';
import { StatusBadge, JOB_STATUS, CutoffList, fmtLocal } from '../components/jobs.jsx';

export default function Jobs() {
  const can = useCan();
  const nav = useNavigate();
  const [status, setStatus] = useState('active');
  const [search, setSearch] = useState('');
  const list = useLoad(() => api.get(`/jobs?status=${status}&search=${encodeURIComponent(search)}`), [status, search], { refresh: 60000 });
  const cut = useLoad(() => api.get('/jobs/cutoffs?hours=72'));
  return (
    <>
      <PageHeader title="Jobs" sub="Accepted quotations: bookings with partner agents, cut-offs, documents and profit" />
      {can('data.all') && <AtRisk />}
      {can('costs.view') && can('data.all') && <InvoicesToCheck />}
      {can('data.all') && <Receivables />}
      {cut.data?.length ? <Card title="Cut-offs in the next 3 days"><CutoffList rows={cut.data} /></Card> : null}
      <Card
        title="Jobs"
        actions={
          <div className="row gap-sm filters">
            <Input placeholder="Search job, RFQ, customer, port" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: 'active', label: 'Active' }, { value: '', label: 'All' }, ...Object.entries(JOB_STATUS).map(([value, [label]]) => ({ value, label }))]} />
          </div>
        }
      >
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : (
          <Table
            rows={list.data}
            onRowClick={(r) => nav(`/jobs/${r.id}`)}
            empty="No jobs yet. A job opens when a customer accepts a quotation."
            columns={[
              { label: 'Job', render: (r) => <><b>{r.ref}</b><div className="small muted">{r.rfq_ref}</div></> },
              { key: 'customer', label: 'Customer' },
              { label: 'Route', render: (r) => `${r.mode || ''} ${[r.pol, r.pod].filter(Boolean).join(' → ')}` },
              { label: 'Bookings', render: (r) => `${r.confirmed}/${r.bookings} confirmed`, align: 'center' },
              { label: 'ETD', render: (r) => (r.etd ? fmtLocal(r.etd) : '—') },
              ...(can('costs.view') ? [{ label: 'Profit', render: (r) => <span className={r.profit?.profit < 0 ? 'err' : ''}>{money(r.profit?.profit, r.profit?.currency)}</span>, align: 'right' }] : []),
              { label: 'Status', render: (r) => <><StatusBadge status={r.status} /> {['at_risk', 'late'].includes(r.delay_risk?.risk) && <RiskBadge r={r.delay_risk} />}</> },
              { label: 'Opened', render: (r) => fmtDate(r.created_at) },
            ]}
          />
        )}
      </Card>
    </>
  );
}

/** Agent invoices the leakage check flagged, across all jobs. */
function InvoicesToCheck() {
  const nav = useNavigate();
  const list = useLoad(() => api.get('/agent-invoices'), [], { refresh: 120000 });
  if (!list.data?.length) return null;
  return (
    <Card title={`Agent invoices to check (${list.data.length})`}>
      <Table rows={list.data} onRowClick={(i) => nav(`/jobs/${i.job_id}`)} columns={[
        { label: 'Job', key: 'job_ref' }, { label: 'Agent', render: (i) => i.agent || '—' }, { label: 'Invoice', render: (i) => i.invoice_no || '—' },
        { label: 'Above quote', render: (i) => (Number(i.leakage) > 0 ? <b className="err">{money(i.leakage, i.currency)}</b> : '—'), align: 'right' },
        { label: 'Received', render: (i) => fmtDate(i.created_at) },
      ]} />
    </Card>
  );
}

/** Open jobs the delay prediction flags. */
function AtRisk() {
  const nav = useNavigate();
  const list = useLoad(() => api.get('/delays'), [], { refresh: 300000 });
  if (!list.data?.length) return null;
  return (
    <Card title={`Shipments at risk of delay (${list.data.length})`}>
      <Table rows={list.data} onRowClick={(j) => nav(`/jobs/${j.id}`)} columns={[
        { label: 'Job', key: 'ref' }, { label: 'Customer', render: (j) => j.customer || '—' },
        { label: 'Route', render: (j) => `${j.mode} ${[j.pol, j.pod].filter(Boolean).join(' → ')}` },
        { label: 'Risk', render: (j) => <RiskBadge r={j.delay_risk} /> },
        { label: 'Expected', render: (j) => j.delay_risk.expected_eta || '—' },
        { label: 'Why', render: (j) => <span className="small">{j.delay_risk.signals?.[0]?.text}</span> },
        { label: 'Customer told', render: (j) => (j.delay_risk.warned_eta === j.delay_risk.expected_eta ? 'yes' : '—') },
      ]} />
    </Card>
  );
}
