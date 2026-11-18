// Enquiry intake: turn a request-for-quote email (from a customer or a partner agent) into a draft RFQ.
import { q, one, currentTenant } from '../db.js';
import { assertCanCreateRfq } from './tenants.js';
import { parseEnquiry } from './ai.js';
import { createRfq } from './rfq.js';
import { applyRateCards } from './rateCards.js';

function companyFromAddress(addr = '') {
  const domain = addr.split('@')[1] || addr;
  const name = domain.split('.')[0] || domain;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Find the party by email (main or CC address); create a new customer contact if unknown. */
export async function findOrCreateParty(email, displayName) {
  const addr = String(email || '').toLowerCase().trim();
  if (!addr) return null;
  const found = await one(
    "SELECT * FROM agents WHERE lower(email)=$1 OR lower(coalesce(cc,'')) LIKE '%'||$1||'%' ORDER BY active DESC, id LIMIT 1",
    [addr]
  );
  if (found) return found;
  return one(
    "INSERT INTO agents(company, contact, email, is_agent, is_customer, source, notes) VALUES($1,$2,$3,false,true,'email','Created automatically from an incoming enquiry. Tick \"partner agent\" if they are an agent.') RETURNING *",
    [companyFromAddress(addr), displayName || null, addr]
  );
}

export async function createRfqFromEmail(emailId, { mailboxId } = {}) {
  const email = await one('SELECT * FROM emails WHERE id=$1', [emailId]);
  if (!email) throw new Error('Email not found');
  if (email.rfq_id) return one('SELECT * FROM rfqs WHERE id=$1', [email.rfq_id]);
  await assertCanCreateRfq(currentTenant());
  const parsed = await parseEnquiry(`From: ${email.from_addr}\nSubject: ${email.subject}\n\n${email.body_text || ''}`);
  const party = await findOrCreateParty(email.from_addr, parsed.customer_name);
  const role = party?.is_agent ? 'agent' : 'customer';
  const rfq = await createRfq({
    ...parsed,
    containers: parsed.containers || [],
    legs: parsed.legs?.length ? parsed.legs : ['freight'],
    notes: [parsed.notes, party?.is_agent && parsed.customer_name ? `Their customer: ${parsed.customer_name}` : null].filter(Boolean).join('\n') || null,
    requester_id: party?.id || null,
    requester_role: role,
    requester_ref: parsed.requester_reference || null,
    source_email_id: email.id,
    mailbox_id: mailboxId || email.mailbox_id || null,
  });
  await q("UPDATE rfqs SET status='new' WHERE id=$1", [rfq.id]);
  await q("UPDATE emails SET rfq_id=$1, kind='enquiry', parse_status='enquiry', parse_error=NULL WHERE id=$2", [rfq.id, email.id]);
  await applyRateCards(rfq.id).catch((e) => console.error('rate cards', e.message));
  return rfq;
}
