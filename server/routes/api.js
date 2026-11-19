import express from 'express';
import multer from 'multer';
import { q, one, runAsTenant } from '../db.js';
import { requireAuth, requireActiveSubscription, createUser, resendInvite, login, logout, issue, listUsers, updateUser, setUserDisabled, decode } from '../auth.js';
import { LEGS, BASES, CHARGE_CODES, MODES, INCOTERMS, CURRENCIES, CONTAINER_TYPES, LEG_CODES, PACKAGE_TYPES } from '../engines/charges.js';
import { getAllPublic, setSetting, saveAi, saveTracking } from '../services/settings.js';
import { encrypt } from '../lib/crypto.js';
import { getMailbox, testSmtp, testImap, pollMailbox, canReceive } from '../services/mail.js';
import { createRfq, updateRfq, duplicateRfq, loadRfq, ownRatesInvite, sendRfq, sendInvite, remindInvite, counterInvite, compareRfq, awardRfq } from '../services/rfq.js';
import { ingestManual, parseEmail, assignEmail, saveQuote } from '../services/replies.js';
import { createRfqFromEmail } from '../services/intake.js';
import { listCards, getCard, saveCard, copyCard, deleteCard, applyRateCards, templateWorkbook, importRateCards, expiringCount, rememberQuote, saveCards } from '../services/rateCards.js';
import { attachmentBlocks } from '../services/extract.js';
import { parseEnquiry, readRateSheet } from '../services/ai.js';
import { previewCustomerQuote, saveCustomerQuote, renderPdf, emailCustomerQuote, followUpQuote, markLost, LOST_REASONS, decideApproval, acceptQuote, rfqFamily, approvalFor, withApprovalRights, approvableRoles } from '../services/customerQuote.js';
import { roleExists } from '../services/roles.js';
import { readRatesFromEmail, pendingRateMail, rateProposal, applyRateProposal, dismissRateProposal } from '../services/rateMail.js';
import { LANGUAGES } from '../services/i18n.js';
import { reports } from '../services/reports.js';
import { signUp, getTenant, accessState, usage, assertCanCreateRfq } from '../services/tenants.js';
import { requestPasswordReset, resetPassword, verifyEmail, resendVerification, peekToken } from '../services/accountTokens.js';
import { rateLimit, failureLimit } from '../lib/rateLimit.js';
import { auditMiddleware, listAudit } from '../services/audit.js';
import { onboardingStatus } from '../services/onboarding.js';
import { createJobFromQuote, listJobs, loadJob, updateJob, setMilestone, sendBookingRequest, sendAllBookingRequests, updateBooking, readBookingEmail, sendCustomerConfirmation, addCost, deleteCost, addFiles, getFile, deleteFile, upcomingCutoffs, jobCounts } from '../services/jobs.js';
import { setDocRequirement, requestDocuments, getSi, saveSi, prefillSi, renderSiPdf, sendSi, readBl, uploadBl, sendBlToCustomer, customerDecision, replyAgentOnBl, setFileKind, onCustomerJobEmail } from '../services/documents.js';
import { publicTracking, tenantOfToken, refreshJob, addTrackingNumber, removeTracking, setJobTracking, resetTrackLink, trackToken, notifyMilestone, providerList } from '../services/tracking.js';
import { sendStoredFile } from '../lib/security.js';
import { authorize, ownRfqSql, andOwn } from '../lib/access.js';
import { listRoles, saveRole, deleteRole } from '../services/roles.js';
import { PERMISSION_GROUPS } from '../engines/permissions.js';
import billing from './billing.js';
import platform from './platform.js';

const r = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10 } });
// Async handler. Re-enters the tenant context because stream-based middleware (uploads) can lose it.
const h = (fn) => (req, res, next) => {
  const run = () => Promise.resolve(fn(req, res, next)).catch(next);
  return req.tenant ? runAsTenant(req.tenant, run) : run();
};
const id = (req) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error('Not found'), { status: 404 });
  return n;
};

