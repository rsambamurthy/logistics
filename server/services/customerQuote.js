// Customer (sell-side) quotation: options, revisions, approvals, PDF, email, follow-up and outcome.
import PDFDocument from 'pdfkit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { q, one, currentTenant } from '../db.js';
import { buildQuoteOptions, diffSnapshots } from '../engines/costing.js';
import { BASES } from '../engines/charges.js';
import { getFx, getSetting } from './settings.js';
import { getMailbox, sendMail } from './mail.js';
import { customerQuoteEmail, quoteFollowupEmail, routeText } from './templates.js';
import { t as tr, legLabel, basisLabel } from './i18n.js';
import { awardRfq } from './rfq.js';
import { PRODUCT } from '../lib/brand.js';
import { audit } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, '..', 'fonts');
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** RFQs a quote may draw options from: this RFQ and its linked alternatives (same family). */
export async function rfqFamily(rfqId) {
  const r = await one('SELECT id, parent_rfq_id FROM rfqs WHERE id=$1', [rfqId]);
  const root = r.parent_rfq_id || r.id;
  return q('SELECT * FROM rfqs WHERE id=$1 OR parent_rfq_id=$1 ORDER BY id', [root]);
}

async function quotesFor(rfqIds) {
  const quotes = await q('SELECT * FROM agent_quotes WHERE rfq_id = ANY($1)', [rfqIds]);
  if (!quotes.length) return {};
  const lines = await q('SELECT * FROM quote_lines WHERE agent_quote_id = ANY($1) ORDER BY sort, id', [quotes.map((x) => x.id)]);
  const invites = await q('SELECT i.id, a.company FROM rfq_invites i JOIN agents a ON a.id=i.agent_id WHERE i.rfq_id = ANY($1)', [rfqIds]);
  for (const x of quotes) {
    x.lines = lines.filter((l) => l.agent_quote_id === x.id);
    x.agent = { company: invites.find((i) => i.id === x.invite_id)?.company };
  }
  return Object.fromEntries(quotes.map((x) => [x.id, x]));
}

/** Normalise the request body into options. Accepts { options: [...] } or a single { selection }. */
function optionsFrom(rfqId, body) {
  if (Array.isArray(body.options) && body.options.length) return body.options;
  return [{ label: body.label || null, rfq_id: rfqId, selection: body.selection, margin_pct: body.margin_pct, leg_margins: body.leg_margins }];
}

export async function previewCustomerQuote(rfqId, body) {
  const family = await rfqFamily(rfqId);
  const byRfq = Object.fromEntries(family.map((r) => [r.id, r]));
  const opts = optionsFrom(rfqId, body).map((o) => {
    const rfq = byRfq[o.rfq_id || rfqId];
    if (!rfq) throw err('An option refers to an RFQ that is not linked to this one');
    return { ...o, rfq };
  });
  const quotesById = await quotesFor(family.map((r) => r.id));
  const snap = buildQuoteOptions(opts, quotesById, { currency: body.currency, marginPct: body.margin_pct, taxPct: body.tax_pct }, await getFx());
  const prev = await one("SELECT id, ref, snapshot FROM customer_quotes WHERE rfq_id=$1 AND status NOT IN ('superseded') ORDER BY id DESC LIMIT 1", [rfqId]);
  if (prev) {
    snap.previous = { id: prev.id, ref: prev.ref };
    snap.changes = diffSnapshots(prev.snapshot, snap);
  }
  return snap;
}

const minMargin = (snap) => Math.min(...snap.options.map((o) => o.totals.margin_pct_effective));
const canApprove = (user) => ['admin', 'manager'].includes(user?.role);

