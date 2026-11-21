// Cost-leakage check: agents' invoices for a job are read by the AI and matched against the costs
// that were quoted and booked (engines/invoiceCheck.js), before anyone pays them.
import { q, one } from '../db.js';
import { checkInvoice, disputeText } from '../engines/invoiceCheck.js';
import { convert } from '../engines/costing.js';
import { blocksFor } from './extract.js';
import { readAgentInvoice } from './ai.js';
import { getFx, getSetting, getAiKey } from './settings.js';
import { audit } from './audit.js';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** Agents that have buy costs on this job (the likely senders of invoices). */
const jobAgents = (jobId) => q(`SELECT DISTINCT a.id, a.company, a.email FROM job_costs c JOIN agents a ON a.id=c.agent_id WHERE c.job_id=$1 AND c.kind IN ('buy','buy_replaced')
  UNION SELECT a.id, a.company, a.email FROM bookings b JOIN agents a ON a.id=b.agent_id WHERE b.job_id=$1`, [jobId]);

function guessAgent(agents, read, fromAddr) {
  const mail = String(fromAddr || '').toLowerCase();
  const byMail = agents.find((a) => a.email && mail.includes(a.email.toLowerCase()));
  if (byMail) return byMail.id;
  const sup = String(read.supplier || '').toLowerCase();
  const byName = agents.find((a) => sup && (sup.includes(a.company.toLowerCase().slice(0, 8)) || a.company.toLowerCase().includes(sup.slice(0, 8))));
  if (byName) return byName.id;
  return agents.length === 1 ? agents[0].id : null;
}

/** Run the check for an invoice row against the job's current buy lines for its agent. */
async function runCheck(inv) {
  const fx = await getFx();
  const expected = inv.agent_id
    ? await q("SELECT id, description, charge_code, leg, amount, currency FROM job_costs WHERE job_id=$1 AND agent_id=$2 AND kind='buy' AND source <> 'invoice'", [inv.job_id, inv.agent_id])
    : [];
  // invoices already approved for this agent on this job have used up those lines
  const billed = await q("SELECT result FROM agent_invoices WHERE job_id=$1 AND agent_id=$2 AND id<>$3 AND status IN ('ok','approved')", [inv.job_id, inv.agent_id, inv.id || 0]);
  const used = new Set(billed.flatMap((b) => (b.result?.matches || []).map((m) => m.expected?.id).filter(Boolean)));
  const result = checkInvoice({ currency: inv.currency || fx.base, total: inv.total, tax: inv.tax, lines: inv.lines || [] }, expected.filter((e) => !used.has(e.id)), (a, from, to) => convert(a, from, to, fx));
  if (!inv.agent_id) result.findings.unshift({ type: 'agent', severity: 'high', amount: 0, text: 'Which agent sent this invoice? Choose the agent so it can be checked against their quote.' });
  if (inv.invoice_no && inv.agent_id) {
    const dup = await one('SELECT j.ref FROM agent_invoices i JOIN jobs j ON j.id=i.job_id WHERE i.agent_id=$1 AND lower(i.invoice_no)=lower($2) AND i.id<>$3 LIMIT 1', [inv.agent_id, inv.invoice_no, inv.id || 0]);
    if (dup) result.findings.unshift({ type: 'duplicate', severity: 'high', amount: 0, text: `Invoice ${inv.invoice_no} was already entered on ${dup.ref}: possible duplicate` });
  }
  if (result.findings.some((f) => f.severity === 'high')) result.status = 'to_check';
  return result;
}

async function save(inv, result) {
  const status = inv.status && ['disputed', 'approved'].includes(inv.status) ? inv.status : result.status;
  return one(`UPDATE agent_invoices SET agent_id=$2, invoice_no=$3, invoice_date=$4, currency=$5, total=$6, tax=$7, lines=$8, result=$9, leakage=$10, status=$11 WHERE id=$1 RETURNING *`,
    [inv.id, inv.agent_id, inv.invoice_no, inv.invoice_date, inv.currency, inv.total, inv.tax, JSON.stringify(inv.lines || []), result, result.leakage, status]);
}

