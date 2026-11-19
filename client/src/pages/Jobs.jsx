import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { PageHeader, Card, Table, Input, Select, Loading, ErrorBox, useLoad, money, fmtDate } from '../components/ui.jsx';
import { useCan } from '../components/session.js';
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
              { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
              { label: 'Opened', render: (r) => fmtDate(r.created_at) },
            ]}
          />
        )}
      </Card>
    </>
  );
}