export async function saveCustomerQuote(rfqId, body, user) {
  const pricing = await getSetting('pricing');
  const snapshot = await previewCustomerQuote(rfqId, body);
  const below = minMargin(snapshot) < Number(pricing.floor_margin_pct);
  let approval = 'not_needed';
  if (below) approval = canApprove(user) && body.approved_below_floor ? 'approved' : 'pending';
  const rfq = await one('SELECT ref, requester_id FROM rfqs WHERE id=$1', [rfqId]);
  const requester = rfq.requester_id ? await one('SELECT quote_language FROM agents WHERE id=$1', [rfq.requester_id]) : null;
  const n = await one('SELECT count(*)::int AS n FROM customer_quotes WHERE rfq_id=$1', [rfqId]);
  const ref = `${rfq.ref.replace('RFQ', 'QT')}${n.n ? `-R${n.n}` : ''}`;
  const validUntil = body.valid_until || new Date(Date.now() + Number(pricing.quote_validity_days || 7) * 864e5).toISOString().slice(0, 10);
  return one(
    `INSERT INTO customer_quotes(rfq_id,ref,currency,selection,margin_pct,tax_pct,valid_until,terms,snapshot,language,previous_id,approval_status,approval_requested_by,approved_by,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [rfqId, ref, body.currency, snapshot.options[0].selection, body.margin_pct || 0, body.tax_pct || 0, validUntil, body.terms ?? pricing.terms, snapshot,
      body.language || requester?.quote_language || 'en', snapshot.previous?.id || null, approval, approval === 'pending' ? user?.id : null, approval === 'approved' ? user?.id : null, user?.id || null]
  );
}

export async function decideApproval(quoteId, user, { approve, note }) {
  if (!canApprove(user)) throw err('Only managers or admins can approve quotes', 403);
  const cq = await one('SELECT * FROM customer_quotes WHERE id=$1', [quoteId]);
  if (cq.approval_status !== 'pending') throw err('This quote is not waiting for approval');
  await q('UPDATE customer_quotes SET approval_status=$1, approved_by=$2, approval_note=$3 WHERE id=$4', [approve ? 'approved' : 'rejected', user.id, note || null, quoteId]);
  return true;
}

/** Customer accepted (option index for multi-option quotes): award the agents behind that option. */
export async function acceptQuote(quoteId, { option = 0, sendRegrets = true, note, award = true } = {}) {
  const cq = await one('SELECT * FROM customer_quotes WHERE id=$1', [quoteId]);
  const opt = cq.snapshot?.options?.[option] || { rfq_id: cq.rfq_id, selection: cq.selection };
  await q("UPDATE customer_quotes SET status='accepted', accepted_at=now(), decided_at=now(), accepted_option=$2 WHERE id=$1", [cq.id, option]);
  await q("UPDATE customer_quotes SET status='superseded' WHERE rfq_id=$1 AND id<>$2 AND status IN ('draft','sent','expired')", [cq.rfq_id, cq.id]);
  const results = award ? await awardRfq(opt.rfq_id, opt.selection, { sendRegrets, note }) : [];
  // the other linked alternatives are closed
  const family = await rfqFamily(cq.rfq_id);
  for (const r of family) if (r.id !== opt.rfq_id && !['awarded'].includes(r.status)) await q("UPDATE rfqs SET status='closed' WHERE id=$1", [r.id]);
  if (opt.rfq_id !== cq.rfq_id) await q("UPDATE rfqs SET status='awarded' WHERE id=$1", [cq.rfq_id]);
  return results;
}

const money = (n, cur) => `${cur} ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const basisName = (b) => BASES.find((x) => x.code === b)?.name || b;

function decodeImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(dataUrl || '');
  return m ? Buffer.from(m[2], 'base64') : null;
}

export async function renderPdf(quoteId) {
  const quote = await one('SELECT * FROM customer_quotes WHERE id=$1', [quoteId]);
  const family = await rfqFamily(quote.rfq_id);
  const rfq = await one('SELECT r.*, p.company AS requester_name FROM rfqs r LEFT JOIN agents p ON p.id=r.requester_id WHERE r.id=$1', [quote.rfq_id]);
  const company = await getSetting('company');
  const L = tr(quote.language || 'en');
  const s = quote.snapshot;
  const options = s.options || [{ label: null, rfq_id: rfq.id, sections: s.sections, totals: s.totals }];
  const multi = options.length > 1;

  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `Quotation ${quote.ref}`, Producer: PRODUCT.name } });
  const zh = quote.language === 'zh';
  const REG = zh ? 'zh' : 'Helvetica';
  const BOLD = zh ? 'zh-b' : 'Helvetica-Bold';
  if (zh) {
    doc.registerFont('zh', path.join(FONT_DIR, 'NotoSansTC-Regular.ttf'));
    doc.registerFont('zh-b', path.join(FONT_DIR, 'NotoSansTC-Bold.ttf'));
  }
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const blue = '#0b2a4a';

  // header with optional logo
  const logo = decodeImage(company.logo);
  let textX = 40;
  if (logo) {
    try { doc.image(logo, 40, 36, { fit: [90, 50] }); textX = 140; } catch { /* unreadable logo */ }
  }
  doc.fillColor(blue).fontSize(17).font(BOLD).text(company.name || '', textX, 40, { width: 555 - textX });
  doc.fontSize(8.5).font(REG).fillColor('#444').text([company.address, company.phone, company.email, company.gstin && `${company.country === 'HK' ? 'BR' : 'GSTIN'}: ${company.gstin}`].filter(Boolean).join('  |  '), textX, doc.y, { width: 555 - textX });
  doc.y = Math.max(doc.y, logo ? 92 : doc.y);
  doc.moveDown(0.8);
  doc.fillColor(blue).fontSize(14).font(BOLD).text(L('quotation'), 40, doc.y, { continued: true }).font(REG).fontSize(10).fillColor('#444').text(`   ${quote.ref}`);
  doc.moveDown(0.3);
  const cargoText = (r) => (r.mode === 'FCL' ? (r.containers || []).map((c) => `${c.qty} x ${c.type}`).join(', ') : [r.packages && `${r.packages} pkgs`, r.gross_weight_kg && `${r.gross_weight_kg} kg`, r.volume_cbm && `${r.volume_cbm} cbm`].filter(Boolean).join(' / '));
  const modeText = (m) => (m === 'AIR' ? L('air') : `${L('sea')} ${m}`);
  const info = [
    [L('to'), rfq.requester_name || '-'],
    ...(rfq.requester_ref ? [[L('your_ref'), rfq.requester_ref]] : []),
    [L('date'), new Date(quote.created_at).toDateString()],
    [L('valid_until'), quote.valid_until ? new Date(quote.valid_until).toDateString() : '-'],
    [L('route'), routeText(rfq, '  >  ')],
    [L('mode'), [...new Set(options.map((o) => o.mode || rfq.mode))].map(modeText).join(' / ')],
    [L('cargo'), cargoText(rfq)],
    [L('incoterm'), rfq.incoterm],
    [L('commodity'), rfq.commodity],
    [L('hs_code'), rfq.hs_code],
    [L('dg'), rfq.dangerous_goods ? [rfq.dg_class && `Class ${rfq.dg_class}`, rfq.un_number && `UN ${rfq.un_number}`].filter(Boolean).join(', ') || 'Yes' : null],
    [L('reefer'), rfq.reefer_temp],
    [L('dimensions'), rfq.dimensions],
  ].filter(([, v]) => v);
  doc.fontSize(9);
  for (const [k, v] of info) {
    const y = doc.y;
    doc.font(BOLD).fillColor('#333').text(k, 40, y, { width: 110 });
    doc.font(REG).text(String(v), 150, y, { width: 405 });
  }
  if (s.previous && s.changes?.length) {
    doc.moveDown(0.5).font(BOLD).fontSize(9).fillColor('#9a6700').text(`${L('replaces')} ${s.previous.ref}. ${L('changes')}:`, 40);
    doc.font(REG).fontSize(8.5).text(s.changes.map((c) => `• ${c}`).join('\n'), 50, doc.y, { width: 500 });
  }
  doc.moveDown(0.6);

  // options summary
  let y = doc.y;
  if (multi) {
    doc.font(BOLD).fontSize(10).fillColor(blue).text(L('options_summary'), 40, y);
    y = doc.y + 3;
    for (const o of options) {
      const r = family.find((x) => x.id === o.rfq_id) || rfq;
      doc.font(REG).fontSize(9).fillColor('#222').text(`${o.label}  ·  ${modeText(o.mode || r.mode)}${o.transit_days ? `  ·  ${L('transit')} ${o.transit_days} ${L('days')}` : ''}`, 50, y, { width: 330 });
      doc.font(BOLD).text(money(o.totals.grand_total, s.currency), 380, y, { width: 172, align: 'right' });
      y = doc.y + 3;
    }
    y += 8;
  }

  const cols = [40, 250, 360, 400, 475];
  const header = (yy) => {
    doc.rect(40, yy - 3, 515, 16).fill(blue);
    doc.fillColor('#fff').font(BOLD).fontSize(8.5);
    [L('charge'), L('basis'), L('qty'), L('rate'), L('amount')].forEach((h, i) => doc.text(h, cols[i] + 3, yy, { width: (cols[i + 1] || 555) - cols[i] - 6, align: i >= 2 ? 'right' : 'left' }));
    doc.fillColor('#222').font(REG);
    return yy + 18;
  };
  for (const o of options) {
    if (multi) {
      if (y > 690) { doc.addPage(); y = 50; }
      doc.rect(40, y, 515, 20).fill('#eaf2ff');
      doc.fillColor(blue).font(BOLD).fontSize(11).text(`${L('option')}: ${o.label}`, 46, y + 4);
      y += 28;
    }
    for (const sec of o.sections) {
      if (y > 720) { doc.addPage(); y = 50; }
      doc.font(BOLD).fontSize(10).fillColor(blue).text(legLabel(quote.language, sec.leg, sec.name), 40, y);
      y = header(doc.y + 4);
      for (const l of sec.lines) {
        if (y > 760) { doc.addPage(); y = header(50); }
        doc.fontSize(8.5).fillColor('#222').font(REG);
        const bn = basisLabel(quote.language, l.basis, basisName(l.basis));
        const rowH = Math.max(doc.heightOfString(l.description, { width: 204 }), doc.heightOfString(bn, { width: 104 }), 11);
        doc.text(l.description, cols[0] + 3, y, { width: 204 });
        doc.text(bn, cols[1] + 3, y, { width: 104 });
        doc.text(String(Number(l.qty)), cols[2], y, { width: 36, align: 'right' });
        doc.text(Number(l.sell_rate).toFixed(2), cols[3], y, { width: 70, align: 'right' });
        doc.text(Number(l.sell_amount).toFixed(2), cols[4], y, { width: 77, align: 'right' });
        y = y + rowH + 5;
        doc.moveTo(40, y - 2).lineTo(555, y - 2).strokeColor('#e1e6ee').lineWidth(0.5).stroke();
      }
      doc.font(BOLD).fontSize(8.5).text(`${L('subtotal')}  ${money(sec.subtotal, s.currency)}`, 300, y + 2, { width: 252, align: 'right' });
      y = doc.y + 10;
    }
    if (y > 700) { doc.addPage(); y = 50; }
    const tot = o.totals;
    const rows = [[L('total'), money(tot.sell, s.currency)]];
    if (tot.tax) rows.push([`${L('tax')} (${tot.tax_pct}%)`, money(tot.tax, s.currency)]);
    rows.push([L('grand_total'), money(tot.grand_total, s.currency)]);
    for (const [k, v] of rows) {
      const g = k === L('grand_total');
      doc.font(g ? BOLD : REG).fontSize(g ? 11 : 9.5).fillColor(blue).text(`${k}:  ${v}`, 300, y, { width: 252, align: 'right' });
      y = doc.y + 4;
    }
    y += 10;
  }
  doc.y = y;
  const bank = [
    [L('bank_name'), company.bank_name], [L('account_name'), company.bank_account_name], [L('account_no'), company.bank_account_no],
    [L('ifsc'), company.bank_ifsc], [L('swift'), company.bank_swift], [L('branch'), company.bank_branch],
  ].filter(([, v]) => v);
  if (bank.length) {
    if (doc.y > 700) doc.addPage();
    doc.moveDown(0.6).font(BOLD).fontSize(9).fillColor('#333').text(L('bank'), 40);
    doc.font(REG).fontSize(8.5).fillColor('#444').text(bank.map(([k, v]) => `${k}: ${v}`).join('   |   '), 40, doc.y + 2, { width: 515 });
  }
  if (quote.terms) {
    if (doc.y > 720) doc.addPage();
    doc.moveDown(0.8).font(BOLD).fontSize(9).fillColor('#333').text(L('terms'), 40);
    doc.font(REG).fontSize(8.5).fillColor('#444').text(quote.terms, 40, doc.y + 2, { width: 515 });
  }
  // small product footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // allow writing in the footer area without adding a page
    doc.font('Helvetica').fontSize(7).fillColor('#9aa5b4').text(`Prepared with ${PRODUCT.name} · quayly.integratatech.ai`, 40, 812, { width: 515, align: 'center', lineBreak: false });
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
  if (quote.approval_status === 'pending') throw err('This quote is waiting for a manager to approve the margin.');
  if (quote.approval_status === 'rejected') throw err('This quote was not approved. Create a revised quote.');
  const pdf = await renderPdf(quoteId);
  const rfq = await sendToRequester(quote, customerQuoteEmail, { ...opts, attachments: [{ filename: `${quote.ref}.pdf`, content: pdf }], kind: 'customer_quote' });
  await q("UPDATE customer_quotes SET status='sent', sent_at=now() WHERE id=$1", [quoteId]);
  // a sent revision replaces the earlier open versions
  await q("UPDATE customer_quotes SET status='superseded' WHERE rfq_id=$1 AND id<>$2 AND status IN ('draft','sent','expired')", [quote.rfq_id, quoteId]);
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
      try {
        await followUpQuote(d.id);
        followed++;
        const cq = await one('SELECT rfq_id, ref FROM customer_quotes WHERE id=$1', [d.id]);
        await audit(null, 'Automatic quotation follow-up', { entity: 'customer_quote', entityId: d.id, rfqId: cq?.rfq_id, summary: cq?.ref });
      } catch (e) { console.error('follow-up failed', d.id, e.message); }
    }
  }
  const expired = await q("UPDATE customer_quotes SET status='expired', decided_at=now() WHERE status='sent' AND valid_until < current_date RETURNING id, rfq_id, ref");
  for (const e of expired) {
    await audit(null, 'Quotation expired', { entity: 'customer_quote', entityId: e.id, rfqId: e.rfq_id, summary: e.ref });
    const open = await one("SELECT count(*)::int AS n FROM customer_quotes WHERE rfq_id=$1 AND status IN ('draft','sent','accepted')", [e.rfq_id]);
    if (!open.n) await q("UPDATE rfqs SET status='expired' WHERE id=$1 AND status='quoted'", [e.rfq_id]);
  }
  return { followed, expired: expired.length };
}
