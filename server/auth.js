// Sign-in, sessions and tenant routing. Every authenticated request runs inside its tenant's context.
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { one, q, pq, runAsTenant, currentTenant } from './db.js';
import crypto from 'node:crypto';
import { getTenant, tenantForEmail, accessState, assertCanAddUser } from './services/tenants.js';
import { sendInvite } from './services/accountTokens.js';
import { permissionsFor, roleExists } from './services/roles.js';

const SECRET = () => process.env.APP_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-only-secret-change-me');
const COOKIE = 'aq_session';
const err = (msg, status) => Object.assign(new Error(msg), { status });

export const isPlatformAdmin = (email) =>
  String(process.env.PLATFORM_ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).includes(String(email || '').toLowerCase());

export function issue(res, user, tenantId) {
  const token = jwt.sign({ id: user.id, tid: tenantId, ep: user.session_epoch || 0 }, SECRET(), { expiresIn: '7d' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 864e5 });
}

/** Sign out: the session token stops working everywhere it was copied (the user's other devices sign in again). */
export async function logout(req, res) {
  const p = decode(req);
  if (p?.tid) {
    const tenant = await getTenant(p.tid).catch(() => null);
    if (tenant) await runAsTenant(tenant, () => q('UPDATE users SET session_epoch=session_epoch+1 WHERE id=$1', [p.id])).catch(() => null);
  }
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
}

export async function login(res, email, password) {
  const found = await tenantForEmail(email);
  if (!found?.tenant) throw err('Invalid email or password', 401);
  const { tenant } = found;
  if (tenant.status === 'suspended') throw err('This account is suspended. Contact Integrata support.', 403);
  const u = await runAsTenant(tenant, () => one('SELECT * FROM users WHERE email=lower($1)', [email]));
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) throw err('Invalid email or password', 401);
  // checked only after the password, so this message never reveals that an account exists
  if (u.disabled_at) throw err('Your access has been switched off. Ask your company admin.', 403);
  if (!u.email_verified_at) throw Object.assign(err('Please confirm your email first. Use the link we emailed you.', 403), { code: 'unverified' });
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
      const u = await one('SELECT id,email,name,role,session_epoch,disabled_at FROM users WHERE id=$1', [p.id]);
      if (!u || u.disabled_at || (u.session_epoch || 0) !== (p.ep || 0)) return res.status(401).json({ error: 'Not signed in' });
      delete u.session_epoch;
      delete u.disabled_at;
      req.user = { ...u, platform_admin: isPlatformAdmin(u.email), perms: await permissionsFor(u.role) };
      req.tenant = tenant;
      req.access = accessState(tenant);
      next();
    } catch (e) {
      next(e);
    }
  });
}

/** Kept for routers outside the permission map; same as the users.manage permission. */
export function requireAdmin(req, res, next) {
  if (!req.user?.perms?.includes('users.manage')) return res.status(403).json({ error: 'Admin only' });
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

/** Add a user to the current tenant. They get an invite email to set their own password. */
export async function createUser({ email, name, role = 'user' }) {
  const t = currentTenant();
  const mail = String(email || '').toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw err('Enter a valid email address', 400);
  if ((await pq('SELECT 1 FROM accounts WHERE email=$1', [mail])).length) throw err('This email is already used by another account', 400);
  if (!(await roleExists(role))) throw err('Unknown role', 400);
  await assertCanAddUser(t);
  const placeholder = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10); // unusable until they set a password
  const u = await one('INSERT INTO users(email,name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,email,name,role', [mail, name || mail, placeholder, role]);
  await pq('INSERT INTO accounts(email,tenant_id,user_id) VALUES($1,$2,$3)', [mail, t.id, u.id]);
  const invite = await sendInvite({ email: mail, tenantId: t.id, userId: u.id, name, company: t.name }).catch((e) => ({ error: e.message }));
  return { ...u, invite_sent: !invite?.error && !invite?.skipped, invite_error: invite?.error || null };
}

