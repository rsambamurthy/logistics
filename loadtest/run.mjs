// Load test for a TEST copy of Quayly. Seeds test companies, then runs scenarios and prints a summary.
// Usage (on the test copy): TARGET=https://... node loadtest/run.mjs
import autocannon from 'autocannon';
import { seed } from './seed.mjs';
import { simpleParser } from 'mailparser';

const TARGET = (process.env.TARGET || 'http://127.0.0.1:3000').replace(/\/$/, '');
const DURATION = Number(process.env.DURATION || 30);
const LEVELS = String(process.env.LEVELS || '20,50,100,200').split(',').map(Number);
if (/quayly\.integratatech\.ai/.test(TARGET)) throw new Error('Refusing to load-test the live site');

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const summary = [];

async function login(t) {
  const r = await fetch(`${TARGET}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${t.tenant}.1` }, body: JSON.stringify({ email: t.email, password: t.password }) });
  if (!r.ok) throw new Error(`login ${t.email}: ${r.status} ${await r.text()}`);
  return r.headers.get('set-cookie').split(';')[0];
}

function run(title, { connections, requests, headers = {}, duration = DURATION }) {
  return new Promise((resolve, reject) => {
    autocannon({ url: TARGET, connections, duration, headers, requests, timeout: 30 }, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

/** Spread connections over the test companies, each with its own sign-in. */
async function scenario(name, tenants, connections, build) {
  const per = Math.max(1, Math.round(connections / tenants.length));
  const started = Date.now();
  const results = await Promise.all(tenants.map((t) => run(name, { connections: per, headers: { cookie: t.cookie }, requests: build(t) })));
  const total = results.reduce((a, r) => a + r.requests.total, 0);
  const merged = {
    scenario: name,
    connections: per * tenants.length,
    seconds: Math.round((Date.now() - started) / 1000),
    requests: total,
    req_per_sec: Math.round(results.reduce((a, r) => a + r.requests.average, 0)),
    p50_ms: Math.round(Math.max(...results.map((r) => r.latency.p50))),
    p90_ms: Math.round(Math.max(...results.map((r) => r.latency.p90))),
    p99_ms: Math.round(Math.max(...results.map((r) => r.latency.p99))),
    max_ms: Math.round(Math.max(...results.map((r) => r.latency.max))),
    errors: results.reduce((a, r) => a + r.errors + r.timeouts, 0),
    non_2xx: results.reduce((a, r) => a + r.non2xx, 0),
    status_429: results.reduce((a, r) => a + (r.statusCodeStats?.['429']?.count || 0), 0),
  };
  merged.error_pct = Number((((merged.errors + merged.non_2xx - merged.status_429) / Math.max(1, total)) * 100).toFixed(2));
  summary.push(merged);
  console.log(JSON.stringify(merged));
  return merged;
}

const reads = (t) => [
  { method: 'GET', path: '/api/session' },
  { method: 'GET', path: '/api/dashboard' },
  { method: 'GET', path: '/api/rfqs' },
  { method: 'GET', setupRequest: (req) => ({ ...req, path: `/api/rfqs/${pick(t.rfqs)}` }) },
  { method: 'GET', path: '/api/jobs?status=active' },
  { method: 'GET', setupRequest: (req) => ({ ...req, path: `/api/jobs/${pick(t.jobs).id}` }) },
  { method: 'GET', path: '/api/agents' },
];

(async () => {
  console.log(`Seeding test data on ${TARGET}…`);
  const tenants = await seed();
  for (const t of tenants) t.cookie = await login(t);
  console.log(`${tenants.length} companies signed in`);

  // warm-up
  await scenario('warm-up', tenants, 10, reads);
  summary.length = 0;

  for (const c of LEVELS) await scenario(`everyday screens @${c}`, tenants, c, reads);
  await scenario('PDF quotations and SIs', tenants, 20, (t) => [
    { method: 'GET', setupRequest: (req) => ({ ...req, path: `/api/customer-quotes/${pick(t.quotes)}/pdf` }) },
    { method: 'GET', setupRequest: (req) => ({ ...req, path: `/api/jobs/${pick(t.jobs).id}/si/pdf` }) },
  ]);
  await scenario('saving changes', tenants, 50, (t) => [
    { method: 'PUT', headers: { 'content-type': 'application/json' }, setupRequest: (req) => ({ ...req, path: `/api/jobs/${pick(t.jobs).id}`, body: JSON.stringify({ notes: `load ${Date.now()}` }) }) },
  ]);
  await scenario('reports', tenants, 20, () => [{ method: 'GET', path: '/api/reports' }]);
  await scenario('public tracking page', tenants, 100, (t) => [
    { method: 'GET', setupRequest: (req) => ({ ...req, path: `/api/public/track/${pick(t.jobs).token}` }) },
    { method: 'GET', path: '/' },
  ]);

  // burst of incoming agent emails, processed the same way the mailbox reader does
  if (process.env.EMAIL_BURST !== 'off') {
    const { ingestInbound } = await import('../server/services/replies.js');
    const { runAsTenant } = await import('../server/db.js');
    const { getTenant } = await import('../server/services/tenants.js');
    const t0 = Date.now();
    let n = 0;
    await Promise.all(tenants.map(async (t) => {
      const tenant = await getTenant(t.tenant, { fresh: true });
      await runAsTenant(tenant, async () => {
        for (let i = 0; i < 50; i++) {
          const raw = `From: agent${i}@agents.loadtest\r\nTo: rfq@loadtest\r\nSubject: Re: RFQ-2026-${String(1 + (i % 200)).padStart(4, '0')} rates\r\nMessage-ID: <burst-${t.tenant}-${i}-${Date.now()}@x>\r\n\r\nOcean freight USD 900 per 40HC, THC INR 8500. Valid till month end.\r\n`;
          await ingestInbound({ id: null }, await simpleParser(raw)).catch(() => null);
          n++;
        }
      });
    }));
    const secs = (Date.now() - t0) / 1000;
    const r = { scenario: `incoming email burst (${n} emails)`, seconds: Number(secs.toFixed(1)), per_second: Number((n / secs).toFixed(1)) };
    summary.push(r);
    console.log(JSON.stringify(r));
  }

  console.log('\n===== SUMMARY =====');
  for (const s of summary) console.log(JSON.stringify(s));
  console.log('===== END =====');
  process.exit(0);
})().catch((e) => {
  console.error('LOADTEST FAILED', e);
  process.exit(1);
});
