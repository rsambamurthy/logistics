// One-time account links: password reset, email verification, user invites.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pq, pone, runAsTenant, one, q } from '../db.js';
import { getTenant } from './tenants.js';
import { layout, sendSystemMail, appUrl } from './systemMail.js';
import { sendWelcome } from './lifecycle.js';

const TTL_HOURS = { reset: 1, verify: 48, invite: 72 };
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function issueToken(purpose, { email, tenantId, userId }) {
  const token = crypto.randomBytes(32).toString('hex');
  // older unused links of the same kind stop working
  await pq('UPDATE auth_tokens SET used_at=now() WHERE email=$1 AND purpose=$2 AND used_at IS NULL', [email, purpose]);
  await pq(`INSERT INTO auth_tokens(token_hash,purpose,email,tenant_id,user_id,expires_at) VALUES($1,$2,$3,$4,$5, now() + ($6 || ' hours')::interval)`, [hash(token), purpose, email, tenantId, userId, String(TTL_HOURS[purpose])]);
  return token;
}

/** Validate a link without using it up (to show the right screen). */
export async function peekToken(token, purpose) {
  const t = await pone('SELECT * FROM auth_tokens WHERE token_hash=$1 AND purpose=$2', [hash(String(token || '')), purpose]);
  if (!t) return { ok: false, reason: 'This link is not valid.' };
  if (t.used_at) return { ok: false, reason: 'This link has already been used.' };
  if (new Date(t.expires_at) < new Date()) return { ok: false, reason: 'This link has expired. Request a new one.' };
  return { ok: true, token: t };
}

async function consume(token, purposes) {
  for (const p of purposes) {
    const r = await peekToken(token, p);
    if (r.ok) {
      await pq('UPDATE auth_tokens SET used_at=now() WHERE id=$1', [r.token.id]);
      return r.token;
    }
  }
  const r = await peekToken(token, purposes[0]);
  throw err(r.reason);
}

// ---------- emails ----------
export async function sendVerification({ email, tenantId, userId, name }) {
  const token = await issueToken('verify', { email, tenantId, userId });
  const link = `${appUrl()}/verify?token=${token}`;
  const m = layout({
    title: 'Confirm your email',
    intro: `Hi ${name || ''}, welcome to Quayly. Please confirm your email address to activate your account.`,
    button: 'Confirm email',
    link,
    outro: 'This link is valid for 48 hours. If you did not sign up for Quayly, you can ignore this email.',
  });
  return sendSystemMail({ to: email, subject: 'Confirm your email for Quayly', ...m });
}

export async function sendInvite({ email, tenantId, userId, name, company }) {
  const token = await issueToken('invite', { email, tenantId, userId });
  const link = `${appUrl()}/reset?token=${token}&invite=1`;
  const m = layout({
    title: `You've been added to ${company} on Quayly`,
    intro: `Hi ${name || ''}, an account has been created for you. Set your password to sign in.`,
    button: 'Set my password',
    link,
    outro: 'This link is valid for 72 hours. Ask your admin to resend it if it expires.',
  });
  return sendSystemMail({ to: email, subject: `Your Quayly account at ${company}`, ...m });
}

/** Forgot password: always answers the same way, so it does not reveal which emails have accounts. */
export async function requestPasswordReset(email) {
  const mail = String(email || '').toLowerCase().trim();
  const acct = mail && (await pone('SELECT * FROM accounts WHERE email=$1', [mail]));
  if (!acct) return;
  const tenant = await getTenant(acct.tenant_id, { fresh: true });
  if (!tenant || tenant.status === 'suspended') return;
  const user = await runAsTenant(tenant, () => one('SELECT id, name FROM users WHERE id=$1', [acct.user_id]));
  if (!user) return;
  const token = await issueToken('reset', { email: mail, tenantId: tenant.id, userId: user.id });
  const link = `${appUrl()}/reset?token=${token}`;
  const m = layout({
    title: 'Reset your password',
    intro: `Hi ${user.name || ''}, we received a request to reset your Quayly password.`,
    button: 'Choose a new password',
    link,
    outro: 'This link is valid for 1 hour and can be used once. If you did not ask for this, ignore this email; your password stays the same.',
  });
  await sendSystemMail({ to: mail, subject: 'Reset your Quayly password', ...m });
}

/** Set a new password from a reset or invite link. Also confirms the email. */
export async function resetPassword(token, password) {
  if (!password || password.length < 8) throw err('Password must be at least 8 characters');
  const t = await consume(token, ['reset', 'invite']);
  const tenant = await getTenant(t.tenant_id, { fresh: true });
  const hashPw = await bcrypt.hash(password, 10);
  const user = await runAsTenant(tenant, () => one('UPDATE users SET password_hash=$1, email_verified_at=coalesce(email_verified_at, now()) WHERE id=$2 RETURNING id,email,name,role', [hashPw, t.user_id]));
  // any other open reset links for this email stop working
  await pq("UPDATE auth_tokens SET used_at=now() WHERE email=$1 AND purpose IN ('reset','invite') AND used_at IS NULL", [t.email]);
  return { user, tenant };
}

export async function verifyEmail(token) {
  const t = await consume(token, ['verify']);
  const tenant = await getTenant(t.tenant_id, { fresh: true });
  const user = await runAsTenant(tenant, () => one('UPDATE users SET email_verified_at=coalesce(email_verified_at, now()) WHERE id=$1 RETURNING id,email,name,role', [t.user_id]));
  // the company's first confirmed admin gets the welcome email
  if (user.role === 'admin') sendWelcome(tenant).catch((e) => console.error('welcome', e.message));
  return { user, tenant };
}

export async function resendVerification(email) {
  const mail = String(email || '').toLowerCase().trim();
  const acct = mail && (await pone('SELECT * FROM accounts WHERE email=$1', [mail]));
  if (!acct) return;
  const tenant = await getTenant(acct.tenant_id, { fresh: true });
  const user = await runAsTenant(tenant, () => one('SELECT id, name, email_verified_at FROM users WHERE id=$1', [acct.user_id]));
  if (!user || user.email_verified_at) return;
  await sendVerification({ email: mail, tenantId: tenant.id, userId: user.id, name: user.name });
}

export { q };
