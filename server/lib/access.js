// Access control: every API route is mapped to the permission it needs (unmapped routes are refused),
// "own records only" roles are limited to RFQs and jobs they created or were assigned, and roles
// without costs.view never receive buy rates, agent quotes, margins or profit.
import { AsyncLocalStorage } from 'node:async_hooks';
import { one } from '../db.js';
import { can } from '../engines/permissions.js';
import { recordOf } from './records.js';

// "METHOD /path" (as declared in the routers, relative to /api) -> rule.
// perm: a permission, a list (any one of them is enough) or 'any' (every signed-in user).
// via: which record the :id belongs to (checked for own-records roles). costs: also needs costs.view.
export const ROUTES = {
  'GET /meta': { perm: 'any' },
  'GET /settings': { perm: 'any' },
  'GET /mailboxes': { perm: 'any' },
  'GET /agents': { perm: 'any' },
  'GET /dashboard': { perm: 'any' },
  'GET /lost-reasons': { perm: 'any' },
  'GET /onboarding': { perm: 'any' },
  'POST /onboarding/dismiss': { perm: 'any' },

  'GET /users': { perm: 'users.manage' },
  'POST /users': { perm: 'users.manage' },
  'PUT /users/:id': { perm: 'users.manage' },
  'POST /users/:id/disable': { perm: 'users.manage' },
  'POST /users/:id/enable': { perm: 'users.manage' },
  'POST /users/:id/resend-invite': { perm: 'users.manage' },
  'GET /roles': { perm: ['users.manage', 'settings.manage'] }, // approval levels in Pricing pick a role
  'POST /roles': { perm: 'users.manage' },
  'PUT /roles/:key': { perm: 'users.manage' },
  'DELETE /roles/:key': { perm: 'users.manage' },
  'GET /users/assignable': { perm: ['rfqs.edit', 'jobs.manage'] },

  'PUT /settings/tracking': { perm: 'settings.manage' },
  'GET /tracking/providers': { perm: 'settings.manage' },
  'PUT /settings/ai': { perm: 'settings.manage' },
  'PUT /settings/:key': { perm: 'settings.manage' },
  'POST /mailboxes': { perm: 'settings.manage' },
  'PUT /mailboxes/:id': { perm: 'settings.manage' },
  'DELETE /mailboxes/:id': { perm: 'settings.manage' },
  'POST /mailboxes/:id/test': { perm: 'settings.manage' },
  'POST /mailboxes/:id/poll': { perm: ['rfqs.view', 'inbox.view'] },

  'POST /agents': { perm: 'contacts.manage' },
  'PUT /agents/:id': { perm: 'contacts.manage' },
  'GET /agents-stats': { perm: 'rfqs.view' },
  'GET /agents/suggest': { perm: 'rfqs.edit' },

  'GET /rfqs': { perm: 'rfqs.view' },
  'POST /enquiry/parse': { perm: 'rfqs.edit' },
  'POST /rfqs': { perm: 'rfqs.edit' },
  'POST /rfqs/:id/apply-rate-cards': { perm: 'rfqs.edit', costs: true, via: 'rfq' },
  'GET /rfqs/:id': { perm: 'rfqs.view', via: 'rfq' },
  'PUT /rfqs/:id': { perm: 'rfqs.edit', via: 'rfq' },
  'PUT /rfqs/:id/owner': { perm: 'rfqs.edit', via: 'rfq' },
  'POST /rfqs/:id/status': { perm: 'rfqs.edit', via: 'rfq' },
  'POST /rfqs/:id/send': { perm: 'rfqs.edit', via: 'rfq' },
  'POST /rfqs/:id/own-rates': { perm: 'rfqs.edit', costs: true, via: 'rfq' },
  'GET /rfqs/:id/compare': { perm: 'rfqs.view', costs: true, via: 'rfq' },
  'POST /rfqs/:id/award': { perm: 'quotes.decide', via: 'rfq' },
  'GET /rfqs/:id/family': { perm: 'rfqs.view', via: 'rfq' },
  'POST /rfqs/:id/duplicate': { perm: 'rfqs.edit', via: 'rfq' },
  'POST /rfqs/:id/customer-quote/preview': { perm: 'quotes.prepare', via: 'rfq' },
  'POST /rfqs/:id/customer-quotes': { perm: 'quotes.prepare', via: 'rfq' },

  'GET /rate-cards': { perm: 'costs.view' },
  'GET /rate-cards-template': { perm: 'costs.view' },
  'GET /rate-cards/:id': { perm: 'costs.view' },
  'POST /rate-cards/import': { perm: 'ratecards.manage' },
  'POST /rate-cards/ai-read': { perm: 'ratecards.manage' },
  'POST /rate-cards/bulk': { perm: 'ratecards.manage' },
  'POST /rate-cards': { perm: 'ratecards.manage' },
  'PUT /rate-cards/:id': { perm: 'ratecards.manage' },
  'POST /rate-cards/:id/copy': { perm: 'ratecards.manage' },
  'DELETE /rate-cards/:id': { perm: 'ratecards.manage' },
  'POST /agent-quotes/:id/remember': { perm: 'ratecards.manage', via: 'agentQuote' },

  'POST /invites/:id/send': { perm: 'rfqs.edit', via: 'invite' },
  'POST /invites/:id/remind': { perm: 'rfqs.edit', via: 'invite' },
  'POST /invites/:id/counter': { perm: 'rfqs.edit', costs: true, via: 'invite' },
  'POST /invites/:id/manual-reply': { perm: 'rfqs.edit', costs: true, via: 'invite' },
  'POST /agent-quotes': { perm: 'rfqs.edit', costs: true, via: 'bodyRfq' },
  'PUT /agent-quotes/:id': { perm: 'rfqs.edit', costs: true, via: 'agentQuote' },

  'GET /inbox/unmatched': { perm: 'inbox.view' },
  'GET /emails/:id': { perm: ['rfqs.view', 'jobs.view', 'inbox.view'], via: 'email' },
  'POST /emails/:id/assign': { perm: 'inbox.view', via: 'email' },
  'POST /emails/:id/parse': { perm: 'rfqs.edit', costs: true, via: 'email' },
  'POST /emails/:id/create-rfq': { perm: ['inbox.view', 'rfqs.edit'], via: 'email' },
  'POST /emails/:id/ignore': { perm: 'inbox.view', via: 'email' },
  'GET /attachments/:id': { perm: ['rfqs.view', 'jobs.view', 'inbox.view'], via: 'attachment' },

  'POST /customer-quotes/:id/approval': { perm: 'rfqs.view', via: 'customerQuote' }, // who may approve is decided by approval levels on roles
  'GET /customer-quotes/:id/pdf': { perm: 'rfqs.view', via: 'customerQuote' },
  'POST /customer-quotes/:id/send': { perm: 'quotes.send', via: 'customerQuote' },
  'POST /customer-quotes/:id/follow-up': { perm: 'quotes.send', via: 'customerQuote' },
  'POST /customer-quotes/:id/lost': { perm: 'quotes.decide', via: 'customerQuote' },
  'POST /customer-quotes/:id/accept': { perm: 'quotes.decide', via: 'customerQuote' },
  'POST /customer-quotes/:id/job': { perm: 'jobs.manage', via: 'customerQuote' },

  'GET /reports': { perm: 'reports.view' },
  'GET /audit': { perm: 'any', special: 'audit' },

  'GET /jobs': { perm: 'jobs.view' },
  'GET /jobs/cutoffs': { perm: 'jobs.view' },
  'GET /jobs/:id': { perm: 'jobs.view', via: 'job' },
  'PUT /jobs/:id': { perm: 'jobs.manage', via: 'job' },
  'PUT /jobs/:id/owner': { perm: 'jobs.manage', via: 'job' },
  'POST /jobs/:id/milestone': { perm: 'jobs.manage', via: 'job' },
  'POST /jobs/:id/send-bookings': { perm: 'jobs.manage', via: 'job' },
  'POST /jobs/:id/notify-customer': { perm: 'jobs.manage', via: 'job' },
  'POST /jobs/:id/costs': { perm: 'jobs.manage', costs: true, via: 'job' },
  'DELETE /job-costs/:id': { perm: 'jobs.manage', costs: true, via: 'jobCost' },
  'POST /jobs/:id/files': { perm: 'jobs.manage', via: 'job' },
  'GET /job-files/:id': { perm: 'jobs.view', via: 'jobFile' },
  'PUT /job-files/:id': { perm: 'jobs.manage', via: 'jobFile' },
  'DELETE /job-files/:id': { perm: 'jobs.manage', via: 'jobFile' },
  'POST /jobs/:id/doc-requirement': { perm: 'jobs.manage', via: 'job' },
  'POST /jobs/:id/request-documents': { perm: 'jobs.manage', via: 'job' },
  'GET /jobs/:id/si': { perm: 'jobs.view', via: 'job' },
  'PUT /jobs/:id/si': { perm: 'jobs.manage', via: 'job' },
  'POST /jobs/:id/si/prefill': { perm: 'jobs.manage', via: 'job' },
  'GET /jobs/:id/si/pdf': { perm: 'jobs.view', via: 'job' },
  'POST /jobs/:id/si/send': { perm: 'jobs.manage', via: 'job' },
  'POST /jobs/:id/bl': { perm: 'jobs.manage', via: 'job' },
  'POST /bl/:id/read': { perm: 'jobs.manage', via: 'bl' },
  'POST /bl/:id/send-customer': { perm: 'jobs.manage', via: 'bl' },
  'POST /bl/:id/customer-decision': { perm: 'jobs.manage', via: 'bl' },
  'POST /bl/:id/reply-agent': { perm: 'jobs.manage', via: 'bl' },
  'POST /emails/:id/read-customer': { perm: 'jobs.manage', via: 'email' },
  'POST /emails/:id/read-booking': { perm: 'jobs.manage', via: 'email' },
  'POST /jobs/:id/tracking/refresh': { perm: 'jobs.manage', via: 'job' },
  'POST /jobs/:id/tracking': { perm: 'jobs.manage', via: 'job' },
  'PUT /jobs/:id/tracking': { perm: 'jobs.manage', via: 'job' },
  'POST /jobs/:id/tracking/link': { perm: 'jobs.manage', via: 'job' },
  'POST /jobs/:id/notify': { perm: 'jobs.manage', via: 'job' },
  'DELETE /tracking/:id': { perm: 'jobs.manage', via: 'tracking' },
  'POST /bookings/:id/send': { perm: 'jobs.manage', via: 'booking' },
  'PUT /bookings/:id': { perm: 'jobs.manage', via: 'booking' },

  // billing router (mounted at /billing)
  'GET /billing': { perm: 'any' },
  'POST /billing/subscribe': { perm: 'billing.manage' },
  'POST /billing/refresh': { perm: 'any' },
  'POST /billing/cancel': { perm: 'billing.manage' },
  // platform router: Integrata's own console, guarded by requirePlatformAdmin
  'ANY /platform/*': { perm: 'any' },
};

