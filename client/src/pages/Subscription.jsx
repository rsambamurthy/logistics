import { api } from '../api.js';
import { PageHeader, Card, Button, Badge, Stat, Loading, ErrorBox, useLoad, useAction, fmtDate, money } from '../components/ui.jsx';

const STATE_LABEL = { trialing: 'Free trial', active: 'Active', past_due: 'Payment due', trial_ended: 'Trial ended', suspended: 'Suspended', cancelled: 'Cancelled' };

export default function Subscription({ admin }) {
  const b = useLoad(() => api.get('/billing'));
  const [busy, run] = useAction();
  if (b.loading && !b.data) return <Loading />;
  if (b.error) return <ErrorBox error={b.error} />;
  const { tenant, access, usage, plans, online_payment } = b.data;
  const hk = tenant.country === 'HK';
  const choose = (code) => run(code, async () => {
    const r = await api.post('/billing/subscribe', { plan_code: code, seats: usage.users });
    if (r.payment_url) window.open(r.payment_url, '_blank');
    else b.setData(r);
    window.dispatchEvent(new Event('aq:session'));
  }, 'Opening secure payment page…');
  return (
    <>
      <PageHeader title="Subscription" sub="Your plan, usage and billing" actions={online_payment && tenant.has_subscription && <Button variant="ghost" busy={busy === 'r'} onClick={() => run('r', async () => { b.setData(await api.post('/billing/refresh')); window.dispatchEvent(new Event('aq:session')); }, 'Status refreshed')}>I've paid, refresh</Button>} />
      <div className="stats">
        <Stat label="Status" value={<Badge color={access.ok ? 'green' : 'red'}>{STATE_LABEL[access.state] || access.state}</Badge>} />
        <Stat label="Plan" value={tenant.plan_name} />
        <Stat label={access.state === 'trialing' ? 'Trial ends' : 'Paid until'} value={fmtDate(access.state === 'trialing' ? tenant.trial_ends_at : tenant.current_period_end)} />
        <Stat label="Users" value={`${usage.users}${usage.max_users ? ` / ${usage.max_users}` : ''}`} />
        <Stat label="RFQs this month" value={`${usage.rfqs_this_month}${usage.max_rfqs_month ? ` / ${usage.max_rfqs_month}` : ''}`} />
      </div>
      {!access.ok && <div className="alert alert-red">{access.message}</div>}
      <Card title="Plans" actions={<span className="muted small">Price per user per month{hk ? ' (charged in INR by Razorpay)' : ', plus GST'}</span>}>
        <div className="plans">
          {plans.map((p) => {
            const current = p.code === tenant.plan_code && access.state === 'active';
            return (
              <div key={p.code} className={`plan${p.code === tenant.plan_code ? ' current' : ''}`}>
                <b>{p.name}</b>
                <div className="price">{hk ? `HK$${p.price_hkd}` : `₹${Number(p.price_inr).toLocaleString('en-IN')}`}<small> /user/month</small></div>
                <div className="small">{p.max_users ? `Up to ${p.max_users} users` : 'Unlimited users'}</div>
                <div className="small">{p.max_rfqs_month ? `${p.max_rfqs_month} RFQs a month` : 'Unlimited RFQs'}</div>
                <div className="small">{p.ai_enabled ? 'AI reading of replies and enquiries included' : 'Bring your own AI key'}</div>
                {admin && (current ? <Badge color="green">current plan</Badge> : (
                  <Button small busy={busy === p.code} onClick={() => choose(p.code)} disabled={!online_payment}>
                    {access.state === 'active' && tenant.has_subscription ? `Switch to ${p.name}` : `Choose ${p.name}`}
                  </Button>
                ))}
              </div>
            );
          })}
        </div>
        {!online_payment && <p className="muted small">Online payment is being set up. To activate a plan now, write to info@integratatech.ai.</p>}
        {!admin && <p className="muted small">Only your company admin can change the plan.</p>}
      </Card>
      {admin && tenant.has_subscription && access.state === 'active' && (
        <Card><Button variant="ghost" small busy={busy === 'c'} onClick={() => run('c', async () => { if (!confirm('Cancel at the end of the current billing period?')) return; await api.post('/billing/cancel'); }, 'Subscription will end at the close of this period')}>Cancel subscription</Button></Card>
      )}
    </>
  );
}
