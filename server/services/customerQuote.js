// Customer (sell-side) quotation: build from selected agent quotes, render PDF, email.
import PDFDocument from 'pdfkit';
import { q, one } from '../db.js';
import { buildCustomerQuote } from '../engines/costing.js';
import { BASES } from '../engines/charges.js';
import { getFx, getSetting } from './settings.js';
import { loadRfq } from './rfq.js';
import { getMailbox, sendMail } from './mail.js';
import { customerQuoteEmail, quoteFollowupEmail, routeText } from './templates.js';

export async function previewCustomerQuote(rfqId, { selection, currency, margin_pct, tax_pct, leg_margins }) {
  const data = await loadRfq(rfqId);
  const fx = await getFx();
  const byId = Object.fromEntries(data.quotes.map((x) => [x.id, x]));
  return buildCustomerQuote(data.rfq, selection, byId, { currency, marginPct: margin_pct, taxPct: tax_pct, legMargins: leg_margins }, fx);
}

export async function saveCustomerQuote(rfqId, body) {
  const pricing = await getSetting('pricing');
  const snapshot = await previewCustomerQuote(rfqId, body);
  if (snapshot.totals.margin_pct_effective < Number(pricing.floor_margin_pct) && !body.approved_below_floor) {
    const err = new Error(`Margin ${snapshot.totals.margin_pct_effective}% is below the floor of ${pricing.floor_margin_pct}%. Approval needed.`);
    err.status = 400;
    throw err;
  }
  const rfq = await one('SELECT ref FROM rfqs WHERE id=$1', [rfqId]);
  const n = await one('SELECT count(*)::int AS n FROM customer_quotes WHERE rfq_id=$1', [rfqId]);
  const ref = `${rfq.ref.replace('RFQ', 'QT')}${n.n ? `-R${n.n}` : ''}`;
  const validUntil = body.valid_until || new Date(Date.now() + Number(pricing.quote_validity_days || 7) * 864e5).toISOString().slice(0, 10);
  return one(
    `INSERT INTO customer_quotes(rfq_id,ref,currency,selection,margin_pct,tax_pct,valid_until,terms,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [rfqId, ref, body.currency, body.selection, body.margin_pct || 0, body.tax_pct || 0, validUntil, body.terms ?? pricing.terms, snapshot]
  );
}

const money = (n, cur) => `${cur} ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const basisName = (b) => BASES.find((x) => x.code === b)?.name || b;

export async function renderPdf(quoteId) {
  const quote = await one('SELECT * FROM customer_quotes WHERE id=$1', [quoteId]);
  const rfq = await one('SELECT r.*, p.company AS requester_name FROM rfqs r LEFT JOIN agents p ON p.id=r.requester_id WHERE r.id=$1', [quote.rfq_id]);
  const company = await getSetting('company');
  const s = quote.snapshot;
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res) => doc.on('end', () => res(Buffer.concat(chunks))));

  const blue = '#0b2a4a';
  doc.fillColor(blue).fontSize(18).font('Helvetica-Bold').text(company.name || 'Quotation', 40, 40);
  doc.fontSize(9).font('Helvetica').fillColor('#444').text([company.address, company.phone, company.email, company.gstin && `GSTIN: ${company.gstin}`].filter(Boolean).join('  |  '), { width: 515 });
  doc.moveDown(0.8);
  doc.fillColor(blue).fontSize(14).font('Helvetica-Bold').text('QUOTATION', { continued: true }).font('Helvetica').fontSize(10).fillColor('#444').text(`   ${quote.ref}`);
  doc.moveDown(0.4);
  const info = [
    ['To', rfq.requester_name || '-'],
    ...(rfq.requester_ref ? [['Your reference', rfq.requester_ref]] : []),
    ['Date', new Date(quote.created_at).toDateString()],
    ['Valid until', quote.valid_until ? new Date(quote.valid_until).toDateString() : '-'],
    ['Route', routeText(rfq, '  >  ')],
    ['Mode', rfq.mode === 'AIR' ? 'Air' : `Sea ${rfq.mode}`],
    ['Equipment / cargo', rfq.mode === 'FCL' ? (rfq.containers || []).map((c) => `${c.qty} x ${c.type}`).join(', ') : [rfq.packages && `${rfq.packages} pkgs`, rfq.gross_weight_kg && `${rfq.gross_weight_kg} kg`, rfq.volume_cbm && `${rfq.volume_cbm} cbm`].filter(Boolean).join(' / ')],
    ['Incoterm', rfq.incoterm || '-'],
    ['Commodity', rfq.commodity || '-'],
  ];
  doc.fontSize(9);
  for (const [k, v] of info) {
    const y = doc.y;
    doc.font('Helvetica-Bold').fillColor('#333').text(k, 40, y, { width: 110 });
    doc.font('Helvetica').text(String(v || '-'), 150, y, { width: 405 });
  }
  doc.moveDown(0.8);

  const cols = [40, 250, 360, 400, 475];
  const header = (y) => {
    doc.rect(40, y - 3, 515, 16).fill(blue);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.5);
    ['Charge', 'Basis', 'Qty', 'Rate', 'Amount'].forEach((h, i) => doc.text(h, cols[i] + 3, y, { width: (cols[i + 1] || 555) - cols[i] - 6, align: i >= 2 ? 'right' : 'left' }));
    doc.fillColor('#222').font('Helvetica');
    return y + 18;
  };
  let y = doc.y;
  for (const sec of s.sections) {
    if (y > 720) { doc.addPage(); y = 50; }
    doc.font('Helvetica-Bold').fontSize(10).fillColor(blue).text(sec.name, 40, y);
    y = header(doc.y + 4);
    for (const l of sec.lines) {
      if (y > 760) { doc.addPage(); y = header(50); }
      doc.fontSize(8.5).fillColor('#222');
      const rowH = Math.max(doc.heightOfString(l.description, { width: 204 }), doc.heightOfString(basisName(l.basis), { width: 104 }), 11);
      doc.text(l.description, cols[0] + 3, y, { width: 204 });
      doc.text(basisName(l.basis), cols[1] + 3, y, { width: 104 });
      doc.text(String(Number(l.qty)), cols[2], y, { width: 36, align: 'right' });
      doc.text(Number(l.sell_rate).toFixed(2), cols[3], y, { width: 70, align: 'right' });
      doc.text(Number(l.sell_amount).toFixed(2), cols[4], y, { width: 77, align: 'right' });
      y = y + rowH + 5;
      doc.moveTo(40, y - 2).lineTo(555, y - 2).strokeColor('#e1e6ee').lineWidth(0.5).stroke();
    }
    doc.font('Helvetica-Bold').text(`Subtotal  ${money(sec.subtotal, s.currency)}`, 300, y + 2, { width: 252, align: 'right' });
    y = doc.y + 10;
  }
  if (y > 700) { doc.addPage(); y = 50; }
  const tot = s.totals;
  const rows = [['Total', money(tot.sell, s.currency)]];
  if (tot.tax) rows.push([`Tax (${tot.tax_pct}%)`, money(tot.tax, s.currency)]);
  rows.push(['Grand total', money(tot.grand_total, s.currency)]);
  for (const [k, v] of rows) {
    doc.font(k === 'Grand total' ? 'Helvetica-Bold' : 'Helvetica').fontSize(k === 'Grand total' ? 11 : 9.5).fillColor(blue).text(`${k}:  ${v}`, 300, y, { width: 252, align: 'right' });
    y = doc.y + 4;
  }
  if (quote.terms) {
    doc.moveDown(1.2).font('Helvetica-Bold').fontSize(9).fillColor('#333').text('Terms & conditions', 40);
    doc.font('Helvetica').fontSize(8.5).fillColor('#444').text(quote.terms, 40, doc.y + 2, { width: 515 });
  }
  doc.end();
  return done;
}