// ---------- session & sign-up ----------
r.get('/session', h(async (req, res) => {
  if (!decode(req)) return res.json({});
  requireAuth(req, res, async () => {
    const names = await q('SELECT name FROM roles WHERE key = ANY($1) ORDER BY name', [req.user.roles || []]).catch(() => []);
    res.json({ user: { ...req.user, role_names: names.map((r) => r.name) }, tenant: tenantView(req.tenant), access: req.access });
  });
}));
const authLimit = rateLimit({ max: 10, key: (req) => `${req.ip}|${req.path}|${String(req.body?.email || req.body?.token || '').toLowerCase()}` });
// one address trying many accounts, and one account tried from many addresses
const ipLimit = rateLimit({ max: 30, key: (req) => `ip|${req.ip}|${req.path}` });
const accountFails = failureLimit({ max: 20, key: (req) => String(req.body?.email || '').toLowerCase().trim() });
const mailLimit = rateLimit({ max: 5 });
r.post('/signup', rateLimit({ max: 5, windowMs: 60 * 60 * 1000 }), h(async (req, res) => {
  const { user } = await signUp(req.body);
  res.json({ verify_sent: true, email: user.email });
}));
r.post('/login', ipLimit, accountFails.check, authLimit, h(async (req, res) => {
  try {
    res.json({ user: await login(res, req.body.email, req.body.password) });
  } catch (e) {
    if (e.status === 401) accountFails.fail(req);
    if (e.code === 'unverified') return res.status(403).json({ error: e.message, code: 'unverified' });
    throw e;
  }
}));
// public shipment tracking page (no login): the token carries the tenant
r.get('/public/track/:token', rateLimit({ max: 60 }), async (req, res, next) => {
  try {
    const tenant = await getTenant(tenantOfToken(req.params.token)).catch(() => null);
    if (!tenant) return res.status(404).json({ error: 'This tracking link is not valid.' });
    const data = await runAsTenant(tenant, () => publicTracking(req.params.token));
    if (!data) return res.status(404).json({ error: 'This tracking link is not valid or has been switched off.' });
    res.json(data);
  } catch (e) { next(e); }
});

// account links (public)
r.post('/auth/forgot', mailLimit, h(async (req, res) => { await requestPasswordReset(req.body.email); res.json({ ok: true }); }));
r.get('/auth/check', h(async (req, res) => {
  const p = await peekToken(req.query.token, req.query.purpose === 'verify' ? 'verify' : req.query.invite ? 'invite' : 'reset');
  res.json({ ok: p.ok, reason: p.reason || null, email: p.ok ? p.token.email : null });
}));
r.post('/auth/reset', authLimit, h(async (req, res) => {
  const { user, tenant } = await resetPassword(req.body.token, req.body.password);
  issue(res, user, tenant.id);
  res.json({ ok: true });
}));
r.post('/auth/verify', authLimit, h(async (req, res) => {
  const { user, tenant } = await verifyEmail(req.body.token);
  issue(res, user, tenant.id);
  res.json({ ok: true });
}));
r.post('/auth/resend-verification', mailLimit, h(async (req, res) => { await resendVerification(req.body.email); res.json({ ok: true }); }));
r.post('/logout', h(async (req, res) => { await logout(req, res); res.json({ ok: true }); }));
r.use('/billing/razorpay/webhook', billing.webhook);

function tenantView(t) {
  if (!t) return null;
  const { schema, razorpay_customer_id, ...rest } = t;
  return rest;
}

r.use(requireAuth);
r.use(auditMiddleware);
r.use(requireActiveSubscription);
r.use(authorize);
r.use('/billing', billing.router);
r.use('/platform', platform);

r.get('/meta', (req, res) => res.json({ languages: LANGUAGES, permissions: PERMISSION_GROUPS, legs: LEGS, bases: BASES, charges: CHARGE_CODES.map(({ synonyms, ...c }) => c), modes: MODES, incoterms: INCOTERMS, currencies: CURRENCIES, containerTypes: CONTAINER_TYPES, packageTypes: PACKAGE_TYPES }));

// ---------- users ----------
r.get('/users', h(async (req, res) => res.json(await listUsers())));
r.post('/users', h(async (req, res) => res.json(await createUser(req.body))));
r.put('/users/:id', h(async (req, res) => res.json(await updateUser(id(req), req.body, req.user))));
r.post('/users/:id/disable', h(async (req, res) => res.json(await setUserDisabled(id(req), true, req.user))));
r.post('/users/:id/enable', h(async (req, res) => res.json(await setUserDisabled(id(req), false, req.user))));
r.get('/roles', h(async (req, res) => res.json(await listRoles())));
r.post('/roles', h(async (req, res) => res.json(await saveRole(null, req.body))));
r.put('/roles/:key', h(async (req, res) => res.json(await saveRole(req.params.key, req.body))));
r.delete('/roles/:key', h(async (req, res) => res.json(await deleteRole(req.params.key))));
r.get('/users/assignable', h(async (req, res) => res.json(await q('SELECT id, name, email FROM users WHERE disabled_at IS NULL ORDER BY name'))));
r.post('/users/:id/resend-invite', h(async (req, res) => { await resendInvite(id(req)); res.json({ ok: true }); }));

