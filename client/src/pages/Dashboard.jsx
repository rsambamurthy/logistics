import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { PageHeader, Card, Table, Badge, Stat, Button, Loading, ErrorBox, useLoad, fmtDate, Select } from '../components/ui.jsx';
import { routeOf } from '../components/rfq.jsx';
import SetupGuide from '../components/SetupGuide.jsx';
import { useCan } from '../components/session.js';
import { CutoffList } from '../components/jobs.jsx';

export default function Dashboard() {
  const nav = useNavigate();
  const stats = useLoad(() => api.get('/dashboard'));
  const can = useCan();
  const list = useLoad(() => (can('rfqs.view') ? api.get('/rfqs') : Promise.resolve([])));
  const [filter, setFilter] = useState('');
  const rows = (list.data || []).filter((r) => !filter || r.status === filter);
  return (
    <>
      <PageHeader title={can('rfqs.view') ? 'RFQs' : 'Home'} sub={can('rfqs.view') ? 'Enquiries from customers and partner agents, and the rates collected for them' : undefined} actions={can('rfqs.edit') && <Button onClick={() => nav('/rfqs/new')}>+ New RFQ</Button>} />
      {can('settings.manage') && <SetupGuide />}
      {stats.data && (
        <div className="stats">
          {stats.data.new_enquiries != null && <Stat label="New enquiries by email" value={stats.data.new_enquiries} tone={stats.data.new_enquiries ? 'warn' : ''} />}
          {stats.data.open != null && <Stat label="Open (waiting for agents)" value={stats.data.open} />}
          {stats.data.needs_review != null && <Stat label="Agent quotes to review" value={stats.data.needs_review} tone={stats.data.needs_review ? 'warn' : ''} />}
          {stats.data.approvals_pending != null && <Stat label="Quotes awaiting approval" value={stats.data.approvals_pending} tone={stats.data.approvals_pending ? 'warn' : ''} />}
          {stats.data.quoted != null && <Stat label="Quoted to customer" value={stats.data.quoted} />}
          {stats.data.awarded != null && <Stat label="Awarded" value={stats.data.awarded} />}
          {stats.data.unmatched != null && <Stat label="Unmatched emails" value={stats.data.unmatched} tone={stats.data.unmatched ? 'warn' : ''} />}
          {stats.data.rate_cards_expiring != null && <Stat label="Rate cards expiring in 7 days" value={stats.data.rate_cards_expiring} tone={stats.data.rate_cards_expiring ? 'warn' : ''} />}
          {stats.data.jobs && <Stat label="Jobs waiting for booking" value={(stats.data.jobs.open || 0) + (stats.data.jobs.booking_requested || 0)} tone={stats.data.jobs.open ? 'warn' : ''} />}
          {stats.data.jobs && <Stat label="Jobs booked / moving" value={(stats.data.jobs.booked || 0) + (stats.data.jobs.moving || 0)} />}
        </div>
      )}
      {stats.data?.cutoffs?.length ? <Card title="Cut-offs in the next 3 days" actions={<Button small variant="ghost" onClick={() => nav('/jobs')}>All jobs</Button>}><CutoffList rows={stats.data.cutoffs} /></Card> : null}
      {can('rfqs.view') && <Card title="All RFQs" actions={<Select value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="All statuses" options={['new', 'draft', 'sent', 'quoting', 'quoted', 'awarded', 'lost', 'expired', 'closed']} />}>
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
      </Card>}
    </>
  );
}