/** Send something to the RFQ's requester, inside their own enquiry thread when there is one. */
async function sendToRequester(quote, build, { to, cc, subject, text, attachments, kind }) {
  const rfq = await one('SELECT * FROM rfqs WHERE id=$1', [quote.rfq_id]);
  const requester = rfq.requester_id ? await one('SELECT * FROM agents WHERE id=$1', [rfq.requester_id]) : null;
  const source = rfq.source_email_id ? await one('SELECT message_id, subject FROM emails WHERE id=$1', [rfq.source_email_id]) : null;
  const mb = await getMailbox(rfq.mailbox_id);
  if (!mb) throw new Error('No mailbox configured');
  const tpl = build({ rfq, customer: requester && { name: requester.company, contact: requester.contact }, quote, mb });
  const recipient = to || requester?.email;
  if (!recipient) throw new Error('Requester email missing');
  const threadSubject = source?.subject ? `${/^re:/i.test(source.subject) ? '' : 'Re: '}${source.subject} — ${quote.ref}` : null;
  await sendMail(
    mb,
    { to: recipient, cc, subject: subject || threadSubject || tpl.subject, text: text || tpl.text, html: text ? undefined : tpl.html, inReplyTo: source?.message_id || undefined, references: source?.message_id ? [source.message_id] : undefined, attachments },
    { kind, rfq_id: rfq.id }
  );
  return rfq;
}