// ---------- settings ----------
r.get('/settings', h(async (req, res) => res.json(await getAllPublic())));
r.put('/settings/tracking', h(async (req, res) => { await saveTracking(req.body); res.json(await getAllPublic()); }));
r.get('/tracking/providers', h(async (req, res) => res.json(providerList())));
r.put('/settings/ai', h(async (req, res) => { await saveAi(req.body); res.json(await getAllPublic()); }));
r.put('/settings/:key', h(async (req, res) => {
  if (!['company', 'fx', 'pricing'].includes(req.params.key)) return res.status(400).json({ error: 'Unknown setting' });
  if (req.params.key === 'pricing' && req.body.approval_levels !== undefined) {
    const levels = Array.isArray(req.body.approval_levels) ? req.body.approval_levels : [];
    const clean = [];
    for (const l of levels) {
      const pct = Number(l.below_pct);
      if (l.below_pct === '' || l.below_pct === null || !Number.isFinite(pct) || pct < -100 || pct > 100) return res.status(400).json({ error: 'Each approval level needs a margin between -100% and 100%' });
      if (!l.role || !(await roleExists(l.role))) return res.status(400).json({ error: 'Each approval level needs a role' });
      clean.push({ below_pct: pct, role: l.role });
    }
    if (new Set(clean.map((l) => l.below_pct)).size !== clean.length) return res.status(400).json({ error: 'Two approval levels have the same margin' });
    req.body.approval_levels = clean.sort((a, b) => b.below_pct - a.below_pct);
  }
  await setSetting(req.params.key, req.body);
  res.json(await getAllPublic());
}));

// ---------- mailboxes ----------
const MB_FIELDS = ['label', 'from_name', 'from_email', 'reply_to', 'cc', 'bcc', 'signature', 'subject_template', 'reminder_hours', 'max_reminders', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'imap_host', 'imap_port', 'imap_secure', 'imap_user', 'imap_folder', 'is_default', 'active'];
const publicMb = (m) => { const { smtp_pass_enc, imap_pass_enc, ...rest } = m; return { ...rest, has_smtp_pass: !!smtp_pass_enc, has_imap_pass: !!imap_pass_enc }; };
r.get('/mailboxes', h(async (req, res) => res.json((await q('SELECT * FROM mailboxes ORDER BY id')).map(publicMb))));
async function saveMailbox(mbId, body) {
  const cols = MB_FIELDS.filter((f) => f in body);
  const vals = cols.map((f) => (body[f] === '' ? null : body[f]));
  if (body.smtp_pass) { cols.push('smtp_pass_enc'); vals.push(encrypt(body.smtp_pass)); }
  if (body.imap_pass) { cols.push('imap_pass_enc'); vals.push(encrypt(body.imap_pass)); }
  if (mbId) {
    const cur = await one('SELECT imap_host, imap_user, imap_folder FROM mailboxes WHERE id=$1', [mbId]);
    const changed = ['imap_host', 'imap_user', 'imap_folder'].some((k) => k in body && (body[k] || null) !== (cur?.[k] || null));
    if (changed) { cols.push('last_uid'); vals.push(0); }
  }
  if (body.is_default) await q('UPDATE mailboxes SET is_default=false');
  if (mbId) {
    if (cols.length) await q(`UPDATE mailboxes SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(',')} WHERE id=$${cols.length + 1}`, [...vals, mbId]);
    return one('SELECT * FROM mailboxes WHERE id=$1', [mbId]);
  }
  const count = await one('SELECT count(*)::int AS n FROM mailboxes');
  if (!count.n && !cols.includes('is_default')) { cols.push('is_default'); vals.push(true); }
  return one(`INSERT INTO mailboxes(${cols.join(',')}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals);
}
r.post('/mailboxes', h(async (req, res) => res.json(publicMb(await saveMailbox(null, req.body)))));
r.put('/mailboxes/:id', h(async (req, res) => res.json(publicMb(await saveMailbox(id(req), req.body)))));
r.delete('/mailboxes/:id', h(async (req, res) => { await q('UPDATE mailboxes SET active=false WHERE id=$1', [id(req)]); res.json({ ok: true }); }));
r.post('/mailboxes/:id/test', h(async (req, res) => {
  const mb = await getMailbox(id(req));
  const out = { smtp: null, imap: null };
  try { await testSmtp(mb); out.smtp = { ok: true }; } catch (e) { out.smtp = { ok: false, error: e.message }; }
  try { const s = await testImap(mb); out.imap = { ok: true, messages: s.messages }; } catch (e) { out.imap = { ok: false, error: e.message }; }
  res.json(out);
}));
r.post('/mailboxes/:id/poll', h(async (req, res) => {
  const mb = await getMailbox(id(req));
  if (!canReceive(mb)) return res.status(400).json({ error: 'IMAP not configured for this mailbox' });
  res.json({ new: await pollMailbox(mb) });
}));

// ---------- parties (one list: partner agents and/or customers) ----------
const PARTY_FIELDS = ['company', 'contact', 'email', 'cc', 'country', 'city', 'agent_type', 'services', 'ports', 'notes', 'active', 'is_agent', 'is_customer', 'currency', 'margin_pct', 'tax_pct', 'quote_language'];
r.get('/agents', h(async (req, res) => {
  const role = req.query.role;
  const where = role === 'agent' ? 'WHERE is_agent' : role === 'customer' ? 'WHERE is_customer' : "WHERE coalesce(source,'') <> 'internal'";
  res.json(await q(`SELECT * FROM agents ${where} ORDER BY company`));
}));
r.post('/agents', h(async (req, res) => {
  const cols = PARTY_FIELDS.filter((f) => f in req.body);
  const vals = cols.map((f) => (req.body[f] === '' ? null : req.body[f]));
  res.json(await one(`INSERT INTO agents(${cols.join(',')}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals));
}));
r.put('/agents/:id', h(async (req, res) => {
  const cols = PARTY_FIELDS.filter((f) => f in req.body);
  const vals = cols.map((f) => (req.body[f] === '' ? null : req.body[f]));
  res.json(await one(`UPDATE agents SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(',')} WHERE id=$${cols.length + 1} RETURNING *`, [...vals, id(req)]));
}));

