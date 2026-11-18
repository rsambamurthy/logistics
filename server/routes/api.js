import express from 'express';
import multer from 'multer';
import { q, one } from '../db.js';
import { requireAuth, requireAdmin, needsSetup, createUser, login, logout, issue, listUsers } from '../auth.js';
import { LEGS, BASES, CHARGE_CODES, MODES, INCOTERMS, CURRENCIES, CONTAINER_TYPES, LEG_CODES } from '../engines/charges.js';
import { getAllPublic, setSetting, saveAi } from '../services/settings.js';
import { encrypt } from '../lib/crypto.js';
import { getMailbox, testSmtp, testImap, pollMailbox, canReceive } from '../services/mail.js';
import { createRfq, updateRfq, loadRfq, ownRatesInvite, sendRfq, sendInvite, remindInvite, counterInvite, compareRfq, awardRfq } from '../services/rfq.js';
import { ingestManual, parseEmail, assignEmail, saveQuote } from '../services/replies.js';
import { createRfqFromEmail } from '../services/intake.js';
import { parseEnquiry } from '../services/ai.js';
import { previewCustomerQuote, saveCustomerQuote, renderPdf, emailCustomerQuote } from '../services/customerQuote.js';

const r = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10 } });
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const id = (req) => Number(req.params.id);

// ---------- session ----------
r.get('/session', h(async (req, res) => {
  if (await needsSetup()) return res.json({ setup: true });
  requireAuth(req, res, () => res.json({ user: req.user }));
}));
r.post('/setup', h(async (req, res) => {
  if (!(await needsSetup())) return res.status(400).json({ error: 'Already set up' });
  const u = await createUser({ ...req.body, role: 'admin' });
  issue(res, u);
  res.json({ user: u });
}));
r.post('/login', h(async (req, res) => res.json({ user: await login(res, req.body.email, req.body.password) })));
r.post('/logout', (req, res) => { logout(res); res.json({ ok: true }); });

r.use(requireAuth);

r.get('/meta', (req, res) => res.json({ legs: LEGS, bases: BASES, charges: CHARGE_CODES.map(({ synonyms, ...c }) => c), modes: MODES, incoterms: INCOTERMS, currencies: CURRENCIES, containerTypes: CONTAINER_TYPES }));

// ---------- users ----------
r.get('/users', requireAdmin, h(async (req, res) => res.json(await listUsers())));
r.post('/users', requireAdmin, h(async (req, res) => res.json(await createUser(req.body))));

