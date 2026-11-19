// Tenants (companies using Quayly): sign-up, lookup, access state and plan limits.
import bcrypt from 'bcryptjs';
import { pq, pone, migrateTenant, runAsTenant, one, q } from '../db.js';
import { setSetting } from './settings.js';
import { sendVerification } from './accountTokens.js';

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);
const GRACE_DAYS = 3;

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

function slugify(s) {
  return String(s || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'company';
}

const TENANT_SELECT = `SELECT t.*, p.name AS plan_name, p.price_inr, p.price_hkd, p.max_users, p.max_rfqs_month, p.ai_enabled, p.razorpay_plan_id
  FROM tenants t LEFT JOIN plans p ON p.code=t.plan_code`;

const cache = new Map();
export async function getTenant(id, { fresh } = {}) {
  const c = cache.get(id);
  if (!fresh && c && c.at > Date.now() - 30000) return c.t;
  const t = await pone(`${TENANT_SELECT} WHERE t.id=$1`, [id]);
  cache.set(id, { t, at: Date.now() });
  return t;
}
export const clearTenantCache = (id) => (id ? cache.delete(id) : cache.clear());

export async function listTenants() {
  return pq(`${TENANT_SELECT} ORDER BY t.id`);
}

/** What a tenant may do right now. */
export function accessState(t) {
  const now = Date.now();
  if (!t) return { ok: false, state: 'missing', message: 'Account not found' };
  if (t.status === 'suspended') return { ok: false, state: 'suspended', message: 'This account is suspended. Contact Integrata support.' };
  if (t.status === 'cancelled') return { ok: false, state: 'cancelled', message: 'The subscription was cancelled. Choose a plan to continue.' };
  if (t.status === 'active') {
    const end = t.current_period_end ? new Date(t.current_period_end).getTime() : null;
    if (end && end + GRACE_DAYS * 864e5 < now) return { ok: false, state: 'past_due', message: 'Payment is overdue. Update your subscription to continue.' };
    return { ok: true, state: 'active' };
  }
  if (t.status === 'past_due') return { ok: false, state: 'past_due', message: 'Payment failed. Update your subscription to continue.' };
  // trialing
  const end = t.trial_ends_at ? new Date(t.trial_ends_at).getTime() : 0;
  const days = Math.ceil((end - now) / 864e5);
  if (end > now) return { ok: true, state: 'trialing', trial_days_left: days };
  return { ok: false, state: 'trial_ended', message: 'Your free trial has ended. Choose a plan to continue.' };
}

export async function signUp({ company, name, email, password, country }) {
  const mail = String(email || '').toLowerCase().trim();
  if (!company || !mail || !password || password.length < 8) throw err('Company, email and a password of at least 8 characters are required');
  if (await pone('SELECT 1 FROM accounts WHERE email=$1', [mail])) throw err('This email already has an account. Sign in instead.');
  let slug = slugify(company);
  for (let i = 2; await pone('SELECT 1 FROM tenants WHERE slug=$1', [slug]); i++) slug = `${slugify(company).slice(0, 27)}_${i}`;
  const tenant = await pone(
    `INSERT INTO tenants(slug,name,schema,country,billing_email,status,plan_code,trial_ends_at) VALUES($1,$2,$3,$4,$5,'trialing','growth',now()+($6 || ' days')::interval) RETURNING *`,
    [slug, company, `t_${slug}`, country || 'IN', mail, String(TRIAL_DAYS)]
  );
  await migrateTenant(tenant.schema);
  const full = await getTenant(tenant.id, { fresh: true });
  const user = await runAsTenant(full, async () => {
    const hash = await bcrypt.hash(password, 10);
    const u = await one("INSERT INTO users(email,name,password_hash,role) VALUES($1,$2,$3,'admin') RETURNING id,email,name,role", [mail, name || mail, hash]);
    await q("INSERT INTO user_roles(user_id, role_key) VALUES($1,'admin') ON CONFLICT DO NOTHING", [u.id]);
    await setSetting('company', { name: company, country: country || 'IN', email: mail });
    if (country === 'HK') {
      await setSetting('fx', { base: 'HKD', rates: { USD: 7.8, INR: 0.093, EUR: 8.4, CNY: 1.08, SGD: 5.8, AED: 2.12, GBP: 9.9 } });
      await setSetting('pricing', { default_tax_pct: 0 });
    }
    return u;
  });
  await pq('INSERT INTO accounts(email,tenant_id,user_id) VALUES($1,$2,$3)', [mail, tenant.id, user.id]);
  await sendVerification({ email: mail, tenantId: tenant.id, userId: user.id, name }).catch((e) => console.error('verification mail', e.message));
  return { tenant: full, user };
}

export async function tenantForEmail(email) {
  const a = await pone('SELECT * FROM accounts WHERE email=lower($1)', [email || '']);
  return a ? { account: a, tenant: await getTenant(a.tenant_id, { fresh: true }) } : null;
}

/** Usage against plan limits for the current tenant. */
export async function usage(t) {
  const users = (await one('SELECT count(*)::int AS n FROM users WHERE disabled_at IS NULL')).n;
  const rfqs = (await one("SELECT count(*)::int AS n FROM rfqs WHERE created_at >= date_trunc('month', now())")).n;
  return { users, rfqs_this_month: rfqs, max_users: t.max_users, max_rfqs_month: t.max_rfqs_month };
}

export async function assertCanAddUser(t) {
  const u = await usage(t);
  if (t.max_users && u.users >= t.max_users) throw err(`Your ${t.plan_name} plan allows ${t.max_users} users. Upgrade in Settings → Subscription.`, 402);
}

export async function assertCanCreateRfq(t) {
  if (!t) return;
  const u = await usage(t);
  if (t.max_rfqs_month && u.rfqs_this_month >= t.max_rfqs_month) throw err(`Your ${t.plan_name} plan allows ${t.max_rfqs_month} RFQs a month. Upgrade in Settings → Subscription.`, 402);
}

export async function updateTenant(id, patch) {
  const fields = ['name', 'status', 'plan_code', 'seats', 'trial_ends_at', 'current_period_end', 'notes', 'billing_email', 'country', 'razorpay_subscription_id'];
  const cols = fields.filter((f) => f in patch);
  if (!cols.length) return getTenant(id, { fresh: true });
  await pq(`UPDATE tenants SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(',')} WHERE id=$${cols.length + 1}`, [...cols.map((c) => (patch[c] === '' ? null : patch[c])), id]);
  clearTenantCache(id);
  return getTenant(id, { fresh: true });
}

/** Run fn for every tenant that may run background work. */
export async function forEachTenant(fn) {
  const tenants = await listTenants();
  for (const t of tenants) {
    if (!accessState(t).ok) continue;
    try {
      await runAsTenant(t, fn);
    } catch (e) {
      console.error(`tenant ${t.slug}:`, e.message);
    }
  }
}

export async function tenantStats() {
  const tenants = await listTenants();
  const out = [];
  for (const t of tenants) {
    const u = await runAsTenant(t, () => usage(t)).catch(() => ({}));
    const last = await runAsTenant(t, () => one('SELECT max(created_at) AS at FROM rfqs')).catch(() => null);
    out.push({ ...t, ...u, last_rfq_at: last?.at || null, access: accessState(t) });
  }
  return out;
}

export { q };