r.get('/agents-stats', h(async (req, res) => {
  res.json(await q(`SELECT a.id,
    count(i.id)::int AS invited,
    count(i.replied_at)::int AS replied,
    count(*) FILTER (WHERE i.awarded)::int AS won,
    round(avg(extract(epoch FROM (i.replied_at - i.sent_at))/3600)::numeric,1) AS avg_reply_hours
    FROM agents a LEFT JOIN rfq_invites i ON i.agent_id=a.id GROUP BY a.id`));
}));

r.get('/agents/suggest', h(async (req, res) => {
  const legs = String(req.query.legs || '').split(',').filter(Boolean);
  const places = [req.query.pol, req.query.pod, req.query.pickup, req.query.delivery].filter(Boolean).map((s) => String(s).toLowerCase());
  const agents = await q(`SELECT a.*, count(i.id)::int AS invited, count(i.replied_at)::int AS replied, count(*) FILTER (WHERE i.awarded)::int AS won
    FROM agents a LEFT JOIN rfq_invites i ON i.agent_id=a.id WHERE a.active AND a.is_agent AND a.id <> $1 GROUP BY a.id`, [Number(req.query.exclude) || 0]);
  const scored = agents.map((a) => {
    const legHits = legs.filter((l) => (a.services || []).includes(l));
    const text = `${a.ports || ''} ${a.city || ''} ${a.country || ''}`.toLowerCase();
    const placeHits = places.filter((p) => p.split(/[\s,()]+/).some((w) => w.length > 2 && text.includes(w))).length;
    const responseRate = a.invited ? a.replied / a.invited : 0.5;
    const score = legHits.length * 3 + placeHits * 2 + responseRate * 2 + Math.min(a.won, 5) * 0.3;
    return { ...a, suggested_legs: legHits.length ? legHits : legs.filter((l) => !(a.services || []).length), score: Math.round(score * 10) / 10, response_rate: a.invited ? Math.round(responseRate * 100) : null };
  }).filter((a) => a.score > 0).sort((x, y) => y.score - x.score);
  res.json(scored);
}));

// ---------- RFQs ----------
r.get('/dashboard', h(async (req, res) => {
  const s = await one(`SELECT
    count(*) FILTER (WHERE status='new')::int AS new_enquiries,
    count(*) FILTER (WHERE status IN ('sent','quoting'))::int AS open,
    count(*) FILTER (WHERE status='quoted')::int AS quoted,
    count(*) FILTER (WHERE status='awarded')::int AS awarded,
    count(*) FILTER (WHERE created_at > now()-interval '30 days')::int AS last30 FROM rfqs r${ownRfqSql('r') ? ` WHERE ${ownRfqSql('r')}` : ''}`);
  const review = await one(`SELECT count(*)::int AS n FROM agent_quotes q JOIN rfqs r ON r.id=q.rfq_id WHERE NOT q.verified AND NOT q.superseded AND NOT q.declined AND r.status IN ('sent','quoting')${andOwn(ownRfqSql('r'))}`);
  const unmatched = await one(`SELECT count(*)::int AS n FROM emails WHERE direction='in' AND invite_id IS NULL AND parse_status='unmatched'`);
  const errors = await one(`SELECT count(*)::int AS n FROM emails WHERE parse_status='error'`);
  const mine = approvableRoles(req.user); // null = every level
  const approvals = mine && !mine.length ? { n: 0 } : await one(`SELECT count(*)::int AS n FROM customer_quotes c JOIN rfqs r ON r.id=c.rfq_id WHERE c.approval_status='pending'${mine ? ` AND coalesce(c.approval_role,'manager') = ANY($1)` : ''}${andOwn(ownRfqSql('r'))}`, mine ? [mine] : []);
  const rc = await expiringCount();
  const p = req.user.perms;
  const jobsOk = p.includes('jobs.view');
  const [jobs, cutoffs] = jobsOk ? await Promise.all([jobCounts(), upcomingCutoffs(72)]) : [null, []];
  // only what this role may see
  res.json({
    ...(p.includes('rfqs.view') ? s : {}),
    jobs, cutoffs,
    approvals_pending: approvals.n || null,
    rate_cards_expiring: p.includes('costs.view') ? rc.expiring : null,
    rate_cards_expired: p.includes('costs.view') ? rc.expired : null,
    needs_review: p.includes('costs.view') ? review.n : null,
    unmatched: p.includes('inbox.view') ? unmatched.n : null,
    parse_errors: p.includes('inbox.view') ? errors.n : null,
  });
}));

