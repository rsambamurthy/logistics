// Account lifecycle emails: welcome, trial ending / ended, payment problems, subscription active.
import { pq, pone, runAsTenant, q } from '../db.js';
import { listTenants, getTenant, accessState } from './tenants.js';
import { layout, sendSystemMail, appUrl } from './systemMail.js';

/** Admin users + billing email of a tenant. */
async function recipients(t) {
  const admins = await runAsTenant(t, () => q("SELECT email FROM users u WHERE EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_key='admin') AND email_verified_at IS NOT NULL AND disabled_at IS NULL"));
  return [...new Set([t.billing_email, ...admins.map((a) => a.email)].filter(Boolean).map((e) => e.toLowerCase()))];
}

/** Send once per tenant + kind + occasion. Returns true if sent now. */
async function notifyOnce(t, kind, occasion, build) {
  const claimed = await pone('INSERT INTO tenant_notices(tenant_id,kind,occasion) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [t.id, kind, occasion || '']);
  if (!claimed) return false;
  try {
    const to = await recipients(t);
    const m = build(t);
    let delivered = 0;
    for (const addr of to) {
      const r = await sendSystemMail({ to: addr, subject: m.subject, ...layout(m) });
      if (!r?.skipped) delivered++;
    }
    if (!delivered) throw new Error('email not configured or no recipients');
    return true;
  } catch (e) {
    await pq('DELETE FROM tenant_notices WHERE id=$1', [claimed.id]); // try again next run
    console.error(`notice ${kind} for ${t.slug} failed:`, e.message);
    return false;
  }
}

const day = (d) => new Date(d).toDateString();
const link = (path) => `${appUrl()}${path}`;

const TEMPLATES = {
  welcome: (t) => ({
    subject: `Welcome to Quayly, ${t.name}`,
    title: 'Your Quayly account is ready',
    intro: `Your free trial runs until ${day(t.trial_ends_at)}. To get your first quote out: connect your RFQ mailbox, add a few partner agents, then create an RFQ from a customer's enquiry. The setup guide on your dashboard walks you through it.`,
    button: 'Open Quayly',
    link: link('/'),
    outro: 'Questions? Reply to info@integratatech.ai and our team will help you set up.',
  }),
  trial_ending: (t) => ({
    subject: 'Your Quayly trial ends in 3 days',
    title: 'Your free trial is ending soon',
    intro: `Your trial for ${t.name} ends on ${day(t.trial_ends_at)}. Choose a plan to keep sending RFQs and quotations without interruption. Your data stays as it is.`,
    button: 'Choose a plan',
    link: link('/settings/subscription'),
    outro: 'Need more time to evaluate? Write to info@integratatech.ai.',
  }),
  trial_ended: (t) => ({
    subject: 'Your Quayly trial has ended',
    title: 'Your free trial has ended',
    intro: `${t.name}'s account is now read-only: you can see everything, but cannot send RFQs or quotations. Choose a plan to continue right where you left off.`,
    button: 'Choose a plan',
    link: link('/settings/subscription'),
    outro: 'Write to info@integratatech.ai if you need help choosing.',
  }),
  payment_failed: (t) => ({
    subject: 'Action needed: Quayly payment did not go through',
    title: 'We could not collect your payment',
    intro: `The latest payment for ${t.name}'s ${t.plan_name || ''} plan did not go through. Please update your payment method to avoid interruption. Razorpay will also retry automatically.`,
    button: 'Review subscription',
    link: link('/settings/subscription'),
    outro: 'If you have already paid, you can ignore this message.',
  }),
  past_due: (t) => ({
    subject: 'Your Quayly account is now read-only',
    title: 'Payment is overdue',
    intro: `We have not received payment for ${t.name}, so the account is read-only for now. Nothing is lost: pay to continue immediately.`,
    button: 'Pay now',
    link: link('/settings/subscription'),
    outro: 'Write to info@integratatech.ai if something is wrong.',
  }),
  subscription_active: (t) => ({
    subject: `Thank you — your Quayly ${t.plan_name || ''} plan is active`,
    title: 'Subscription active',
    intro: `Thank you! ${t.name} is on the ${t.plan_name || ''} plan${t.current_period_end ? `, paid until ${day(t.current_period_end)}` : ''}. Razorpay sends the payment receipt separately.`,
    button: 'Open Quayly',
    link: link('/'),
    outro: 'You can change plan or users any time under Settings → Subscription.',
  }),
};

export const sendWelcome = (t) => notifyOnce(t, 'welcome', '', TEMPLATES.welcome);

/** Called when Razorpay reports a change. */
export async function onSubscriptionEvent(tenantId, event) {
  const t = await getTenant(tenantId, { fresh: true });
  if (!t) return;
  const period = t.current_period_end ? new Date(t.current_period_end).toISOString().slice(0, 10) : '';
  if (['subscription.activated', 'subscription.charged'].includes(event) && t.status === 'active') return notifyOnce(t, 'subscription_active', period, TEMPLATES.subscription_active);
  if (['payment.failed', 'subscription.pending'].includes(event)) return notifyOnce(t, 'payment_failed', period || new Date().toISOString().slice(0, 7), TEMPLATES.payment_failed);
  if (['subscription.halted'].includes(event)) return notifyOnce(t, 'past_due', period, TEMPLATES.past_due);
}

/** Hourly: trial reminders and overdue notices for every tenant. */
export async function lifecycleSweep() {
  const tenants = await listTenants();
  let sent = 0;
  const now = Date.now();
  for (const t of tenants) {
    if (t.status === 'trialing' && t.trial_ends_at) {
      const left = new Date(t.trial_ends_at).getTime() - now;
      const occasion = new Date(t.trial_ends_at).toISOString().slice(0, 10); // a trial extension gets fresh reminders
      if (left > 0 && left <= 3 * 864e5) sent += (await notifyOnce(t, 'trial_ending', occasion, TEMPLATES.trial_ending)) ? 1 : 0;
      if (left <= 0) sent += (await notifyOnce(t, 'trial_ended', occasion, TEMPLATES.trial_ended)) ? 1 : 0;
    }
    if (t.status === 'active' && accessState(t).state === 'past_due') {
      sent += (await notifyOnce(t, 'past_due', new Date(t.current_period_end).toISOString().slice(0, 10), TEMPLATES.past_due)) ? 1 : 0;
    }
  }
  return sent;
}
