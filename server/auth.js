// Sign-in, sessions and tenant routing. Every authenticated request runs inside its tenant's context.
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { one, q, pq, runAsTenant, currentTenant } from './db.js';
import { getTenant, tenantForEmail, accessState, assertCanAddUser } from './services/tenants.js';

const SECRET = () => process.env.APP_SECRET || 'dev-only-secret-change-me';
const COOKIE = 'aq_session';
const err = (msg, status) => Object.assign(new Error(msg), { status });

export const isPlatformAdmin = (email) =>
  String(process.env.PLATFORM_ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).includes(String(email || '').toLowerCase());

export function issue(res, user, tenantId) {
  const token = jwt.sign({ id: user.id, tid: tenantId }, SECRET(), { expiresIn: '7d' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 864e5 });
}

export function logout(res) {
  res.clearCookie(COOKIE);
}

export async function login(res, email, password) {
  const found = await tenantForEmail(email);
  if (!found?.tenant) throw err('Invalid email or password', 401);
  const { tenant } = found;
  if (tenant.status === 'suspended') throw err('This account is suspended. Contact Integrata support.', 403);
  const u = await runAsTenant(tenant, () => one('SELECT * FROM users WHERE email=lower($1)', [email]));
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) throw err('Invalid email or password', 401);
  issue(res, u, tenant.id);
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

function decode(req) {
  const t = req.cookies?.[COOKIE];
  if (!t) return null;
  try {
    return jwt.verify(t, SECRET());
  } catch {
    return null;
  }
}

/** Authenticate, then continue the request inside the tenant's context. */
export async function requireAuth(req, res, next) {
  const p = decode(req);
  if (!p?.tid) return res.status(401).json({ error: 'Not signed in' });
  const tenant = await getTenant(p.tid).catch(() => null);
  if (!tenant || tenant.status === 'suspended') return res.status(401).json({ error: 'Account unavailable' });
  runAsTenant(tenant, async () => {
    try {
      const u = await one('SELECT id,email,name,role FROM users WHERE id=$1', [p.id]);
      if (!u) return res.status(401).json({ error: 'Not signed in' });
      req.user = { ...u, platform_admin: isPlatformAdmin(u.email) };
      req.tenant = tenant;
      req.access = accessState(tenant);
      next();
    } catch (e) {
      next(e);
    }
  });
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

export function requirePlatformAdmin(req, res, next) {
  if (!req.user?.platform_admin) return res.status(403).json({ error: 'Integrata admins only' });
  next();
}

// Requests allowed even when the trial has ended or payment is due (so the tenant can see data and pay).
const ALWAYS_ALLOWED = [/^\/logout$/, /^\/billing\//, /^\/settings\/company$/, /^\/platform\//];
/** Block changes when the subscription is not in good standing; reading stays possible. */
export function requireActiveSubscription(req, res, next) {
  if (req.method === 'GET' || req.access?.ok || req.user?.platform_admin) return next();
  if (ALWAYS_ALLOWED.some((r) => r.test(req.path))) return next();
  res.status(402).json({ error: req.access?.message || 'Subscription required', code: req.access?.state });
}

export async function createUser({ email, name, password, role = 'user' }) {
  const t = currentTenant();
  const mail = String(email || '').toLowerCase().trim();
  if (!mail || !password || password.length < 8) throw err('Email and a password of at least 8 characters are required', 400);
  if ((await pq('SELECT 1 FROM accounts WHERE email=$1', [mail])).length) throw err('This email is already used by another account', 400);
  await assertCanAddUser(t);
  const hash = await bcrypt.hash(password, 10);
  const u = await one('INSERT INTO users(email,name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,email,name,role', [mail, name || mail, hash, role]);
  await pq('INSERT INTO accounts(email,tenant_id,user_id) VALUES($1,$2,$3)', [mail, t.id, u.id]);
  return u;
}

export async function listUsers() {
  return q('SELECT id,email,name,role,created_at FROM users ORDER BY id');
}

export { decode };
