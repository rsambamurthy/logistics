// Rate sheets that arrive by email: the AI reads them into rate cards, matched against the cards
// already stored for that agent. The result waits for review (or is applied straight away when the
// company turns that on in Settings → AI). Applying updates the matching card or adds a new one.
import { q, one, tx } from '../db.js';
import { blocksFor } from './extract.js';
import { readRateSheet } from './ai.js';
import { getCard, saveCard } from './rateCards.js';
import { getSetting } from './settings.js';
import { audit } from './audit.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sameLane = (a, b) => a.leg === b.leg && (a.mode || '') === (b.mode || '') && norm(a.origin) === norm(b.origin) && norm(a.destination) === norm(b.destination) && norm(a.carrier) === norm(b.carrier);
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** The partner agent who sent this email (by their email address or cc list). */
async function agentFor(fromAddr) {
  const m = String(fromAddr || '').match(/[^\s<>"]+@[^\s<>"]+/);
  if (!m) return null;
  const mail = m[0].toLowerCase();
  return one("SELECT id, company FROM agents WHERE lower(email)=$1 OR $1 = ANY(string_to_array(lower(replace(coalesce(cc,''),' ','')), ',')) ORDER BY id LIMIT 1", [mail]);
}

/** Read the rates in an email and store them as a proposal (new cards, or updates to existing ones). */
export async function readRatesFromEmail(emailId, user = null) {
  const email = await one('SELECT * FROM emails WHERE id=$1', [emailId]);
  if (!email) throw err('Email not found', 404);
  const atts = await q('SELECT * FROM attachments WHERE email_id=$1', [email.id]);
  const blocks = [{ type: 'text', text: `From: ${email.from_addr}\nSubject: ${email.subject}\nReceived: ${email.at || ''}\n\n${(email.body_text || '').slice(0, 40000)}` }, ...(await blocksFor(atts))];
  await q("UPDATE emails SET kind='rate_sheet', parse_status='rate_reading', parse_error=NULL WHERE id=$1", [email.id]);
  let read;
  try {
    read = await readRateSheet({ blocks, hint: `emailed by ${email.from_addr}` });
  } catch (e) {
    await q("UPDATE emails SET parse_status='error', parse_error=$1 WHERE id=$2", [e.message.slice(0, 500), email.id]);
    throw e;
  }
  const agent = await agentFor(email.from_addr);
  const existing = agent ? await q('SELECT * FROM rate_cards WHERE vendor_id=$1', [agent.id]) : [];
  const today = new Date().toISOString().slice(0, 10);
  const cards = read.cards.filter((c) => c.lines.length).map((c) => {
    const match = existing.find((x) => sameLane(x, c));
    // rates starting later than today become a new card, so the current rates stay in use until then
    if (match && c.valid_from && c.valid_from > today) return { ...c, match_id: null, follows_id: match.id, follows_name: match.name, include: true };
    return { ...c, match_id: match?.id || null, match_name: match?.name || null, include: true };
  });
  const proposal = { agent_id: agent?.id || null, agent_name: agent?.company || null, notes: read.notes, cards, read_at: new Date().toISOString() };
  const status = cards.length ? 'rates_pending' : 'no_rates';
  await q('UPDATE emails SET rate_proposal=$1, parse_status=$2, rfq_id=NULL, invite_id=NULL WHERE id=$3', [proposal, status, email.id]);
  if (user) await audit(user, 'rates.read', { entity: 'email', entityId: email.id, summary: `AI read ${cards.length} rate card(s) from ${email.from_addr}` });
  if (cards.length && !user && (await getSetting('ai')).auto_apply_rates) return applyRateProposal(email.id, { auto: true });
  return { id: email.id, status, proposal };
}

/** Emails with rates waiting for review, newest first. */
export async function pendingRateMail() {
  return q("SELECT id, from_addr, subject, at, rate_proposal FROM emails WHERE parse_status='rates_pending' ORDER BY at DESC NULLS LAST, id DESC LIMIT 100");
}

/** Old lines of the cards a proposal would update, so the reviewer sees old → new. */
export async function rateProposal(emailId) {
  const email = await one('SELECT id, from_addr, subject, at, parse_status, rate_proposal FROM emails WHERE id=$1', [emailId]);
  if (!email?.rate_proposal) throw err('No rates were read from this email', 404);
  for (const c of email.rate_proposal.cards) if (c.match_id) c.current = await getCard(c.match_id);
  return email;
}

/**
 * Apply a proposal: each included card updates the matching card (rates, validity, details)
 * or becomes a new card for that agent. `agentId` lets the reviewer pick the agent when the
 * sender was not recognised; `cards` lets them edit or leave out cards before applying.
 */
export async function applyRateProposal(emailId, { cards, agentId, user = null, auto = false } = {}) {
  const email = await one('SELECT * FROM emails WHERE id=$1', [emailId]);
  if (!email?.rate_proposal) throw err('No rates were read from this email', 404);
  if (email.parse_status === 'rates_applied') throw err('These rates were already applied');
  const p = email.rate_proposal;
  const vendorId = agentId !== undefined ? agentId || null : p.agent_id;
  const list = (cards || p.cards).filter((c) => c.include !== false);
  if (!list.length) throw err('Choose at least one card to apply');
  const done = [];
  await tx(async (t) => {
    for (const c of list) {
      const target = c.match_id ? await t.one('SELECT * FROM rate_cards WHERE id=$1', [c.match_id]) : null;
      const card = target && (target.vendor_id || null) === vendorId
        ? { ...target, ...pick(c), name: target.name, id: target.id, source: 'email', notes: note(target.notes, email) }
        : { ...pick(c), id: undefined, vendor_id: vendorId, source: 'email', notes: note(null, email) };
      const saved = await saveCard(card, t);
      done.push({ id: saved.id, name: saved.name, updated: !!card.id });
    }
    await t.q("UPDATE emails SET parse_status='rates_applied', rate_proposal = rate_proposal || $1::jsonb WHERE id=$2", [{ applied: done, applied_at: new Date().toISOString(), applied_auto: auto }, email.id]);
  });
  await audit(user, 'rates.apply', { entity: 'email', entityId: email.id, summary: `${auto ? 'Automatically applied' : 'Applied'} rates from ${email.from_addr}: ${done.filter((d) => d.updated).length} card(s) updated, ${done.filter((d) => !d.updated).length} added` });
  return { id: email.id, status: 'rates_applied', applied: done };
}

export async function dismissRateProposal(emailId, user) {
  await q("UPDATE emails SET parse_status='rates_dismissed' WHERE id=$1 AND parse_status='rates_pending'", [emailId]);
  await audit(user, 'rates.dismiss', { entity: 'email', entityId: emailId, summary: 'Dismissed rates read from email' });
  return { ok: true };
}

const pick = (c) => ({
  name: c.name, leg: c.leg, mode: c.mode, origin: c.origin, destination: c.destination, carrier: c.carrier,
  valid_from: c.valid_from, valid_to: c.valid_to, transit_days: c.transit_days, free_days: c.free_days, active: true, lines: c.lines,
});
const note = (prev, email) => `${prev ? `${prev}\n` : ''}Rates from email "${String(email.subject || '').slice(0, 120)}" (${email.from_addr}), ${new Date().toISOString().slice(0, 10)}`.slice(-2000);
