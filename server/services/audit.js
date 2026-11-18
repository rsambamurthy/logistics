// Audit log: who did what, when. One middleware records every change made through the API;
// audit() records automatic (system) actions.
import { q, one, runAsTenant } from '../db.js';

/** Record one entry in the current tenant. user = { id, name } or null for automatic actions. */
export async function audit(user, action, { entity = null, entityId = null, rfqId = null, jobId = null, summary = null, details = null, ip = null } = {}) {
  try {
    await q('INSERT INTO audit_log(user_id,user_name,action,entity,entity_id,rfq_id,summary,details,ip,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [user?.id || null, user ? user.name || user.email : 'Quayly (automatic)', action, entity, entityId, rfqId, summary, details, ip, jobId]);
  } catch (e) {
    console.error('audit failed', e.message);
  }
}

const rfqOf = {
  invite: (id) => one('SELECT rfq_id FROM rfq_invites WHERE id=$1', [id]),
  agentQuote: (id) => one('SELECT rfq_id FROM agent_quotes WHERE id=$1', [id]),
  customerQuote: (id) => one('SELECT rfq_id, ref FROM customer_quotes WHERE id=$1', [id]),
  email: (id) => one('SELECT rfq_id, job_id FROM emails WHERE id=$1', [id]),
  job: (id) => one('SELECT rfq_id, id AS job_id, ref FROM jobs WHERE id=$1', [id]),
  booking: (id) => one('SELECT j.rfq_id, j.id AS job_id, j.ref FROM bookings b JOIN jobs j ON j.id=b.job_id WHERE b.id=$1', [id]),
  jobCost: (id) => one('SELECT j.rfq_id, j.id AS job_id, j.ref FROM job_costs c JOIN jobs j ON j.id=c.job_id WHERE c.id=$1', [id]),
  jobFile: (id) => one('SELECT j.rfq_id, j.id AS job_id, j.ref FROM job_files f JOIN jobs j ON j.id=f.job_id WHERE f.id=$1', [id]),
};

// "METHOD /path" (as declared in the routers) -> how to describe it.
const P = (id) => Number(id) || null;
const ACTIONS = {
  'POST /rfqs': { action: 'Created RFQ', entity: 'rfq', rfq: (r, b) => b?.id, summary: (r, b) => b?.ref },
  'PUT /rfqs/:id': { action: 'Edited RFQ', entity: 'rfq', rfq: (r) => P(r.params.id) },
  'POST /rfqs/:id/status': { action: 'Changed RFQ status', entity: 'rfq', rfq: (r) => P(r.params.id), summary: (r) => `to ${r.body.status}` },
  'POST /rfqs/:id/send': { action: 'Emailed RFQ to partner agents', entity: 'rfq', rfq: (r) => P(r.params.id), summary: (r, b) => Array.isArray(b) ? `${b.filter((x) => x.ok).length} sent, ${b.filter((x) => !x.ok).length} failed` : null },
  'POST /rfqs/:id/duplicate': { action: 'Created alternative RFQ', entity: 'rfq', rfq: (r) => P(r.params.id), summary: (r, b) => b?.ref && `${b.ref} (${b.mode})` },
  'POST /rfqs/:id/apply-rate-cards': { action: 'Priced from rate cards', entity: 'rfq', rfq: (r) => P(r.params.id) },
  'POST /rfqs/:id/own-rates': { action: 'Added own rates', entity: 'rfq', rfq: (r) => P(r.params.id) },
  'POST /rfqs/:id/award': { action: 'Awarded RFQ', entity: 'rfq', rfq: (r) => P(r.params.id) },
  'POST /rfqs/:id/customer-quotes': { action: 'Created quotation', entity: 'customer_quote', rfq: (r) => P(r.params.id), summary: (r, b) => b?.ref && `${b.ref}${b.approval_status === 'pending' ? ' (awaiting approval)' : ''}` },
  'POST /invites/:id/send': { action: 'Emailed RFQ to agent', entity: 'invite', via: 'invite' },
  'POST /invites/:id/remind': { action: 'Sent reminder to agent', entity: 'invite', via: 'invite' },
  'POST /invites/:id/counter': { action: 'Sent counter-offer', entity: 'invite', via: 'invite' },
  'POST /invites/:id/manual-reply': { action: 'Logged agent reply', entity: 'invite', via: 'invite' },
  'POST /agent-quotes': { action: 'Entered agent quote', entity: 'agent_quote', rfq: (r, b) => b?.rfq_id },
  'PUT /agent-quotes/:id': { action: 'Checked / edited agent quote', entity: 'agent_quote', via: 'agentQuote' },
  'POST /agent-quotes/:id/remember': { action: 'Saved agent quote as rate card', entity: 'agent_quote', via: 'agentQuote' },
  'POST /emails/:id/assign': { action: 'Linked email to RFQ', entity: 'email', via: 'email' },
  'POST /emails/:id/parse': { action: 'Re-read email with AI', entity: 'email', via: 'email' },
  'POST /emails/:id/ignore': { action: 'Ignored email', entity: 'email' },
  'POST /emails/:id/create-rfq': { action: 'Created RFQ from email', entity: 'rfq', rfq: (r, b) => b?.id, summary: (r, b) => b?.ref },
  'POST /customer-quotes/:id/send': { action: 'Emailed quotation', entity: 'customer_quote', via: 'customerQuote' },
  'POST /customer-quotes/:id/follow-up': { action: 'Sent quotation follow-up', entity: 'customer_quote', via: 'customerQuote' },
  'POST /customer-quotes/:id/lost': { action: 'Marked quotation lost', entity: 'customer_quote', via: 'customerQuote', summary: (r) => r.body.reason },
  'POST /customer-quotes/:id/accept': { action: 'Quotation accepted, agents awarded', entity: 'customer_quote', via: 'customerQuote' },
  'POST /customer-quotes/:id/approval': { action: 'Approval decision', entity: 'customer_quote', via: 'customerQuote', summary: (r) => (r.body.approve ? 'approved' : 'not approved') + (r.body.note ? `: ${r.body.note}` : '') },
  'POST /customer-quotes/:id/job': { action: 'Opened job', entity: 'job', via: 'customerQuote', summary: (r, b) => b?.job?.ref },
  'PUT /jobs/:id': { action: 'Edited job', entity: 'job', via: 'job' },
  'POST /jobs/:id/milestone': { action: 'Updated job milestone', entity: 'job', via: 'job', summary: (r) => r.body.status },
  'POST /jobs/:id/send-bookings': { action: 'Sent booking requests', entity: 'job', via: 'job' },
  'POST /jobs/:id/notify-customer': { action: 'Sent booking confirmation to customer', entity: 'job', via: 'job' },
  'POST /jobs/:id/costs': { action: 'Added job cost', entity: 'job', via: 'job', summary: (r) => `${r.body.kind} ${r.body.description}: ${r.body.currency} ${r.body.amount}` },
  'POST /jobs/:id/files': { action: 'Uploaded job documents', entity: 'job', via: 'job' },
  'POST /bookings/:id/send': { action: 'Sent booking request', entity: 'booking', via: 'booking' },
  'PUT /bookings/:id': { action: 'Edited booking', entity: 'booking', via: 'booking', summary: (r) => r.body.status && `status ${r.body.status}` },
  'POST /emails/:id/read-booking': { action: 'Re-read booking reply with AI', entity: 'email', via: 'email' },
  'DELETE /job-costs/:id': { action: 'Deleted job cost', entity: 'job', via: 'jobCost' },
  'DELETE /job-files/:id': { action: 'Deleted job document', entity: 'job', via: 'jobFile' },
  'POST /agents': { action: 'Added contact', entity: 'party', summary: (r, b) => b?.company },
  'PUT /agents/:id': { action: 'Edited contact', entity: 'party', summary: (r, b) => b?.company },
  'POST /rate-cards': { action: 'Added rate card', entity: 'rate_card', summary: (r, b) => b?.name },
  'PUT /rate-cards/:id': { action: 'Edited rate card', entity: 'rate_card', summary: (r, b) => b?.name },
  'POST /rate-cards/:id/copy': { action: 'Copied rate card', entity: 'rate_card', summary: (r, b) => b?.name },
  'DELETE /rate-cards/:id': { action: 'Deleted rate card', entity: 'rate_card' },
  'POST /rate-cards/import': { action: 'Imported rate cards from Excel', entity: 'rate_card', summary: (r, b) => b && `${b.created} new, ${b.replaced} updated` },
  'POST /rate-cards/bulk': { action: 'Saved rate cards read by AI', entity: 'rate_card', summary: (r, b) => b && `${b.saved} card(s)` },
  'PUT /settings/:key': { action: 'Changed settings', entity: 'settings', summary: (r) => r.params.key },
  'PUT /settings/ai': { action: 'Changed AI settings', entity: 'settings' },
  'POST /mailboxes': { action: 'Added RFQ mailbox', entity: 'mailbox', summary: (r, b) => b?.from_email },
  'PUT /mailboxes/:id': { action: 'Edited RFQ mailbox', entity: 'mailbox', summary: (r, b) => b?.from_email },
  'DELETE /mailboxes/:id': { action: 'Deactivated RFQ mailbox', entity: 'mailbox' },
  'POST /users': { action: 'Added user', entity: 'user', summary: (r, b) => b && `${b.email} (${b.role})` },
  'POST /users/:id/resend-invite': { action: 'Resent user invite', entity: 'user' },
  'POST /billing/subscribe': { action: 'Chose subscription plan', entity: 'subscription', summary: (r) => r.body.plan_code },
  'POST /billing/cancel': { action: 'Cancelled subscription', entity: 'subscription' },
};

const SAFE_FIELDS = ['status', 'approve', 'option', 'reason', 'plan_code', 'role', 'mode', 'currency', 'margin_pct', 'tax_pct', 'language'];

/** Express middleware: after a successful change, write an audit entry. */
export function auditMiddleware(req, res, next) {
  if (req.method === 'GET' || !req.tenant) return next();
  const origJson = res.json.bind(res);
  res.json = (body) => {
    res.locals.auditBody = body;
    return origJson(body);
  };
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.route) return;
    const key = `${req.method} ${req.baseUrl.replace(/^\/api/, '')}${req.route.path}`;
    const def = ACTIONS[key];
    if (!def) return;
    const body = res.locals.auditBody;
    runAsTenant(req.tenant, async () => {
      let rfqId = def.rfq ? def.rfq(req, body) : null;
      let summary = def.summary ? def.summary(req, body) : null;
      let jobId = body?.job?.id || null;
      if (def.via && req.params.id) {
        const row = await rfqOf[def.via](Number(req.params.id)).catch(() => null);
        rfqId = row?.rfq_id || rfqId;
        jobId = row?.job_id || jobId;
        if (!summary && row?.ref) summary = row.ref;
      }
      const details = Object.fromEntries(SAFE_FIELDS.filter((f) => req.body?.[f] !== undefined).map((f) => [f, req.body[f]]));
      await audit(req.user, def.action, {
        entity: def.entity,
        entityId: Number(req.params.id) || body?.id || null,
        rfqId: rfqId || body?.job?.rfq_id || null,
        jobId,
        summary: summary ? String(summary).slice(0, 300) : null,
        details: Object.keys(details).length ? details : null,
        ip: req.ip,
      });
    }).catch(() => {});
  });
  next();
}

export async function listAudit({ rfq, job, search, user, days = 30, limit = 300 } = {}) {
  const where = ["at >= now() - ($1 || ' days')::interval"];
  const vals = [String(Math.min(Number(days) || 30, 3650))];
  if (rfq) { vals.push(Number(rfq)); where.push(`rfq_id=$${vals.length}`); }
  if (job) { vals.push(Number(job)); where.push(`job_id=$${vals.length}`); }
  if (user) { vals.push(Number(user)); where.push(`user_id=$${vals.length}`); }
  if (search) { vals.push(`%${search}%`); where.push(`(action ILIKE $${vals.length} OR summary ILIKE $${vals.length} OR user_name ILIKE $${vals.length})`); }
  vals.push(Math.min(Number(limit) || 300, 1000));
  return q(
    `SELECT a.*, r.ref AS rfq_ref FROM audit_log a LEFT JOIN rfqs r ON r.id=a.rfq_id WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT $${vals.length}`,
    vals
  );
}
