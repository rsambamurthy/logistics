// Which RFQ / job a record belongs to. Shared by the activity log and access checks.
import { one } from '../db.js';

export const recordOf = {
  rfq: (id) => one('SELECT id AS rfq_id, ref FROM rfqs WHERE id=$1', [id]),
  invite: (id) => one('SELECT rfq_id FROM rfq_invites WHERE id=$1', [id]),
  agentQuote: (id) => one('SELECT rfq_id FROM agent_quotes WHERE id=$1', [id]),
  customerQuote: (id) => one('SELECT rfq_id, ref FROM customer_quotes WHERE id=$1', [id]),
  email: (id) => one('SELECT rfq_id, job_id, invite_id FROM emails WHERE id=$1', [id]),
  job: (id) => one('SELECT rfq_id, id AS job_id, ref FROM jobs WHERE id=$1', [id]),
  booking: (id) => one('SELECT j.rfq_id, j.id AS job_id, j.ref FROM bookings b JOIN jobs j ON j.id=b.job_id WHERE b.id=$1', [id]),
  jobCost: (id) => one('SELECT j.rfq_id, j.id AS job_id, j.ref FROM job_costs c JOIN jobs j ON j.id=c.job_id WHERE c.id=$1', [id]),
  jobFile: (id) => one('SELECT j.rfq_id, j.id AS job_id, j.ref FROM job_files f JOIN jobs j ON j.id=f.job_id WHERE f.id=$1', [id]),
};

Object.assign(recordOf, {
  bl: (id) => one('SELECT j.rfq_id, j.id AS job_id, j.ref FROM bl_drafts b JOIN jobs j ON j.id=b.job_id WHERE b.id=$1', [id]),
  tracking: (id) => one('SELECT j.rfq_id, j.id AS job_id, j.ref FROM tracking t JOIN jobs j ON j.id=t.job_id WHERE t.id=$1', [id]),
  attachment: (id) => one('SELECT e.rfq_id, e.job_id, e.invite_id FROM attachments a JOIN emails e ON e.id=a.email_id WHERE a.id=$1', [id]),
  agentInvoice: (id) => one('SELECT j.rfq_id, j.id AS job_id, j.ref FROM agent_invoices i JOIN jobs j ON j.id=i.job_id WHERE i.id=$1', [id]),
});
