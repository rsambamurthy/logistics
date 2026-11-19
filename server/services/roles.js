// Roles: built-in (Admin, Manager, User) and the company's own. A user's permissions come from their role.
import { q, one, currentTenant } from '../db.js';
import { SYSTEM_ROLES, PERMISSION_CODES, normalisePermissions } from '../engines/permissions.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const cache = new Map(); // tenant id -> { at, roles }
const TTL = 30_000;

async function ensureSystemRoles() {
  for (const r of SYSTEM_ROLES) {
    await q('INSERT INTO roles(key,name,description,permissions,system) VALUES($1,$2,$3,$4,true) ON CONFLICT (key) DO NOTHING', [r.key, r.name, r.description, r.permissions]);
  }
  await q("UPDATE roles SET name='Administrator', description='Full access to the workspace' WHERE key='admin' AND name='Admin'");
}

/** All roles of the current company, with user counts. Admin always has every permission. */
export async function listRoles() {
  await ensureSystemRoles();
  const rows = await q(`SELECT r.*, (SELECT count(*)::int FROM user_roles ur JOIN users u ON u.id=ur.user_id WHERE ur.role_key=r.key AND u.disabled_at IS NULL) AS users
                        FROM roles r ORDER BY r.system DESC, CASE r.key WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 WHEN 'user' THEN 2 ELSE 3 END, r.name`);
  return rows.map((r) => (r.key === 'admin' ? { ...r, permissions: PERMISSION_CODES, locked: true } : { ...r, permissions: normalisePermissions(r.permissions), locked: false }));
}

/** Permissions from all of a user's roles together (cached briefly; cleared when roles change). */
export async function permissionsFor(roleKeys) {
  const keys = Array.isArray(roleKeys) ? roleKeys : [roleKeys];
  if (keys.includes('admin')) return PERMISSION_CODES;
  const t = currentTenant();
  let c = cache.get(t.id);
  if (!c || Date.now() - c.at > TTL) {
    c = { at: Date.now(), roles: Object.fromEntries((await listRoles()).map((r) => [r.key, r.permissions])) };
    cache.set(t.id, c);
  }
  const all = new Set(keys.flatMap((k) => c.roles[k] || []));
  return PERMISSION_CODES.filter((p) => all.has(p));
}

/** Role keys a user holds. */
export const rolesOf = async (userId) => (await q('SELECT role_key FROM user_roles WHERE user_id=$1 ORDER BY role_key', [userId])).map((r) => r.role_key);

/** Replace a user's roles (at least one). */
export async function setUserRoles(userId, keys) {
  const list = [...new Set((keys || []).filter(Boolean))];
  if (!list.length) throw err('Give the user at least one role');
  for (const k of list) if (!(await roleExists(k))) throw err(`Unknown role ${k}`);
  await q('DELETE FROM user_roles WHERE user_id=$1 AND role_key <> ALL($2)', [userId, list]);
  for (const k of list) await q('INSERT INTO user_roles(user_id, role_key) VALUES($1,$2) ON CONFLICT DO NOTHING', [userId, k]);
  await q('UPDATE users SET role=$1 WHERE id=$2', [list.includes('admin') ? 'admin' : list[0], userId]); // main role, kept for older reports
  return list;
}
const clear = () => cache.delete(currentTenant().id);

export async function roleExists(key) {
  await ensureSystemRoles();
  return !!(await one('SELECT 1 FROM roles WHERE key=$1', [key]));
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);

export async function saveRole(key, { name, description, permissions }) {
  await ensureSystemRoles();
  if (key === 'admin') throw err('The Admin role always has every permission and cannot be changed.');
  const n = String(name || '').trim();
  if (!n) throw err('Give the role a name');
  const perms = normalisePermissions(permissions);
  if (key) {
    const r = await one('UPDATE roles SET name=$1, description=$2, permissions=$3 WHERE key=$4 RETURNING key', [n.slice(0, 60), description || null, perms, key]);
    if (!r) throw err('Role not found', 404);
  } else {
    let k = slug(n) || 'role';
    for (let i = 2; await one('SELECT 1 FROM roles WHERE key=$1', [k]); i++) k = `${slug(n)}_${i}`;
    await q('INSERT INTO roles(key,name,description,permissions,system) VALUES($1,$2,$3,$4,false)', [k, n.slice(0, 60), description || null, perms]);
  }
  clear();
  return listRoles();
}

export async function deleteRole(key) {
  const r = await one('SELECT * FROM roles WHERE key=$1', [key]);
  if (!r) throw err('Role not found', 404);
  if (r.system) throw err('Built-in roles cannot be deleted. You can change their permissions instead.');
  const n = await one('SELECT count(*)::int AS n FROM user_roles WHERE role_key=$1', [key]);
  if (n.n) throw err(`${n.n} user(s) still have this role. Give them another role first.`);
  const levels = (await one("SELECT value FROM settings WHERE key='pricing'"))?.value?.approval_levels || [];
  if (levels.some((l) => l.role === key)) throw err('An approval level is assigned to this role. Change it in Settings → Pricing first.');
  await q('DELETE FROM roles WHERE key=$1', [key]);
  clear();
  return listRoles();
}