// ---------- matching ----------
const compiled = Object.entries(ROUTES).map(([k, rule]) => {
  const [method, path] = k.split(' ');
  const params = (path.match(/:\w+/g) || []).length;
  const src = path.replace(/\/\*$/, '(?:/.*)?').replace(/:\w+/g, '[^/]+');
  return { method, re: new RegExp(`^${src}/?$`), params, rule, key: k, wildcard: path.endsWith('*') };
}).sort((a, b) => a.wildcard - b.wildcard || a.params - b.params); // exact paths before /:id paths

export function matchRoute(method, path) {
  return compiled.find((c) => (c.method === method || c.method === 'ANY') && c.re.test(path)) || null;
}

// ---------- who is asking (for list queries in services) ----------
const scopeStore = new AsyncLocalStorage();
/** The signed-in user's record scope: null = sees everything (or a background job). */
export const ownerScope = () => scopeStore.getStore() || null;

/** SQL condition limiting RFQs (alias) to the user's own; '' when they see everything. */
export function ownRfqSql(alias = 'r') {
  const s = ownerScope();
  if (!s) return '';
  return rfqOwnedBy(Number(s.userId), alias);
}
/** An RFQ is someone's if they created it or own it, or own the RFQ it is an alternative of. */
const rfqOwnedBy = (u, a) => `(${a}.created_by=${u} OR ${a}.assigned_to=${u} OR EXISTS (SELECT 1 FROM rfqs p WHERE p.id=${a}.parent_rfq_id AND (p.created_by=${u} OR p.assigned_to=${u})))`;
/** SQL condition limiting jobs (alias) to the user's own, or jobs of their own RFQs. */
export function ownJobSql(alias = 'j') {
  const s = ownerScope();
  if (!s) return '';
  const u = Number(s.userId);
  return `(${alias}.created_by=${u} OR ${alias}.assigned_to=${u} OR EXISTS (SELECT 1 FROM rfqs x WHERE x.id=${alias}.rfq_id AND ${rfqOwnedBy(u, 'x')}))`;
}
export const andOwn = (cond) => (cond ? ` AND ${cond}` : '');
export const whereOwn = (cond) => (cond ? ` WHERE ${cond}` : '');

