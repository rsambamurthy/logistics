// Minimal Razorpay Subscriptions client (REST, no SDK). Keys come from environment variables.
import crypto from 'node:crypto';

const API = 'https://api.razorpay.com/v1';
export const razorpayEnabled = () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

async function call(method, path, body) {
  if (!razorpayEnabled()) throw Object.assign(new Error('Online payment is not set up yet. Contact Integrata to activate your plan.'), { status: 400 });
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Razorpay: ${data?.error?.description || res.status}`), { status: 502 });
  return data;
}

export const createPlan = (plan) =>
  call('POST', '/plans', {
    period: 'monthly',
    interval: 1,
    item: { name: `AgentQuote ${plan.name} (per user)`, amount: Math.round(Number(plan.price_inr) * 100), currency: 'INR' },
    notes: { plan_code: plan.code },
  });

export const createSubscription = ({ planId, quantity, tenant }) =>
  call('POST', '/subscriptions', {
    plan_id: planId,
    total_count: 120,
    quantity: Math.max(1, quantity),
    customer_notify: 1,
    notes: { tenant_id: String(tenant.id), tenant: tenant.name },
  });

export const updateSubscription = (id, { planId, quantity }) =>
  call('PATCH', `/subscriptions/${id}`, { plan_id: planId, quantity: Math.max(1, quantity), schedule_change_at: 'now' });

export const getSubscription = (id) => call('GET', `/subscriptions/${id}`);
export const cancelSubscription = (id) => call('POST', `/subscriptions/${id}/cancel`, { cancel_at_cycle_end: 1 });

export function verifyWebhook(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Map a Razorpay subscription status to our tenant status. */
export function statusFromRazorpay(s) {
  if (['active', 'authenticated'].includes(s)) return 'active';
  if (['pending', 'halted', 'paused'].includes(s)) return 'past_due';
  if (['cancelled', 'completed', 'expired'].includes(s)) return 'cancelled';
  return null;
}