// ---------- settings ----------
r.get('/settings', h(async (req, res) => res.json(await getAllPublic())));
r.put('/settings/ai', requireAdmin, h(async (req, res) => { await saveAi(req.body); res.json(await getAllPublic()); }));
r.put('/settings/:key', requireAdmin, h(async (req, res) => {
  if (!['company', 'fx', 'pricing'].includes(req.params.key)) return res.status(400).json({ error: 'Unknown setting' });
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
r.post('/mailboxes', requireAdmin, h(async (req, res) => res.json(publicMb(await saveMailbox(null, req.body)))));
r.put('/mailboxes/:id', requireAdmin, h(async (req, res) => res.json(publicMb(await saveMailbox(id(req), req.body)))));
r.delete('/mailboxes/:id', requireAdmin, h(async (req, res) => { await q('UPDATE mailboxes SET active=false WHERE id=$1', [id(req)]); res.json({ ok: true }); }));
r.post('/mailboxes/:id/test', requireAdmin, h(async (req, res) => {
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
const PARTY_FIELDS = ['company', 'contact', 'email', 'cc', 'country', 'city', 'agent_type', 'services', 'ports', 'notes', 'active', 'is_agent', 'is_customer', 'currency', 'margin_pct', 'tax_pct'];
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
    count(*) FILTER (WHERE created_at > now()-interval '30 days')::int AS last30 FROM rfqs`);
  const review = await one(`SELECT count(*)::int AS n FROM agent_quotes q JOIN rfqs r ON r.id=q.rfq_id WHERE NOT q.verified AND NOT q.superseded AND NOT q.declined AND r.status IN ('sent','quoting')`);
  const unmatched = await one(`SELECT count(*)::int AS n FROM emails WHERE direction='in' AND invite_id IS NULL AND parse_status='unmatched'`);
  const errors = await one(`SELECT count(*)::int AS n FROM emails WHERE parse_status='error'`);
  res.json({ ...s, needs_review: review.n, unmatched: unmatched.n, parse_errors: errors.n });
}));

r.get('/rfqs', h(async (req, res) => {
  res.json(await q(`SELECT r.*, p.company AS requester_name,
    (SELECT count(*)::int FROM rfq_invites i WHERE i.rfq_id=r.id) AS invites,
    (SELECT count(*)::int FROM rfq_invites i WHERE i.rfq_id=r.id AND i.replied_at IS NOT NULL) AS replies,
    (SELECT count(*)::int FROM agent_quotes q WHERE q.rfq_id=r.id AND NOT q.superseded AND NOT q.verified AND NOT q.declined) AS to_review
    FROM rfqs r LEFT JOIN agents p ON p.id=r.requester_id ORDER BY r.id DESC LIMIT 500`));
}));
r.post('/enquiry/parse', h(async (req, res) => res.json(await parseEnquiry(req.body.text || ''))));
r.post('/rfqs', h(async (req, res) => res.json(await createRfq(req.body, req.user.id))));
r.get('/rfqs/:id', h(async (req, res) => {
  const d = await loadRfq(id(req));
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(d);
}));
r.put('/rfqs/:id', h(async (req, res) => res.json(await updateRfq(id(req), req.body))));
r.post('/rfqs/:id/status', h(async (req, res) => { await q('UPDATE rfqs SET status=$1 WHERE id=$2', [req.body.status, id(req)]); res.json({ ok: true }); }));
r.post('/rfqs/:id/send', h(async (req, res) => res.json(await sendRfq(id(req)))));
r.post('/rfqs/:id/own-rates', h(async (req, res) => res.json(await ownRatesInvite(id(req)))));
r.get('/rfqs/:id/compare', h(async (req, res) => res.json(await compareRfq(id(req), req.query.currency))));
r.post('/rfqs/:id/award', h(async (req, res) => res.json(await awardRfq(id(req), req.body.selection, req.body))));

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
r.get('/inbox/unmatched', h(async (req, res) => res.json(await q(`SELECT id,from_addr,subject,at,left(body_text,400) AS preview FROM emails WHERE direction='in' AND invite_id IS NULL AND rfq_id IS NULL AND coalesce(parse_status,'') <> 'ignored' ORDER BY at DESC LIMIT 200`))));
r.get('/emails/:id', h(async (req, res) => res.json(await one('SELECT * FROM emails WHERE id=$1', [id(req)]))));
r.post('/emails/:id/assign', h(async (req, res) => res.json(await assignEmail(id(req), req.body.invite_id))));
r.post('/emails/:id/parse', h(async (req, res) => res.json(await parseEmail(id(req)))));
r.post('/emails/:id/create-rfq', h(async (req, res) => res.json(await createRfqFromEmail(id(req)))));
r.post('/emails/:id/ignore', h(async (req, res) => { await q("UPDATE emails SET parse_status='ignored' WHERE id=$1", [id(req)]); res.json({ ok: true }); }));
r.get('/attachments/:id', h(async (req, res) => {
  const a = await one('SELECT * FROM attachments WHERE id=$1', [id(req)]);
  if (!a) return res.status(404).end();
  res.setHeader('Content-Type', a.content_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(a.filename || 'file').replace(/"/g, '')}"`);
  res.send(a.data);
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
  res.json({ ok: true });
}));

// ---------- customer quotes ----------
r.post('/rfqs/:id/customer-quote/preview', h(async (req, res) => res.json(await previewCustomerQuote(id(req), req.body))));
r.post('/rfqs/:id/customer-quotes', h(async (req, res) => res.json(await saveCustomerQuote(id(req), req.body))));
r.get('/customer-quotes/:id/pdf', h(async (req, res) => {
  const cq = await one('SELECT ref FROM customer_quotes WHERE id=$1', [id(req)]);
  const pdf = await renderPdf(id(req));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${cq.ref}.pdf"`);
  res.send(pdf);
}));
r.post('/customer-quotes/:id/send', h(async (req, res) => { await emailCustomerQuote(id(req), req.body || {}); res.json({ ok: true }); }));
r.post('/customer-quotes/:id/accept', h(async (req, res) => {
  const cq = await one('SELECT * FROM customer_quotes WHERE id=$1', [id(req)]);
  await q("UPDATE customer_quotes SET status='accepted', accepted_at=now() WHERE id=$1", [cq.id]);
  const results = req.body.award === false ? [] : await awardRfq(cq.rfq_id, cq.selection, { sendRegrets: req.body.sendRegrets !== false, note: req.body.note });
  res.json({ ok: true, results });
}));

export default r;
