// Integrata platform console (platform admins only): tenants and plans.
import { useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Card, Table, Button, Modal, FormGrid, Badge, Loading, ErrorBox, useLoad, useAction, fmtDate } from '../components/ui.jsx';

export function Tenants() {
  const list = useLoad(() => api.get('/platform/tenants'));
  const plans = useLoad(() => api.get('/platform/plans'));
  const [edit, setEdit] = useState(null);
  const [busy, run] = useAction();
  const act = (t, body, msg) => run(`${t.id}`, async () => { await api.put(`/platform/tenants/${t.id}`, body); await list.reload(); }, msg);
  return (
    <>
      <PageHeader title="Tenants" sub="Every company using Quayly" />
      <Card>
        {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : (
          <Table rows={list.data} onRowClick={(t) => setEdit({ ...t, trial_ends_at: t.trial_ends_at?.slice(0, 10), current_period_end: t.current_period_end?.slice(0, 10) })} columns={[
            { label: 'Company', render: (t) => <div><b>{t.name}</b><div className="muted small">{t.billing_email} · {t.country}</div></div> },
            { label: 'Status', render: (t) => <Badge color={t.access?.ok ? 'green' : 'red'}>{t.access?.state}</Badge> },
            { key: 'plan_name', label: 'Plan' },
            { label: 'Users', render: (t) => `${t.users ?? '—'}${t.max_users ? `/${t.max_users}` : ''}`, align: 'center' },
            { label: 'RFQs (month)', render: (t) => t.rfqs_this_month ?? '—', align: 'center' },
            { label: 'Trial ends', render: (t) => fmtDate(t.trial_ends_at) },
            { label: 'Paid until', render: (t) => fmtDate(t.current_period_end) },
            { label: 'Last RFQ', render: (t) => fmtDate(t.last_rfq_at) },
            { label: '', render: (t) => (
              <div className="row gap-sm wrap" style={{ maxWidth: 260 }} onClick={(e) => e.stopPropagation()}>
                <Button small variant="ghost" busy={busy === `${t.id}`} onClick={() => act(t, { extend_trial_days: 14 }, 'Trial extended by 14 days')}>+14 days trial</Button>
                <Button small variant="ghost" onClick={() => act(t, { activate_months: 1 }, 'Activated for 1 month (manual payment)')}>Mark paid 1 month</Button>
                {t.status === 'suspended'
                  ? <Button small variant="ghost" onClick={() => act(t, { status: 'active' }, 'Reactivated')}>Reactivate</Button>
                  : <Button small variant="ghost" onClick={() => confirm(`Suspend ${t.name}?`) && act(t, { status: 'suspended' }, 'Suspended')}>Suspend</Button>}
              </div>
            ) },
          ]} />
        )}
      </Card>
      {edit && (
        <Modal title={`Tenant: ${edit.name}`} onClose={() => setEdit(null)} footer={<Button busy={busy === 'save'} onClick={() => run('save', async () => { await api.put(`/platform/tenants/${edit.id}`, edit); setEdit(null); list.reload(); }, 'Saved')}>Save</Button>}>
          <FormGrid cols={2} value={edit} onChange={setEdit} fields={[
            { key: 'name', label: 'Company' },
            { key: 'status', label: 'Status', type: 'select', options: ['trialing', 'active', 'past_due', 'suspended', 'cancelled'] },
            { key: 'plan_code', label: 'Plan', type: 'select', options: (plans.data || []).map((p) => ({ value: p.code, label: p.name })) },
            { key: 'seats', label: 'Seats', type: 'number' },
            { key: 'trial_ends_at', label: 'Trial ends', type: 'date' },
            { key: 'current_period_end', label: 'Paid until', type: 'date' },
            { key: 'notes', label: 'Notes', type: 'textarea', span: 2 },
          ]} />
        </Modal>
      )}
    </>
  );
}

export function Plans() {
  const list = useLoad(() => api.get('/platform/plans'));
  const [edit, setEdit] = useState(null);
  const [busy, run] = useAction();
  return (
    <>
      <PageHeader title="Plans" sub="Prices are per user per month. Changing the INR price creates a new Razorpay plan for new subscriptions." actions={<Button onClick={() => setEdit({ isNew: true, ai_enabled: true, active: true })}>+ Add plan</Button>} />
      <Card>
        {list.loading ? <Loading /> : (
          <Table rows={list.data} rowKey="code" onRowClick={(p) => setEdit({ ...p })} columns={[
            { key: 'name', label: 'Plan', render: (p) => <><b>{p.name}</b> {!p.active && <Badge>hidden</Badge>}</> },
            { key: 'price_inr', label: '₹ / user / month' },
            { key: 'price_hkd', label: 'HK$ / user / month' },
            { key: 'max_users', label: 'Max users', render: (p) => p.max_users ?? 'Unlimited' },
            { key: 'max_rfqs_month', label: 'RFQs / month', render: (p) => p.max_rfqs_month ?? 'Unlimited' },
            { key: 'ai_enabled', label: 'AI included', render: (p) => (p.ai_enabled ? 'Yes' : 'No') },
            { key: 'razorpay_plan_id', label: 'Razorpay plan', render: (p) => <span className="small muted">{p.razorpay_plan_id || 'created on first sale'}</span> },
          ]} />
        )}
      </Card>
      {edit && (
        <Modal title={edit.isNew ? 'Add plan' : `Plan: ${edit.name}`} onClose={() => setEdit(null)} footer={<Button busy={busy} onClick={() => run('x', async () => {
          if (edit.isNew) await api.post('/platform/plans', edit);
          else await api.put(`/platform/plans/${edit.code}`, edit);
          setEdit(null);
          list.reload();
        }, 'Plan saved')}>Save</Button>}>
          <FormGrid cols={2} value={edit} onChange={setEdit} fields={[
            ...(edit.isNew ? [{ key: 'code', label: 'Code (e.g. enterprise)' }] : []),
            { key: 'name', label: 'Name' },
            { key: 'price_inr', label: '₹ per user per month', type: 'number' },
            { key: 'price_hkd', label: 'HK$ per user per month', type: 'number' },
            { key: 'max_users', label: 'Max users (blank = unlimited)', type: 'number' },
            { key: 'max_rfqs_month', label: 'RFQs per month (blank = unlimited)', type: 'number' },
            { key: 'sort', label: 'Display order', type: 'number' },
            { key: 'ai_enabled', label: 'AI', type: 'checkbox', checkLabel: 'AI included (uses Integrata key)' },
            { key: 'active', label: 'Status', type: 'checkbox', checkLabel: 'Offered to tenants' },
          ]} />
        </Modal>
      )}
    </>
  );
}