r.get('/rfqs', h(async (req, res) => {
  res.json(await q(`SELECT r.*, p.company AS requester_name,
    (SELECT count(*)::int FROM rfq_invites i WHERE i.rfq_id=r.id) AS invites,
    (SELECT count(*)::int FROM rfq_invites i WHERE i.rfq_id=r.id AND i.replied_at IS NOT NULL) AS replies,
    (SELECT count(*)::int FROM agent_quotes q WHERE q.rfq_id=r.id AND NOT q.superseded AND NOT q.verified AND NOT q.declined) AS to_review
    FROM rfqs r LEFT JOIN agents p ON p.id=r.requester_id ${ownRfqSql('r') ? `WHERE ${ownRfqSql('r')}` : ''} ORDER BY r.id DESC LIMIT 500`));
}));
r.post('/enquiry/parse', h(async (req, res) => res.json(await parseEnquiry(req.body.text || ''))));
r.post('/rfqs', h(async (req, res) => {
  await assertCanCreateRfq(req.tenant);
  const rfq = await createRfq(req.body, req.user.id);
  // price instantly from stored rate cards (never emails anyone)
  try { rfq.rate_cards = await applyRateCards(rfq.id); } catch (e) { console.error('rate cards', e.message); }
  res.json(rfq);
}));
r.post('/rfqs/:id/apply-rate-cards', h(async (req, res) => res.json(await applyRateCards(id(req)))));
r.get('/rfqs/:id', h(async (req, res) => {
  const d = await loadRfq(id(req));
  if (!d) return res.status(404).json({ error: 'Not found' });
  d.customerQuotes = await withApprovalRights(d.customerQuotes, req.user);
  res.json(d);
}));
r.put('/rfqs/:id', h(async (req, res) => res.json(await updateRfq(id(req), req.body))));
r.put('/rfqs/:id/owner', h(async (req, res) => {
  const owner = req.body.user_id ? Number(req.body.user_id) : null;
  if (owner && !(await one('SELECT 1 FROM users WHERE id=$1 AND disabled_at IS NULL', [owner]))) return res.status(400).json({ error: 'Choose an active user' });
  await q('UPDATE rfqs SET assigned_to=$1 WHERE id=$2', [owner, id(req)]);
  res.json({ ok: true, assigned_to: owner });
}));
r.post('/rfqs/:id/status', h(async (req, res) => { await q('UPDATE rfqs SET status=$1 WHERE id=$2', [req.body.status, id(req)]); res.json({ ok: true }); }));
r.post('/rfqs/:id/send', h(async (req, res) => res.json(await sendRfq(id(req)))));
r.post('/rfqs/:id/own-rates', h(async (req, res) => res.json(await ownRatesInvite(id(req)))));
r.get('/rfqs/:id/compare', h(async (req, res) => res.json(await compareRfq(id(req), req.query.currency))));
r.post('/rfqs/:id/award', h(async (req, res) => res.json(await awardRfq(id(req), req.body.selection, req.body))));

// ---------- rate cards ----------
r.get('/rate-cards', h(async (req, res) => res.json(await listCards(req.query))));
r.get('/rate-cards-template', h(async (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="rate-card-template.xlsx"');
  res.send(templateWorkbook());
}));
r.post('/rate-cards/import', upload.single('file'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an Excel or CSV file' });
  res.json(await importRateCards(req.file.buffer));
}));
r.post('/rate-cards/ai-read', upload.single('file'), h(async (req, res) => {
  const blocks = req.file ? await attachmentBlocks({ filename: req.file.originalname, content_type: req.file.mimetype, data: req.file.buffer }) : [];
  if (req.body.text) blocks.push({ type: 'text', text: String(req.body.text).slice(0, 60000) });
  if (!blocks.length) return res.status(400).json({ error: 'Upload a rate sheet or paste its text' });
  res.json(await readRateSheet({ blocks, hint: req.body.hint }));
}));
r.post('/rate-cards/bulk', h(async (req, res) => res.json(await saveCards(req.body.cards || [], req.body.vendor_id || null))));
r.get('/rate-mail', h(async (req, res) => res.json(await pendingRateMail())));
r.get('/rate-mail/:id', h(async (req, res) => res.json(await rateProposal(id(req)))));
r.post('/rate-mail/:id/read', h(async (req, res) => res.json(await readRatesFromEmail(id(req), req.user))));
r.post('/rate-mail/:id/apply', h(async (req, res) => res.json(await applyRateProposal(id(req), { cards: req.body.cards, agentId: req.body.agent_id, user: req.user }))));
r.post('/rate-mail/:id/dismiss', h(async (req, res) => res.json(await dismissRateProposal(id(req), req.user))));
r.post('/agent-quotes/:id/remember', h(async (req, res) => res.json({ cards: await rememberQuote(id(req)) })));
r.get('/rate-cards/:id', h(async (req, res) => res.json(await getCard(id(req)))));
r.post('/rate-cards', h(async (req, res) => res.json(await saveCard(req.body))));
r.put('/rate-cards/:id', h(async (req, res) => res.json(await saveCard({ ...req.body, id: id(req) }))));
r.post('/rate-cards/:id/copy', h(async (req, res) => res.json(await copyCard(id(req)))));
r.delete('/rate-cards/:id', h(async (req, res) => { await deleteCard(id(req)); res.json({ ok: true }); }));