async function ownsRecord(userId, rec) {
  if (!rec) return false;
  const u = Number(userId);
  if (rec.job_id) {
    const j = await one(`SELECT 1 FROM jobs j WHERE j.id=$1 AND ${ownJobSqlFor(u)}`, [rec.job_id]);
    if (j) return true;
  }
  if (rec.rfq_id) return !!(await one(`SELECT 1 FROM rfqs r WHERE r.id=$1 AND ${rfqOwnedBy(u, 'r')}`, [rec.rfq_id]));
  return false;
}
const ownJobSqlFor = (u) => `(j.created_by=${u} OR j.assigned_to=${u} OR EXISTS (SELECT 1 FROM rfqs x WHERE x.id=j.rfq_id AND ${rfqOwnedBy(u, 'x')}))`;

const deny = (res, msg = "Your role doesn't allow this.") => res.status(403).json({ error: msg, code: 'forbidden' });

/** Middleware (after sign-in): permission, costs and own-records checks for the matched route. */
export async function authorize(req, res, next) {
  try {
    const perms = req.user?.perms || [];
    const m = matchRoute(req.method, req.path);
    if (!m) {
      console.error(`access: no rule for ${req.method} ${req.path}`);
      return deny(res);
    }
    const { perm, via, costs, special } = m.rule;
    const ok = perm === 'any' || (Array.isArray(perm) ? perm.some((p) => can(perms, p)) : can(perms, perm));
    if (!ok) return deny(res);
    if (costs && !can(perms, 'costs.view')) return deny(res, "Your role doesn't show buy rates or margins.");
    const all = can(perms, 'data.all');
    const id = Number(req.path.split('/')[2]);

    if (special === 'audit') {
      if (req.query.rfq || req.query.job) {
        const rec = req.query.job ? await recordOf.job(Number(req.query.job)) : { rfq_id: Number(req.query.rfq) };
        if (!(req.query.job ? can(perms, 'jobs.view') : can(perms, 'rfqs.view'))) return deny(res);
        if (!all && !(await ownsRecord(req.user.id, rec))) return deny(res);
      } else if (!can(perms, 'audit.view')) return deny(res);
    }

    if (via) {
      const rec = via === 'bodyRfq' ? { rfq_id: Number(req.body?.rfq_id) } : await recordOf[via](id).catch(() => null);
      if (!rec) return next(); // the route answers 404 itself
      // agent emails and their attachments carry buy rates
      if ((via === 'email' || via === 'attachment') && rec.invite_id && !can(perms, 'costs.view')) return deny(res, "Your role doesn't show agents' rates.");
      // emails not tied to an RFQ or job are the unmatched inbox
      if ((via === 'email' || via === 'attachment') && !rec.rfq_id && !rec.job_id && !can(perms, 'inbox.view')) return deny(res);
      if (!all && (rec.rfq_id || rec.job_id) && !(await ownsRecord(req.user.id, rec))) return deny(res, 'This record belongs to someone else.');
    }
    if (!can(perms, 'costs.view')) redactResponses(res);
    if (all) return next();
    return scopeStore.run({ userId: req.user.id }, () => next());
  } catch (e) {
    next(e);
  }
}

