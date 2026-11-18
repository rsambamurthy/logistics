import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { one, q } from './db.js';

const SECRET = () => process.env.APP_SECRET || 'dev-only-secret-change-me';
const COOKIE = 'aq_session';

export async function needsSetup() {
  const r = await one('SELECT count(*)::int AS n FROM users');
  return r.n === 0;
}

export async function createUser({ email, name, password, role = 'user' }) {
  if (!email || !password || password.length < 8) throw Object.assign(new Error('Email and a password of at least 8 characters are required'), { status: 400 });
  const hash = await bcrypt.hash(password, 10);
  return one('INSERT INTO users(email,name,password_hash,role) VALUES(lower($1),$2,$3,$4) RETURNING id,email,name,role', [email, name || email, hash, role]);
}

export async function login(res, email, password) {
  const u = await one('SELECT * FROM users WHERE email=lower($1)', [email || '']);
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) throw Object.assign(new Error('Invalid email or password'), { status: 401 });
  issue(res, u);
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

export function issue(res, u) {
  const token = jwt.sign({ id: u.id, role: u.role }, SECRET(), { expiresIn: '7d' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 864e5 });
}

export function logout(res) {
  res.clearCookie(COOKIE);
}

export async function requireAuth(req, res, next) {
  try {
    const t = req.cookies?.[COOKIE];
    if (!t) return res.status(401).json({ error: 'Not signed in' });
    const p = jwt.verify(t, SECRET());
    const u = await one('SELECT id,email,name,role FROM users WHERE id=$1', [p.id]);
    if (!u) return res.status(401).json({ error: 'Not signed in' });
    req.user = u;
    next();
  } catch {
    res.status(401).json({ error: 'Not signed in' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

export async function listUsers() {
  return q('SELECT id,email,name,role,created_at FROM users ORDER BY id');
}