export async function emailCustomerQuote(quoteId, opts = {}) {
  const quote = await one('SELECT * FROM customer_quotes WHERE id=$1', [quoteId]);
  const pdf = await renderPdf(quoteId);
  const rfq = await sendToRequester(quote, customerQuoteEmail, { ...opts, attachments: [{ filename: `${quote.ref}.pdf`, content: pdf }], kind: 'customer_quote' });
  await q("UPDATE customer_quotes SET status='sent', sent_at=now() WHERE id=$1", [quoteId]);
  await q("UPDATE rfqs SET status=CASE WHEN status IN ('new','sent','quoting','draft') THEN 'quoted' ELSE status END WHERE id=$1", [rfq.id]);
  return true;
}

export async function followUpQuote(quoteId) {
  const quote = await one('SELECT * FROM customer_quotes WHERE id=$1', [quoteId]);
  if (quote.status !== 'sent') throw Object.assign(new Error('Only sent quotes can be followed up'), { status: 400 });
  const pdf = await renderPdf(quoteId);
  await sendToRequester(quote, quoteFollowupEmail, { attachments: [{ filename: `${quote.ref}.pdf`, content: pdf }], kind: 'quote_followup' });
  await q('UPDATE customer_quotes SET followup_count=followup_count+1, last_followup_at=now() WHERE id=$1', [quoteId]);
  return true;
}

export const LOST_REASONS = ['Price too high', 'Lost to a competitor', 'Transit time / routing', 'Slow response', 'Shipment cancelled or postponed', 'No reply from customer', 'Other'];

export async function markLost(quoteId, { reason, note, competitor_price }) {
  const quote = await one('SELECT * FROM customer_quotes WHERE id=$1', [quoteId]);
  await q("UPDATE customer_quotes SET status='lost', lost_reason=$1, lost_note=$2, competitor_price=$3, decided_at=now() WHERE id=$4", [reason || 'Other', note || null, competitor_price || null, quoteId]);
  // the RFQ is lost only if no other quote on it is still open or won
  const open = await one("SELECT count(*)::int AS n FROM customer_quotes WHERE rfq_id=$1 AND status IN ('draft','sent','accepted')", [quote.rfq_id]);
  if (!open.n) await q("UPDATE rfqs SET status='lost' WHERE id=$1", [quote.rfq_id]);
  return true;
}

/** Scheduled: follow up quotes about to expire, then mark expired ones. */
export async function quoteHousekeeping() {
  const pricing = await getSetting('pricing');
  let followed = 0;
  if (pricing.auto_followup !== false) {
    const due = await q(
      `SELECT id FROM customer_quotes WHERE status='sent' AND followup_count=0 AND valid_until IS NOT NULL
       AND valid_until <= current_date + $1::int AND valid_until >= current_date AND sent_at < now() - interval '1 day'`,
      [Number(pricing.followup_days_before_expiry ?? 2)]
    );
    for (const d of due) {
      try { await followUpQuote(d.id); followed++; } catch (e) { console.error('follow-up failed', d.id, e.message); }
    }
  }
  const expired = await q("UPDATE customer_quotes SET status='expired', decided_at=now() WHERE status='sent' AND valid_until < current_date RETURNING rfq_id");
  for (const e of expired) {
    const open = await one("SELECT count(*)::int AS n FROM customer_quotes WHERE rfq_id=$1 AND status IN ('draft','sent','accepted')", [e.rfq_id]);
    if (!open.n) await q("UPDATE rfqs SET status='expired' WHERE id=$1 AND status='quoted'", [e.rfq_id]);
  }
  return { followed, expired: expired.length };
}
