// Tenant subscription: plan choice, Razorpay checkout, webhook.
import express from 'express';
import { pq, pone } from '../db.js';
import { requireAdmin } from '../auth.js';
import { getTenant, updateTenant, accessState, usage, clearTenantCache } from '../services/tenants.js';
import { onSubscriptionEvent } from '../services/lifecycle.js';
import { razorpayEnabled, createPlan, createSubscription, updateSubscription, cancelSubscription, getSubscription, verifyWebhook, statusFromRazorpay } from '../services/razorpay.js';

const router = express.Router();
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function summary(req) {
  const t = await getTenant(req.tenant.id, { fresh: true });
  return {
    tenant: { id: t.id, name: t.name, status: t.status, plan_code: t.plan_code, plan_name: t.plan_name, seats: t.seats, trial_ends_at: t.trial_ends_at, current_period_end: t.current_period_end, country: t.country, has_subscription: !!t.razorpay_subscription_id },
    access: accessState(t),
    usage: await usage(t),
    plans: await pq('SELECT code,name,price_inr,price_hkd,max_users,max_rfqs_month,ai_enabled FROM plans WHERE active ORDER BY sort'),
    online_payment: razorpayEnabled(),
  };
}

router.get('/', h(async (req, res) => res.json(await summary(req))));

/** Start or change a subscription. Returns a Razorpay payment link for new subscriptions. */
router.post('/subscribe', requireAdmin, h(async (req, res) => {
  const plan = await pone('SELECT * FROM plans WHERE code=$1 AND active', [req.body.plan_code]);
  if (!plan) return res.status(400).json({ error: 'Unknown plan' });
  const t = await getTenant(req.tenant.id, { fresh: true });
  const u = await usage(t);
  if (plan.max_users && u.users > plan.max_users) return res.status(400).json({ error: `You have ${u.users} users; the ${plan.name} plan allows ${plan.max_users}.` });
  const seats = Math.max(Number(req.body.seats) || u.users, u.users, 1);
  let planId = plan.razorpay_plan_id;
  if (!planId) {
    const p = await createPlan(plan);
    planId = p.id;
    await pq('UPDATE plans SET razorpay_plan_id=$1 WHERE code=$2', [planId, plan.code]);
  }
  if (t.razorpay_subscription_id && t.status === 'active') {
    await updateSubscription(t.razorpay_subscription_id, { planId, quantity: seats });
    await updateTenant(t.id, { plan_code: plan.code, seats });
    await pq("INSERT INTO billing_events(tenant_id,type,payload) VALUES($1,'plan_changed',$2)", [t.id, { plan: plan.code, seats }]);
    return res.json({ changed: true, ...(await summary(req)) });
  }
  const sub = await createSubscription({ planId, quantity: seats, tenant: t });
  await updateTenant(t.id, { plan_code: plan.code, seats, razorpay_subscription_id: sub.id });
  await pq("INSERT INTO billing_events(tenant_id,type,payload) VALUES($1,'subscription_created',$2)", [t.id, { id: sub.id, plan: plan.code, seats }]);
  res.json({ payment_url: sub.short_url });
}));

/** Re-check status with Razorpay (e.g. right after paying). */
router.post('/refresh', h(async (req, res) => {
  const t = await getTenant(req.tenant.id, { fresh: true });
  if (t.razorpay_subscription_id && razorpayEnabled()) await applySubscription(await getSubscription(t.razorpay_subscription_id), t.id);
  res.json(await summary(req));
}));

router.post('/cancel', requireAdmin, h(async (req, res) => {
  const t = await getTenant(req.tenant.id, { fresh: true });
  if (!t.razorpay_subscription_id) return res.status(400).json({ error: 'No online subscription to cancel' });
  await cancelSubscription(t.razorpay_subscription_id);
  await pq("INSERT INTO billing_events(tenant_id,type,payload) VALUES($1,'cancel_requested',NULL)", [t.id]);
  res.json({ ok: true, message: 'Cancelled at the end of the current billing period.' });
}));

async function applySubscription(sub, tenantId) {
  const status = statusFromRazorpay(sub.status);
  const patch = {};
  if (status) patch.status = status;
  if (sub.current_end) patch.current_period_end = new Date(sub.current_end * 1000).toISOString();
  if (sub.quantity) patch.seats = sub.quantity;
  if (Object.keys(patch).length) await updateTenant(tenantId, patch);
}

/** Razorpay webhook: keeps tenant status in step with payments. Mounted before auth. */
const webhook = express.Router();
webhook.post('/', h(async (req, res) => {
  if (!verifyWebhook(req.rawBody, req.headers['x-razorpay-signature'])) return res.status(400).json({ error: 'Bad signature' });
  const event = req.body?.event;
  const sub = req.body?.payload?.subscription?.entity;
  if (sub) {
    const t = (await pone('SELECT id FROM tenants WHERE razorpay_subscription_id=$1', [sub.id])) || (sub.notes?.tenant_id ? await pone('SELECT id FROM tenants WHERE id=$1', [Number(sub.notes.tenant_id)]) : null);
    if (t) {
      await applySubscription(sub, t.id);
      clearTenantCache(t.id);
      await pq('INSERT INTO billing_events(tenant_id,type,payload) VALUES($1,$2,$3)', [t.id, event, req.body]);
      onSubscriptionEvent(t.id, event).catch((e) => console.error('billing notice', e.message));
    }
  } else if (event === 'payment.failed') {
    // payment events carry the subscription id on the payment entity
    const pay = req.body?.payload?.payment?.entity;
    const t = pay?.subscription_id ? await pone('SELECT id FROM tenants WHERE razorpay_subscription_id=$1', [pay.subscription_id]) : null;
    if (t) {
      await pq('INSERT INTO billing_events(tenant_id,type,payload) VALUES($1,$2,$3)', [t.id, event, req.body]);
      onSubscriptionEvent(t.id, event).catch((e) => console.error('billing notice', e.message));
    }
  }
  res.json({ ok: true });
}));

export default { router, webhook };