// ---------- hiding costs ----------
const COST_KEYS = new Set(['buy', 'buy_amount', 'buy_converted', 'buy_currency', 'buy_rate', 'buy_total', 'margin', 'margin_pct', 'margin_pct_effective', 'avg_margin_pct', 'markup_pct', 'profit', 'profit_won', 'profit_quote_currency', 'rate_card_ids', 'rate_cards']);

/** Remove buy-side data from any response: cost fields, agent quotes, buy cost lines, agent email bodies. */
export function stripCosts(x) {
  if (Array.isArray(x)) {
    return x
      .filter((v) => !(v && typeof v === 'object' && v.kind === 'buy' && 'amount' in v)) // job buy costs
      .map(stripCosts);
  }
  if (!x || typeof x !== 'object' || x instanceof Date || Buffer.isBuffer(x)) return x;
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (COST_KEYS.has(k)) continue;
    // agent quotes (each tied to an invite, with priced lines)
    if (k === 'quotes' && Array.isArray(v) && v.some((q) => q && typeof q === 'object' && 'invite_id' in q && ('lines' in q || 'total' in q))) { out[k] = []; continue; }
    out[k] = stripCosts(v);
  }
  // an agent's email (rates in its body and attachments)
  if (out.invite_id && ('body_text' in out || 'body_html' in out)) {
    out.body_text = '[Agent rates hidden for your role]';
    out.body_html = null;
    if ('attachments' in out) out.attachments = [];
  }
  return out;
}

function redactResponses(res) {
  const json = res.json.bind(res);
  res.json = (body) => json(stripCosts(body));
}
