import { useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Card, Input, Select, Loading, ErrorBox, useLoad } from '../components/ui.jsx';
import ActivityList from '../components/ActivityList.jsx';

export default function Activity() {
  const [f, setF] = useState({ search: '', user: '', days: '30' });
  const users = useLoad(() => api.get('/users').catch(() => []));
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const list = useLoad(() => api.get(`/audit?${qs}`), [qs]);
  return (
    <>
      <PageHeader title="Activity log" sub="Who did what, and what Quayly did automatically" />
      <Card>
        <div className="row gap wrap filters" style={{ marginBottom: 12 }}>
          <Input placeholder="Search actions…" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
          <Select placeholder="Everyone" options={(users.data || []).map((u) => ({ value: u.id, label: u.name }))} value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} />
          <Select options={[{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '365', label: 'Last 12 months' }]} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />
        </div>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : <ActivityList rows={list.data} />}
      </Card>
    </>
  );
}