// ---------- invites ----------
r.post('/invites/:id/send', h(async (req, res) => { await sendInvite(id(req)); res.json({ ok: true }); }));
r.post('/invites/:id/remind', h(async (req, res) => { await remindInvite(id(req)); res.json({ ok: true }); }));
r.post('/invites/:id/counter', h(async (req, res) => { await counterInvite(id(req), req.body.message); res.json({ ok: true }); }));
r.post('/invites/:id/manual-reply', upload.array('files'), h(async (req, res) => {
  const invite = await one('SELECT * FROM rfq_invites WHERE id=$1', [id(req)]);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  res.json(await ingestManual({ invite, from: req.body.from, subject: req.body.subject, text: req.body.text, files: req.files }));
}));

// ---------- emails ----------
// mail waiting for someone: not linked to an RFQ, not ignored, not a rate sheet handled under Rate cards
const UNMATCHED = `direction='in' AND invite_id IS NULL AND rfq_id IS NULL AND coalesce(parse_status,'') NOT IN ('ignored','rate_reading','rates_pending','rates_applied','rates_dismissed')`;
r.get('/inbox/count', h(async (req, res) => res.json(await one(`SELECT count(*)::int AS n FROM emails WHERE ${UNMATCHED}`))));
r.get('/inbox/unmatched', h(async (req, res) => res.json(await q(`SELECT id,from_addr,subject,at,parse_status,parse_error,left(body_text,400) AS preview FROM emails WHERE ${UNMATCHED} ORDER BY at DESC LIMIT 200`))));
r.get('/emails/:id', h(async (req, res) => res.json(await one('SELECT * FROM emails WHERE id=$1', [id(req)]))));
r.post('/emails/:id/assign', h(async (req, res) => res.json(await assignEmail(id(req), req.body.invite_id))));
r.post('/emails/:id/parse', h(async (req, res) => res.json(await parseEmail(id(req)))));
r.post('/emails/:id/create-rfq', h(async (req, res) => res.json(await createRfqFromEmail(id(req)))));
r.post('/emails/:id/ignore', h(async (req, res) => { await q("UPDATE emails SET parse_status='ignored' WHERE id=$1", [id(req)]); res.json({ ok: true }); }));
r.get('/attachments/:id', h(async (req, res) => {
  const a = await one('SELECT * FROM attachments WHERE id=$1', [id(req)]);
  if (!a) return res.status(404).end();
  sendStoredFile(res, a);
}));

