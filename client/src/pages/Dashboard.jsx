import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { PageHeader, Card, Table, Badge, Stat, Button, Loading, ErrorBox, useLoad, fmtDate, Select } from '../components/ui.jsx';
import { routeOf } from '../components/rfq.jsx';

export default function Dashboard() {
  const nav = useNavigate();
  const stats = useLoad(() => api.get('/dashboard'));
  const list = useLoad(() => api.get('/rfqs'));
  const [filter, setFilter] = useState('');
  const rows = (list.data || []).filter((r) => !filter || r.status === filter);
  return (
    <>
      <PageHeader title="RFQs" sub="Enquiries from customers and partner agents, and the rates collected for them" actions={<Button onClick={() => nav('/rfqs/new')}>+ New RFQ</Button>} />
      {stats.data && (
        <div className="stats">
          <Stat label="New enquiries by email" value={stats.data.new_enquiries} tone={stats.data.new_enquiries ? 'warn' : ''} />
          <Stat label="Open (waiting for agents)" value={stats.data.open} />
          <Stat label="Agent quotes to review" value={stats.data.needs_review} tone={stats.data.needs_review ? 'warn' : ''} />
          <Stat label="Quoted to customer" value={stats.data.quoted} />
          <Stat label="Awarded" value={stats.data.awarded} />
          <Stat label="Unmatched emails" value={stats.data.unmatched} tone={stats.data.unmatched ? 'warn' : ''} />
          <Stat label="Rate cards expiring in 7 days" value={stats.data.rate_cards_expiring} tone={stats.data.rate_cards_expiring ? 'warn' : ''} />
        </div>
      )}
      <Card title="All RFQs" actions={<Select value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="All statuses" options={['new', 'draft', 'sent', 'quoting', 'quoted', 'awarded', 'lost', 'expired', 'closed']} />}>
        {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : (
          <Table
            rows={rows}
            onRowClick={(r) => nav(`/rfqs/${r.id}`)}
            empty="No RFQs yet. Create one from a customer enquiry."
            columns={[
              { key: 'ref', label: 'Ref', render: (r) => <b>{r.ref}</b> },
              { key: 'requester_name', label: 'Requested by', render: (r) => <>{r.requester_name || '—'} {r.requester_role === 'agent' && <Badge color="blue">agent</Badge>}</> },
              { key: 'mode', label: 'Mode' },
              { label: 'Route', render: routeOf },
              { label: 'Agents replied', render: (r) => `${r.replies}/${r.invites}`, align: 'center' },
              { label: 'To review', render: (r) => (r.to_review ? <Badge color="amber">{r.to_review}</Badge> : ''), align: 'center' },
              { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge> },
              { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at) },
            ]}
          />
        )}
      </Card>
    </>
  );
}
