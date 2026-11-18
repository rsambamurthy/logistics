// Integrata platform console: all tenants, plans, manual activation. Platform admins only.
import express from 'express';
import { pq, pone } from '../db.js';
import { requirePlatformAdmin } from '../auth.js';
import { tenantStats, updateTenant } from '../services/tenants.js';

const r = express.Router();
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
r.use(requirePlatformAdmin);

r.get('/tenants', h(async (req, res) => {
  const rows = await tenantStats();
  res.json(rows.map(({ schema, ...t }) => t));
}));

r.put('/tenants/:id', h(async (req, res) => {
  const b = req.body;
  const patch = {};
  for (const k of ['status', 'plan_code', 'seats', 'trial_ends_at', 'current_period_end', 'notes', 'name']) if (k in b) patch[k] = b[k];
  if (b.extend_trial_days) {
    const t = await pone('SELECT trial_ends_at FROM tenants WHERE id=$1', [Number(req.params.id)]);
    const base = Math.max(Date.now(), t?.trial_ends_at ? new Date(t.trial_ends_at).getTime() : 0);
    patch.trial_ends_at = new Date(base + Number(b.extend_trial_days) * 864e5).toISOString();
    if (!patch.status) patch.status = 'trialing';
  }
  if (b.activate_months) {
    // manual (offline) payment: active until N months from now
    patch.status = 'active';
    patch.current_period_end = new Date(Date.now() + Number(b.activate_months) * 30 * 864e5).toISOString();
  }
  const t = await updateTenant(Number(req.params.id), patch);
  await pq('INSERT INTO billing_events(tenant_id,type,payload) VALUES($1,$2,$3)', [t.id, 'admin_update', { by: req.user.email, patch }]);
  res.json({ ok: true });
}));

r.get('/plans', h(async (req, res) => res.json(await pq('SELECT * FROM plans ORDER BY sort, code'))));
r.put('/plans/:code', h(async (req, res) => {
  const b = req.body;
  const cols = ['name', 'price_inr', 'price_hkd', 'max_users', 'max_rfqs_month', 'ai_enabled', 'active', 'sort'].filter((k) => k in b);
  // a price change needs a new Razorpay plan; existing subscribers keep theirs until changed
  const priceChanged = 'price_inr' in b;
  const sets = cols.map((c, i) => `${c}=$${i + 1}`);
  if (priceChanged) sets.push('razorpay_plan_id=NULL');
  await pq(`UPDATE plans SET ${sets.join(',')} WHERE code=$${cols.length + 1}`, [...cols.map((c) => (b[c] === '' ? null : b[c])), req.params.code]);
  res.json(await pone('SELECT * FROM plans WHERE code=$1', [req.params.code]));
}));
r.post('/plans', h(async (req, res) => {
  const b = req.body;
  if (!b.code || !b.name) return res.status(400).json({ error: 'Code and name are required' });
  res.json(await pone('INSERT INTO plans(code,name,price_inr,price_hkd,max_users,max_rfqs_month,sort) VALUES(lower($1),$2,$3,$4,$5,$6,$7) RETURNING *', [b.code, b.name, b.price_inr || 0, b.price_hkd || 0, b.max_users || null, b.max_rfqs_month || null, b.sort || 9]));
}));

r.get('/events', h(async (req, res) => res.json(await pq('SELECT e.*, t.name AS tenant FROM billing_events e LEFT JOIN tenants t ON t.id=e.tenant_id ORDER BY e.id DESC LIMIT 200'))));

export default r;