// ---------- agent quotes (review / manual) ----------
function validLines(lines) {
  return (lines || []).map((l, i) => {
    if (!LEG_CODES.includes(l.leg)) throw Object.assign(new Error(`Invalid leg ${l.leg}`), { status: 400 });
    return { ...l, sort: i };
  });
}
r.post('/agent-quotes', h(async (req, res) => {
  const inv = await one('SELECT * FROM rfq_invites WHERE id=$1', [req.body.invite_id]);
  const qrow = await saveQuote({ ...req.body, rfq_id: inv.rfq_id, invite_id: inv.id, lines: validLines(req.body.lines), verified: true, source: 'manual' });
  await rememberQuote(qrow.id).catch((e) => console.error('rate memory', e.message));
  await q("UPDATE rfq_invites SET status=CASE WHEN status IN ('pending','sent','reminded') THEN 'replied' ELSE status END, replied_at=coalesce(replied_at,now()) WHERE id=$1", [inv.id]);
  res.json(qrow);
}));
r.put('/agent-quotes/:id', h(async (req, res) => {
  const b = req.body;
  const qid = id(req);
  await q(`UPDATE agent_quotes SET valid_until=$1, transit_days=$2, free_days=$3, routing=$4, carrier=$5, remarks=$6, exclusions=$7, verified=$8 WHERE id=$9`,
    [b.valid_until || null, b.transit_days ?? null, b.free_days ?? null, b.routing || null, b.carrier || null, b.remarks || null, b.exclusions || null, b.verified !== false, qid]);
  if (b.lines) {
    await q('DELETE FROM quote_lines WHERE agent_quote_id=$1', [qid]);
    for (const l of validLines(b.lines)) {
      await q('INSERT INTO quote_lines(agent_quote_id,leg,charge_code,description,basis,rate,currency,qty,confidence,sort) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [qid, l.leg, l.charge_code, l.description || null, l.basis, Number(l.rate) || 0, (l.currency || 'USD').toUpperCase(), l.qty === '' || l.qty === undefined ? null : l.qty, b.verified !== false ? 1 : l.confidence ?? null, l.sort]);
    }
  }
  if (b.verified !== false) await rememberQuote(qid).catch((e) => console.error('rate memory', e.message));
  res.json({ ok: true });
}));

// ---------- customer quotes ----------
r.post('/rfqs/:id/customer-quote/preview', h(async (req, res) => {
  const snap = await previewCustomerQuote(id(req), req.body);
  res.json({ ...snap, approval: await approvalFor(snap, req.user) });
}));
r.post('/rfqs/:id/customer-quotes', h(async (req, res) => res.json(await saveCustomerQuote(id(req), req.body, req.user))));
r.post('/customer-quotes/:id/approval', h(async (req, res) => { await decideApproval(id(req), req.user, req.body); res.json({ ok: true }); }));
r.get('/rfqs/:id/family', h(async (req, res) => {
  const fam = await rfqFamily(id(req));
  const own = ownRfqSql('r');
  if (!own) return res.json(fam);
  const ok = new Set((await q(`SELECT r.id FROM rfqs r WHERE r.id = ANY($1) AND ${own}`, [fam.map((x) => x.id)])).map((x) => x.id));
  res.json(fam.filter((x) => ok.has(x.id)));
}));
r.post('/rfqs/:id/duplicate', h(async (req, res) => {
  await assertCanCreateRfq(req.tenant);
  const rfq = await duplicateRfq(id(req), req.body, req.user.id);
  try { await applyRateCards(rfq.id); } catch (e) { console.error('rate cards', e.message); }
  res.json(rfq);
}));
r.get('/customer-quotes/:id/pdf', h(async (req, res) => {
  const cq = await one('SELECT ref FROM customer_quotes WHERE id=$1', [id(req)]);
  const pdf = await renderPdf(id(req));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${cq.ref}.pdf"`);
  res.send(pdf);
}));
r.post('/customer-quotes/:id/send', h(async (req, res) => { await emailCustomerQuote(id(req), req.body || {}); res.json({ ok: true }); }));
r.post('/customer-quotes/:id/follow-up', h(async (req, res) => { await followUpQuote(id(req)); res.json({ ok: true }); }));
r.post('/customer-quotes/:id/lost', h(async (req, res) => { await markLost(id(req), req.body); res.json({ ok: true }); }));
r.get('/lost-reasons', (req, res) => res.json(LOST_REASONS));
r.get('/reports', h(async (req, res) => res.json(await reports(req.query))));
r.get('/onboarding', h(async (req, res) => res.json(await onboardingStatus())));
r.post('/onboarding/dismiss', h(async (req, res) => { await setSetting('onboarding', { dismissed: req.body.dismissed !== false }); res.json(await onboardingStatus()); }));
r.get('/audit', h(async (req, res) => {
  // admins see everything; others only the history of a specific RFQ
  if (!req.user.perms.includes('audit.view') && !req.query.rfq && !req.query.job) return res.status(403).json({ error: 'Admin only' });
  res.json(await listAudit(req.query));
}));
r.post('/customer-quotes/:id/accept', h(async (req, res) => {
  const option = Number(req.body.option) || 0;
  const results = await acceptQuote(id(req), { option, sendRegrets: req.body.sendRegrets !== false, note: req.body.note, award: req.body.award !== false });
  const job = await createJobFromQuote(id(req), option, req.user);
  res.json({ ok: true, results, job });
}));
r.post('/customer-quotes/:id/job', h(async (req, res) => res.json({ job: await createJobFromQuote(id(req), req.body.option, req.user) })));

// ---------- jobs & bookings ----------
r.get('/jobs', h(async (req, res) => res.json(await listJobs(req.query))));
r.get('/jobs/cutoffs', h(async (req, res) => res.json(await upcomingCutoffs(Number(req.query.hours) || 72))));
r.get('/jobs/:id', h(async (req, res) => res.json(await loadJob(id(req)))));
r.put('/jobs/:id', h(async (req, res) => res.json(await updateJob(id(req), req.body))));
r.put('/jobs/:id/owner', h(async (req, res) => {
  const owner = req.body.user_id ? Number(req.body.user_id) : null;
  if (owner && !(await one('SELECT 1 FROM users WHERE id=$1 AND disabled_at IS NULL', [owner]))) return res.status(400).json({ error: 'Choose an active user' });
  await q('UPDATE jobs SET assigned_to=$1 WHERE id=$2', [owner, id(req)]);
  res.json(await loadJob(id(req)));
}));
r.post('/jobs/:id/milestone', h(async (req, res) => res.json(await setMilestone(id(req), req.body))));
r.post('/jobs/:id/send-bookings', h(async (req, res) => res.json(await sendAllBookingRequests(id(req), req.body, req.user))));
r.post('/jobs/:id/notify-customer', h(async (req, res) => res.json(await sendCustomerConfirmation(id(req), req.body, req.user))));
r.post('/jobs/:id/costs', h(async (req, res) => res.json(await addCost(id(req), req.body))));
r.delete('/job-costs/:id', h(async (req, res) => res.json(await deleteCost(id(req)))));
r.post('/jobs/:id/files', upload.array('files'), h(async (req, res) => res.json(await addFiles(id(req), req.files, req.body.kind, req.user))));
r.get('/job-files/:id', h(async (req, res) => {
  const f = await getFile(id(req));
  if (!f) return res.status(404).end();
  sendStoredFile(res, f);
}));
r.delete('/job-files/:id', h(async (req, res) => res.json(await deleteFile(id(req)))));
// ---------- job documents ----------
const jobOfBl = async (blId) => (await one('SELECT job_id FROM bl_drafts WHERE id=$1', [blId]))?.job_id;
r.post('/jobs/:id/doc-requirement', h(async (req, res) => { await setDocRequirement(id(req), req.body); res.json(await loadJob(id(req))); }));
r.post('/jobs/:id/request-documents', h(async (req, res) => { await requestDocuments(id(req), req.body); res.json(await loadJob(id(req))); }));
r.get('/jobs/:id/si', h(async (req, res) => res.json(await getSi(id(req)))));
r.put('/jobs/:id/si', h(async (req, res) => res.json(await saveSi(id(req), req.body))));
r.post('/jobs/:id/si/prefill', h(async (req, res) => res.json(await prefillSi(id(req)))));
r.get('/jobs/:id/si/pdf', h(async (req, res) => {
  const buf = await renderSiPdf(id(req));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="SI-${id(req)}.pdf"`);
  res.send(buf);
}));
r.post('/jobs/:id/si/send', h(async (req, res) => { await sendSi(id(req), req.body); res.json(await loadJob(id(req))); }));
r.post('/jobs/:id/bl', upload.single('file'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a file' });
  await uploadBl(id(req), req.file, req.body, req.user);
  res.json(await loadJob(id(req)));
}));
r.post('/bl/:id/read', h(async (req, res) => { await readBl(id(req)); res.json(await loadJob(await jobOfBl(id(req)))); }));
r.post('/bl/:id/send-customer', h(async (req, res) => { await sendBlToCustomer(id(req), req.body); res.json(await loadJob(await jobOfBl(id(req)))); }));
r.post('/bl/:id/customer-decision', h(async (req, res) => { await customerDecision(id(req), req.body); res.json(await loadJob(await jobOfBl(id(req)))); }));
r.post('/bl/:id/reply-agent', h(async (req, res) => { await replyAgentOnBl(id(req), req.body); res.json(await loadJob(await jobOfBl(id(req)))); }));
r.put('/job-files/:id', h(async (req, res) => res.json(await loadJob(await setFileKind(id(req), req.body.kind)))));
r.post('/emails/:id/read-customer', h(async (req, res) => {
  const e = await one('SELECT * FROM emails WHERE id=$1', [id(req)]);
  await onCustomerJobEmail(e);
  res.json(await loadJob(e.job_id));
}));
// ---------- live tracking ----------
r.post('/jobs/:id/tracking/refresh', h(async (req, res) => { const errors = await refreshJob(id(req)); res.json({ ...(await loadJob(id(req))), warnings: errors }); }));
r.post('/jobs/:id/tracking', h(async (req, res) => { await addTrackingNumber(id(req), req.body); res.json(await loadJob(id(req))); }));
r.put('/jobs/:id/tracking', h(async (req, res) => { await setJobTracking(id(req), req.body); res.json(await loadJob(id(req))); }));
r.post('/jobs/:id/tracking/link', h(async (req, res) => { await (req.body.reset ? resetTrackLink(id(req)) : trackToken(id(req))); res.json(await loadJob(id(req))); }));
r.post('/jobs/:id/notify', h(async (req, res) => {
  const sent = await notifyMilestone(id(req), req.body.kind, {});
  if (!sent) return res.status(400).json({ error: 'Not sent: milestone emails are off in Settings, or this update was already sent.' });
  res.json(await loadJob(id(req)));
}));
r.delete('/tracking/:id', h(async (req, res) => res.json(await loadJob(await removeTracking(id(req))))));
r.post('/bookings/:id/send', h(async (req, res) => res.json(await sendBookingRequest(id(req), req.body, req.user))));
r.put('/bookings/:id', h(async (req, res) => res.json(await updateBooking(id(req), req.body))));
r.post('/emails/:id/read-booking', h(async (req, res) => {
  const e = await one('SELECT job_id FROM emails WHERE id=$1', [id(req)]);
  await readBookingEmail(id(req));
  res.json(await loadJob(e.job_id));
}));

export default r;