export async function resendInvite(userId) {
  const t = currentTenant();
  const u = await one('SELECT id,email,name,email_verified_at FROM users WHERE id=$1', [userId]);
  if (!u) throw err('User not found', 404);
  if (u.email_verified_at) throw err('This user has already set a password', 400);
  await sendInvite({ email: u.email, tenantId: t.id, userId: u.id, name: u.name, company: t.name });
  return true;
}

export async function listUsers() {
  return q('SELECT id,email,name,role,created_at,email_verified_at,disabled_at,disabled_by FROM users ORDER BY disabled_at IS NOT NULL, id');
}

const activeAdmins = async () => (await one("SELECT count(*)::int AS n FROM users WHERE role='admin' AND disabled_at IS NULL")).n;

/**
 * Edit a user: name, role, and (only while the invite is not yet accepted) the email address.
 * An admin cannot demote themselves or leave the company without an active admin.
 */
export async function updateUser(userId, { name, role, email }, actor) {
  const t = currentTenant();
  const u = await one('SELECT * FROM users WHERE id=$1', [userId]);
  if (!u) throw err('User not found', 404);
  const patch = {};
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n) throw err('Enter a name', 400);
    patch.name = n.slice(0, 120);
  }
  if (role !== undefined && role !== u.role) {
    if (!(await roleExists(role))) throw err('Unknown role', 400);
    if (u.id === actor.id) throw err("You can't change your own role. Ask another admin.", 400);
    if (u.role === 'admin' && !u.disabled_at && (await activeAdmins()) <= 1) throw err('Keep at least one active admin. Make someone else an admin first.', 400);
    patch.role = role;
  }
  let newEmail = null;
  if (email !== undefined && String(email).toLowerCase().trim() !== u.email) {
    if (u.email_verified_at) throw err('The email of a user who has already signed in cannot be changed. Add them again with the new email and switch off the old user.', 400);
    newEmail = String(email).toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) throw err('Enter a valid email address', 400);
    if ((await pq('SELECT 1 FROM accounts WHERE email=$1', [newEmail])).length) throw err('This email is already used by another account', 400);
    patch.email = newEmail;
  }
  const keys = Object.keys(patch);
  if (!keys.length) return listUsers();
  // a role change takes effect on their next click: the role is read from the database on every request
  await q(`UPDATE users SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE id=$${keys.length + 1}`, [...keys.map((k) => patch[k]), userId]);
  if (newEmail) {
    await pq('UPDATE accounts SET email=$1 WHERE tenant_id=$2 AND user_id=$3', [newEmail, t.id, userId]);
    await sendInvite({ email: newEmail, tenantId: t.id, userId, name: patch.name || u.name, company: t.name }).catch((e) => console.error('invite', e.message));
  }
  return listUsers();
}

/** Switch a user off: signed out everywhere at once, cannot sign in or reset a password; their work stays. */
export async function setUserDisabled(userId, disabled, actor) {
  const t = currentTenant();
  const u = await one('SELECT * FROM users WHERE id=$1', [userId]);
  if (!u) throw err('User not found', 404);
  if (disabled) {
    if (u.id === actor.id) throw err("You can't switch yourself off.", 400);
    if (u.disabled_at) return listUsers();
    if (u.role === 'admin' && (await activeAdmins()) <= 1) throw err('Keep at least one active admin.', 400);
    await q('UPDATE users SET disabled_at=now(), disabled_by=$1, session_epoch=session_epoch+1 WHERE id=$2', [actor.name || actor.email, userId]);
  } else {
    if (!u.disabled_at) return listUsers();
    await assertCanAddUser(t); // a switched-on user takes a seat again
    await q('UPDATE users SET disabled_at=NULL, disabled_by=NULL WHERE id=$1', [userId]);
  }
  return listUsers();
}

export { decode };
