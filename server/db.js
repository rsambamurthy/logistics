// Database access with per-tenant isolation.
// Each tenant has its own Postgres schema; the platform (tenants, plans, accounts) lives in "public".
// Every query runs with search_path set to the current tenant's schema only, so tenant data can never mix.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const connectionString = process.env.DATABASE_URL;
if (!connectionString) console.error('DATABASE_URL is not set');

export const pool = new pg.Pool({
  connectionString,
  ssl: /localhost|127\.0\.0\.1|railway\.internal/.test(connectionString || '') ? false : process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  max: 15,
});

pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// DATE -> 'YYYY-MM-DD' string (avoid timezone shifts)
pg.types.setTypeParser(1082, (v) => v);

// ---------------- tenant context ----------------
const store = new AsyncLocalStorage();
const SCHEMA_RE = /^t_[a-z0-9_]{1,50}$/;

/** Run fn with every query scoped to this tenant ({ id, schema, ... }). */
export function runAsTenant(tenant, fn) {
  if (!tenant || !SCHEMA_RE.test(tenant.schema)) throw new Error('Invalid tenant');
  return store.run(tenant, fn);
}
export const currentTenant = () => store.getStore() || null;

/** Point a pooled connection at a schema; skipped when the connection is already there (saves a round trip). */
async function useSchema(client, schema) {
  if (client.qSchema === schema) return;
  client.qSchema = undefined; // unknown until the SET succeeds
  await client.query(`SET search_path TO "${schema}"`);
  client.qSchema = schema;
}

async function scoped(fn) {
  const t = currentTenant();
  if (!t) throw new Error('No tenant context for a tenant query');
  const client = await pool.connect();
  try {
    await useSchema(client, t.schema);
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Tenant-scoped query helpers. */
export async function q(text, params = []) {
  return scoped(async (c) => (await c.query(text, params)).rows);
}
export async function one(text, params = []) {
  return (await q(text, params))[0] || null;
}
export async function tx(fn) {
  return scoped(async (client) => {
    await client.query('BEGIN');
    try {
      const out = await fn({
        q: async (t, p = []) => (await client.query(t, p)).rows,
        one: async (t, p = []) => (await client.query(t, p)).rows[0] || null,
      });
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  });
}

/** Platform queries (public schema): tenants, plans, accounts. */
export async function pq(text, params = []) {
  const client = await pool.connect();
  try {
    await useSchema(client, 'public');
    return (await client.query(text, params)).rows;
  } finally {
    client.release();
  }
}
export async function pone(text, params = []) {
  return (await pq(text, params))[0] || null;
}

// ---------------- migrations ----------------
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const TENANT_TABLES = ['users', 'settings', 'mailboxes', 'customers', 'agents', 'rfqs', 'rfq_invites', 'emails', 'attachments', 'agent_quotes', 'quote_lines', 'customer_quotes', 'rate_cards', 'rate_card_lines'];

export async function migrateTenant(schema) {
  if (!SCHEMA_RE.test(schema)) throw new Error('Invalid schema');
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await useSchema(client, schema);
    await client.query(read('schema.sql'));
    await client.query(read('migrations.sql'));
  } finally {
    client.release();
  }
}

/** Platform tables, then move any pre-tenancy data in "public" into the first tenant, then migrate all tenants. */
export async function migrate() {
  await pq(read('platform.sql'));
  const legacy = await pone("SELECT to_regclass('public.users') AS u");
  const tenantCount = (await pone('SELECT count(*)::int AS n FROM tenants')).n;
  if (legacy?.u && tenantCount === 0) {
    const company = await pone("SELECT value->>'name' AS name FROM public.settings WHERE key='company'").catch(() => null);
    const t = await pone(
      "INSERT INTO tenants(slug,name,schema,status,plan_code,trial_ends_at) VALUES('default',$1,'t_default','active','growth',now()+interval '30 days') RETURNING *",
      [company?.name && company.name !== 'Your Company Pvt Ltd' ? company.name : 'First company']
    );
    await pq('CREATE SCHEMA IF NOT EXISTS t_default');
    for (const tbl of TENANT_TABLES) {
      const exists = await pone(`SELECT to_regclass('public.${tbl}') AS r`);
      if (exists.r) await pq(`ALTER TABLE public.${tbl} SET SCHEMA t_default`);
    }
    await pq('INSERT INTO accounts(email,tenant_id,user_id) SELECT lower(email),$1,id FROM t_default.users ON CONFLICT DO NOTHING', [t.id]);
    console.log('Moved existing data into tenant t_default');
  }
  const tenants = await pq('SELECT schema FROM tenants');
  for (const t of tenants) await migrateTenant(t.schema);
}
