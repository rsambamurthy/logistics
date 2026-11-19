// Creates test companies with realistic volumes in a TEST database. Refuses to run against production.
import { runAsTenant, q, one, pq } from '../server/db.js';
import { signUp, getTenant } from '../server/services/tenants.js';
import fs from 'node:fs';
import crypto from 'node:crypto';

if (process.env.RAILWAY_ENVIRONMENT_NAME === 'production' || process.env.SIDE_EFFECTS === 'on') throw new Error('seed.mjs only runs on a test copy');

const TENANTS = Number(process.env.SEED_TENANTS || 10);
const RFQS = Number(process.env.SEED_RFQS || 300);
const JOBS = Number(process.env.SEED_JOBS || 60);
const quote = JSON.parse(fs.readFileSync(new URL('./quote-fixture.json', import.meta.url), 'utf8'));
const ports = [['Chennai', 'Hong Kong'], ['Nhava Sheva', 'Jebel Ali'], ['Mundra', 'Rotterdam'], ['Hong Kong', 'Los Angeles'], ['Chennai', 'Singapore'], ['Kolkata', 'Shanghai']];

export async function seed() {
  const out = [];
  for (let t = 1; t <= TENANTS; t++) {
    const email = `load${t}@loadtest.quayly`;
    const exists = await pq('SELECT tenant_id FROM accounts WHERE email=$1', [email]);
    let tenant;
    if (exists.length) tenant = await getTenant(exists[0].tenant_id, { fresh: true });
    else tenant = (await signUp({ company: `Load Test ${t}`, name: `Loader ${t}`, email, password: 'loadtest-pass-1', country: t % 2 ? 'IN' : 'HK' })).tenant;
    const ids = await runAsTenant(tenant, async () => {
      await q('UPDATE users SET email_verified_at=coalesce(email_verified_at, now())');
      if (!(await one('SELECT 1 FROM jobs LIMIT 1'))) {
        await q('TRUNCATE rfqs, agents RESTART IDENTITY CASCADE');
        await q(`INSERT INTO agents(company, contact, email, services, active, is_agent)
                 SELECT 'Agent '||g, 'Contact '||g, 'agent'||g||'@agents.loadtest', ARRAY['freight','origin_charges'], true, true FROM generate_series(1,20) g`);
        await q(`INSERT INTO rfqs(ref, mode, pol, pod, legs, status, commodity, created_at)
                 SELECT 'RFQ-2026-'||lpad(g::text,4,'0'), (ARRAY['FCL','LCL','AIR'])[1 + g % 3], ($1::text[])[1 + g % 6], ($2::text[])[1 + g % 6],
                        ARRAY['freight','origin_charges','export_customs'], (ARRAY['sent','quoted','closed','draft'])[1 + g % 4], 'General cargo '||g, now() - (g || ' hours')::interval
                 FROM generate_series(1,$3) g`, [ports.map((p) => p[0]), ports.map((p) => p[1]), RFQS]);
        await q(`INSERT INTO rfq_invites(rfq_id, agent_id, tag, legs, status)
                 SELECT r.id, 1 + ((r.id * 7 + k) % 20), upper(substr(md5(r.id::text||k::text),1,4)), ARRAY['freight'], (ARRAY['pending','replied','replied'])[1 + (r.id + k) % 3]
                 FROM rfqs r, generate_series(1,3) k`);
        await q(`INSERT INTO emails(direction, kind, rfq_id, from_addr, to_addr, subject, body_text, at)
                 SELECT 'in', 'quote_reply', r.id, 'agent@agents.loadtest', 'rfq@loadtest', 'Re: '||r.ref, repeat('Rate details line. ', 40), now() - (r.id || ' minutes')::interval
                 FROM rfqs r`);
        await q(`INSERT INTO customer_quotes(rfq_id, ref, currency, margin_pct, tax_pct, language, snapshot, status, selection)
                 SELECT r.id, 'QT-'||r.ref, $1, 10, 0, 'en', $2::jsonb, 'sent', $4::jsonb FROM rfqs r WHERE r.id <= $3`, [quote.currency, JSON.stringify(quote.snapshot), JOBS, JSON.stringify(quote.selection)]);
        await q(`INSERT INTO jobs(ref, rfq_id, customer_quote_id, status, sell_currency, track_token)
                 SELECT 'JOB-2026-'||lpad(c.id::text,4,'0'), c.rfq_id, c.id, (ARRAY['booked','departed','booking_requested','arrived'])[1 + c.id % 4], c.currency, $1||'.'||md5(random()::text)
                 FROM customer_quotes c`, [String(tenant.id)]);
        await q(`INSERT INTO bookings(job_id, agent_id, tag, legs, status, booking_no, vessel, voyage, etd, eta, cutoffs)
                 SELECT j.id, 1 + j.id % 20, upper(substr(md5(j.id::text),1,4)), ARRAY['freight'], 'confirmed', 'BKG'||j.id, 'LOAD VESSEL', '0'||j.id||'E',
                        current_date + (j.id % 10), current_date + 10 + (j.id % 10), jsonb_build_object('si', to_char(now() + ((j.id % 5) || ' days')::interval, 'YYYY-MM-DD"T"HH24:MI'))
                 FROM jobs j`);
        await q(`INSERT INTO job_costs(job_id, kind, leg, description, amount, currency, source)
                 SELECT j.id, k, 'freight', 'Ocean freight', CASE WHEN k='buy' THEN 900 ELSE 1100 END, 'USD', 'quote' FROM jobs j, unnest(ARRAY['buy','sell']) k`);
      }
      return {
        rfqs: (await q('SELECT id FROM rfqs ORDER BY id LIMIT 200')).map((r) => r.id),
        jobs: (await q('SELECT id, track_token FROM jobs ORDER BY id')).map((r) => ({ id: r.id, token: r.track_token })),
        quotes: (await q('SELECT id FROM customer_quotes ORDER BY id LIMIT 20')).map((r) => r.id),
      };
    });
    out.push({ tenant: tenant.id, email, password: 'loadtest-pass-1', ...ids });
    console.log(`seeded tenant ${t}: ${ids.rfqs.length} rfqs, ${ids.jobs.length} jobs`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) seed().then((x) => { fs.writeFileSync('/tmp/seed.json', JSON.stringify(x)); process.exit(0); });
