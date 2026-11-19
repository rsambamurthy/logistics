// Checks that per-address limits work behind Railway's proxy: 35 failed logins for different
// (made-up) accounts from this one machine should be blocked after 30.
const TARGET = (process.env.TARGET || '').replace(/\/$/, '');
if (/quayly\.integratatech\.ai/.test(TARGET)) throw new Error('not on the live site');
let blockedAt = null;
for (let i = 1; i <= 35; i++) {
  const r = await fetch(`${TARGET}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `nobody${i}-${Date.now()}@ipcheck.test`, password: 'x' }) });
  if (r.status === 429) { blockedAt = i; break; }
}
console.log(`RESULT ipcheck blockedAt=${blockedAt}`);
// spoofed X-Forwarded-For must not give a fresh allowance
const spoof = await fetch(`${TARGET}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' }, body: JSON.stringify({ email: `spoof-${Date.now()}@ipcheck.test`, password: 'x' }) });
console.log(`RESULT ipcheck spoofed-header status=${spoof.status} (429 = spoofing does not help)`);
