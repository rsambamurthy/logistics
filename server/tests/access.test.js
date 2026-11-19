import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ROUTES, matchRoute, stripCosts } from '../lib/access.js';
import { normalisePermissions, SYSTEM_ROLES, PERMISSION_CODES } from '../engines/permissions.js';

const declared = (file, prefix = '') =>
  [...fs.readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/\b(?:r|router)\.(get|post|put|delete)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${prefix}${m[2] === '/' ? '' : m[2]}`);
const PUBLIC = /^(GET|POST) \/(session|signup|login|logout|auth\/|public\/)/;

test('every signed-in API route has an access rule', () => {
  const routes = [...declared('../routes/api.js'), ...declared('../routes/billing.js', '/billing')].filter((r) => !PUBLIC.test(r));
  const missing = routes.filter((r) => { const [m, p] = r.split(' '); return !matchRoute(m, p.replace(/:\w+/g, '1')); });
  assert.deepEqual(missing, []);
});

test('rules are matched exactly, specific paths before :id paths', () => {
  assert.equal(matchRoute('GET', '/jobs/cutoffs').key, 'GET /jobs/cutoffs');
  assert.equal(matchRoute('GET', '/jobs/12').key, 'GET /jobs/:id');
  assert.equal(matchRoute('GET', '/users/assignable').key, 'GET /users/assignable');
  assert.equal(matchRoute('DELETE', '/rfqs/3'), null);
  assert.equal(matchRoute('GET', '/platform/tenants').key, 'ANY /platform/*');
  assert.ok(Object.keys(ROUTES).length > 100);
});

test('permissions pull in what they need; built-in roles match the old behaviour', () => {
  assert.deepEqual(normalisePermissions(['ratecards.manage', 'nonsense']), ['costs.view', 'ratecards.manage']);
  assert.ok(normalisePermissions(['reports.view']).includes('data.all'));
  const user = SYSTEM_ROLES.find((r) => r.key === 'user').permissions;
  assert.ok(!user.includes('quotes.approve') && !user.includes('settings.manage') && user.includes('costs.view'));
  assert.ok(SYSTEM_ROLES.find((r) => r.key === 'manager').permissions.includes('quotes.approve'));
  assert.deepEqual(SYSTEM_ROLES.find((r) => r.key === 'admin').permissions, PERMISSION_CODES);
});

test('cost data is stripped from responses', () => {
  const body = {
    rfq: { id: 1, ref: 'RFQ-1' },
    quotes: [{ id: 1, invite_id: 2, total: 900, lines: [{ rate: 900 }] }],
    emails: [{ id: 5, invite_id: 2, body_text: 'USD 900', attachments: [{ id: 1 }] }, { id: 6, invite_id: null, body_text: 'customer mail' }],
    customerQuotes: [{ id: 3, margin_pct: 10, snapshot: { totals: { sell: 1100, buy: 900, profit: 200, grand_total: 1100 }, sections: [{ margin_pct: 10, lines: [{ sell_amount: 1100, buy_amount: 900, buy_currency: 'USD' }] }] } }],
    costs: [{ kind: 'buy', amount: 900 }, { kind: 'sell', amount: 1100 }],
    profit: { profit: 200 },
  };
  const s = stripCosts(body);
  assert.deepEqual(s.quotes, []);
  assert.equal(s.emails[0].body_text, '[Agent rates hidden for your role]');
  assert.deepEqual(s.emails[0].attachments, []);
  assert.equal(s.emails[1].body_text, 'customer mail');
  assert.deepEqual(s.customerQuotes[0].snapshot.totals, { sell: 1100, grand_total: 1100 });
  assert.deepEqual(s.customerQuotes[0].snapshot.sections[0].lines[0], { sell_amount: 1100 });
  assert.equal(s.customerQuotes[0].margin_pct, undefined);
  assert.deepEqual(s.costs, [{ kind: 'sell', amount: 1100 }]);
  assert.equal(s.profit, undefined);
  assert.ok(!JSON.stringify(s).includes('900'));
});
