// First-run setup guide: live checklist of what a new company still needs to do.
import { one } from '../db.js';
import { getSetting, getAiKey } from './settings.js';

const n = async (sql) => (await one(sql)).n;

export async function onboardingStatus() {
  const company = await getSetting('company');
  const state = await getSetting('onboarding');
  const mailbox = await one("SELECT count(*) FILTER (WHERE smtp_pass_enc IS NOT NULL)::int AS send, count(*) FILTER (WHERE imap_pass_enc IS NOT NULL)::int AS receive FROM mailboxes WHERE active");
  const agents = await n('SELECT count(*)::int AS n FROM agents WHERE is_agent AND active');
  const customers = await n('SELECT count(*)::int AS n FROM agents WHERE is_customer AND active');
  const cards = await n('SELECT count(*)::int AS n FROM rate_cards WHERE active');
  const users = await n('SELECT count(*)::int AS n FROM users WHERE disabled_at IS NULL');
  const rfqSent = await n("SELECT count(*)::int AS n FROM rfq_invites WHERE source='email' AND sent_at IS NOT NULL");
  const quoteSent = await n('SELECT count(*)::int AS n FROM customer_quotes WHERE sent_at IS NOT NULL');
  const ai = !!(await getAiKey());
  const steps = [
    { key: 'company', title: 'Add your company details', hint: 'Name, address, GSTIN, logo and bank details appear on every quotation.', done: !!(company.name && company.name !== 'Your Company Pvt Ltd' && company.address), link: '/settings/company', action: 'Company details' },
    { key: 'mailbox', title: 'Connect your RFQ mailbox', hint: 'Quayly emails partner agents from this address and reads their replies.', done: mailbox.send > 0 && mailbox.receive > 0, partial: mailbox.send > 0 || mailbox.receive > 0, link: '/settings/mailboxes', action: 'Connect mailbox' },
    { key: 'ai', title: 'Turn on AI reading', hint: 'Reads agent replies and enquiries (email text, PDF, Excel, photos) for you.', done: ai, link: '/settings/ai', action: 'AI settings' },
    { key: 'agents', title: 'Add at least 3 partner agents', hint: 'The agents you ask for rates, with the ports and legs they cover.', done: agents >= 3, progress: `${Math.min(agents, 3)}/3`, link: '/settings/partner-agents', action: 'Add agents' },
    { key: 'customers', title: 'Add a customer', hint: 'Or let them arrive automatically when they email you an enquiry.', done: customers >= 1, link: '/settings/customers', action: 'Add customer' },
    { key: 'rates', title: 'Load your rate cards (optional)', hint: 'Upload your Excel sheet or a carrier rate sheet; matching RFQs are priced instantly.', done: cards >= 1, optional: true, link: '/settings/rate-cards', action: 'Rate cards' },
    { key: 'rfq', title: 'Send your first RFQ to agents', hint: "Paste a customer's enquiry; AI fills in the details.", done: rfqSent > 0, link: '/rfqs/new', action: 'New RFQ' },
    { key: 'quote', title: 'Send your first quotation', hint: 'Compare agent replies, add your margin, email the PDF.', done: quoteSent > 0, link: '/', action: 'Open RFQs' },
    { key: 'team', title: 'Invite your team (optional)', hint: 'Add pricing staff and a manager to approve low-margin quotes.', done: users > 1, optional: true, link: '/settings/users', action: 'Invite team' },
  ];
  const required = steps.filter((s) => !s.optional);
  const doneCount = required.filter((s) => s.done).length;
  return { steps, done: doneCount, total: required.length, complete: doneCount === required.length, dismissed: !!state.dismissed };
}