/**
 * Read an invoice for a job from an uploaded job file or an email attachment, check it and store it.
 * source: { file_id } | { attachment_id }
 */
export async function readInvoice(jobId, source, user = null) {
  if (!(await getAiKey())) throw err('AI is not set up: add the AI key in Settings → AI, or enter the invoice lines by hand.', 409);
  let doc;
  let fromAddr = null;
  let emailId = null;
  if (source.file_id) doc = await one('SELECT * FROM job_files WHERE id=$1 AND job_id=$2', [source.file_id, jobId]);
  else if (source.attachment_id) {
    doc = await one('SELECT a.*, e.from_addr, e.id AS mail_id FROM attachments a JOIN emails e ON e.id=a.email_id WHERE a.id=$1', [source.attachment_id]);
    fromAddr = doc?.from_addr; emailId = doc?.mail_id;
  }
  if (!doc) throw err('File not found', 404);
  const job = await one('SELECT ref FROM jobs WHERE id=$1', [jobId]);
  const read = await readAgentInvoice({ blocks: await blocksFor([doc]), hint: `Our job reference is ${job?.ref}.` });
  if (!read.is_invoice) throw err('This does not look like an invoice or debit note.');
  const agentId = source.agent_id ? Number(source.agent_id) : guessAgent(await jobAgents(jobId), read, fromAddr);
  const fx = await getFx();
  const row = await one(`INSERT INTO agent_invoices(job_id,agent_id,file_id,attachment_id,email_id,invoice_no,invoice_date,currency,total,tax,refs,supplier,lines,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
  [jobId, agentId, source.file_id || null, source.attachment_id || null, emailId, read.invoice_no, read.invoice_date, read.currency || fx.base, read.total, read.tax, read.references, read.supplier, JSON.stringify(read.lines), user?.id || null]);
  const saved = await save(row, await runCheck(row));
  await audit(user, 'invoice.read', { entity: 'job', entityId: jobId, jobId, summary: `Agent invoice ${read.invoice_no || ''} read: ${saved.result.findings.filter((f) => f.severity === 'high').length} issue(s), difference ${saved.leakage} ${saved.currency}` });
  return saved;
}

/** Fix the agent or the lines by hand, then check again. */
export async function updateInvoice(id, body, user) {
  const inv = await one('SELECT * FROM agent_invoices WHERE id=$1', [id]);
  if (!inv) throw err('Invoice not found', 404);
  const next = { ...inv };
  for (const k of ['agent_id', 'invoice_no', 'invoice_date', 'currency', 'total', 'tax', 'lines']) if (body[k] !== undefined) next[k] = body[k] === '' ? null : body[k];
  if (body.agent_id !== undefined) next.agent_id = body.agent_id ? Number(body.agent_id) : null;
  next.status = 'to_check';
  const saved = await save(next, await runCheck(next));
  await audit(user, 'invoice.update', { entity: 'job', entityId: inv.job_id, jobId: inv.job_id, summary: `Agent invoice ${saved.invoice_no || ''} edited and re-checked` });
  return saved;
}

/** Create an invoice entered by hand (no AI). */
export async function createInvoice(jobId, body, user) {
  const fx = await getFx();
  const row = await one('INSERT INTO agent_invoices(job_id,agent_id,invoice_no,invoice_date,currency,total,tax,lines,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [jobId, body.agent_id || null, body.invoice_no || null, body.invoice_date || null, body.currency || fx.base, body.total ?? null, body.tax || 0, JSON.stringify(body.lines || []), user?.id || null]);
  return save(row, await runCheck(row));
}

/**
 * approve: pay it; extras and over-charges the desk accepts are added to the job's buy costs so
 * the job profit stays true. dispute: hold it and get the email text for the agent.
 */
export async function decideInvoice(id, { decision, note, add_costs = true }, user) {
  const inv = await one('SELECT i.*, a.company AS agent, j.ref AS job_ref FROM agent_invoices i LEFT JOIN agents a ON a.id=i.agent_id JOIN jobs j ON j.id=i.job_id WHERE i.id=$1', [id]);
  if (!inv) throw err('Invoice not found', 404);
  if (!['approved', 'disputed'].includes(decision)) throw err('Approve or dispute');
  if (decision === 'approved' && add_costs) {
    await q("DELETE FROM job_costs WHERE job_id=$1 AND source='invoice' AND description LIKE $2", [inv.job_id, `%[inv ${inv.id}]`]);
    for (const f of (inv.result?.findings || []).filter((x) => ['extra', 'over'].includes(x.type) && x.amount > 0)) {
      await q("INSERT INTO job_costs(job_id,kind,leg,description,amount,currency,agent_id,source) VALUES($1,'buy',NULL,$2,$3,$4,$5,'invoice')", [inv.job_id, `${f.type === 'extra' ? 'Extra' : 'Over quote'}: ${f.text.slice(0, 160)} [inv ${inv.id}]`, f.amount, inv.currency, inv.agent_id]);
    }
  }
  const saved = await one('UPDATE agent_invoices SET status=$2, note=$3, decided_by=$4, decided_at=now() WHERE id=$1 RETURNING *', [id, decision, note || null, user?.id || null]);
  await audit(user, `invoice.${decision}`, { entity: 'job', entityId: inv.job_id, jobId: inv.job_id, summary: `Agent invoice ${inv.invoice_no || ''} from ${inv.agent || 'agent'} ${decision}${inv.leakage ? ` (difference ${inv.leakage} ${inv.currency})` : ''}` });
  const company = await getSetting('company');
  return { ...saved, dispute_text: decision === 'disputed' ? disputeText(inv, inv.result, { agent: inv.agent, job: inv.job_ref, company: company.name }) : null };
}

export const listInvoices = (jobId) => q('SELECT i.*, a.company AS agent, a.email AS agent_email FROM agent_invoices i LEFT JOIN agents a ON a.id=i.agent_id WHERE i.job_id=$1 ORDER BY i.id DESC', [jobId]);
export const invoicesToCheck = () => q(`SELECT i.id, i.job_id, j.ref AS job_ref, a.company AS agent, i.invoice_no, i.leakage, i.currency, i.created_at
  FROM agent_invoices i JOIN jobs j ON j.id=i.job_id LEFT JOIN agents a ON a.id=i.agent_id WHERE i.status='to_check' ORDER BY i.id DESC LIMIT 100`);
export async function deleteInvoice(id, user) {
  const inv = await one('DELETE FROM agent_invoices WHERE id=$1 RETURNING job_id, invoice_no, id', [id]);
  if (!inv) throw err('Invoice not found', 404);
  await q("DELETE FROM job_costs WHERE job_id=$1 AND source='invoice' AND description LIKE $2", [inv.job_id, `%[inv ${inv.id}]`]);
  await audit(user, 'invoice.delete', { entity: 'job', entityId: inv.job_id, jobId: inv.job_id, summary: `Agent invoice ${inv.invoice_no || ''} deleted` });
  return { ok: true };
}

/** An email on a job that looks like an invoice: read its attachments automatically. */
export async function maybeReadInvoiceEmail(email, attachments) {
  if (!email.job_id || !attachments?.length) return;
  const text = `${email.subject || ''} ${attachments.map((a) => a.filename).join(' ')}`;
  if (!/invoice|\binv\b|debit note|\bd\/?n\b|tax invoice/i.test(text)) return;
  if (!(await getAiKey())) return;
  for (const a of attachments.filter((x) => /pdf|image/i.test(x.content_type || '') || /\.(pdf|png|jpe?g)$/i.test(x.filename || ''))) {
    await readInvoice(email.job_id, { attachment_id: a.id }).catch((e) => console.error('invoice auto-read', email.id, e.message));
  }
}
