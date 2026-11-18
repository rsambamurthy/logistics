import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
}

export const pool = new pg.Pool({
  connectionString,
  ssl: /localhost|127\.0\.0\.1|railway\.internal/.test(connectionString || '') ? false : (process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }),
  max: 10,
});

// numeric -> JS number
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export async function q(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}

export async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn({
      q: async (t, p = []) => (await client.query(t, p)).rows,
      one: async (t, p = []) => (await client.query(t, p)).rows[0] || null,
    });
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function migrate() {
  for (const f of ['schema.sql', 'migrations.sql']) {
    await pool.query(fs.readFileSync(path.join(__dirname, f), 'utf8'));
  }
}
