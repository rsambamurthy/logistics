// Email templates for partner agents and customers. Pure functions.
import { legName } from '../engines/charges.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const tagOf = (rfq, invite) => `[${rfq.ref}/${invite.tag}]`;
export const TAG_REGEX = /\[(RFQ-\d{4}-\d{3,})\/([A-Z0-9]{4})\]/;
export const JOB_TAG_REGEX = /\[(JOB-\d{4}-\d{3,})\/([A-Z0-9]{4})\]/;

export function routeText(rfq, sep = ' → ') {
  return [rfq.pickup_place, rfq.pol, rfq.pod, rfq.delivery_place].filter(Boolean).join(sep);
}

function equipmentText(rfq) {
  if (rfq.mode === 'FCL') return (rfq.containers || []).map((c) => `${c.qty} x ${c.type}`).join(', ');
  const parts = [];
  if (rfq.packages) parts.push(`${rfq.packages} pkgs`);
  if (rfq.gross_weight_kg) parts.push(`${rfq.gross_weight_kg} kg`);
  if (rfq.volume_cbm) parts.push(`${rfq.volume_cbm} cbm`);
  return parts.join(' / ');
}

export function subjectFor(mb, rfq, invite, prefix = '') {
  let s = (mb.subject_template || 'Rate request {{route}} {{tag}}')
    .replace('{{route}}', `${rfq.pol || ''} to ${rfq.pod || ''}`.trim())
    .replace('{{ref}}', rfq.ref)
    .replace('{{mode}}', rfq.mode)
    .replace('{{tag}}', tagOf(rfq, invite));
  if (!s.includes(tagOf(rfq, invite))) s += ` ${tagOf(rfq, invite)}`;
  return (prefix + s).trim();
}

function detailsRows(rfq) {
  return [
    ['Reference', rfq.ref],
    ['Mode', rfq.mode === 'AIR' ? 'Air freight' : `Sea ${rfq.mode}`],
    ['Pickup', rfq.pickup_place],
    ['Port / airport of loading', rfq.pol],
    ['Port / airport of discharge', rfq.pod],
    ['Delivery', rfq.delivery_place],
    ['Incoterm', rfq.incoterm],
    ['Equipment / cargo', equipmentText(rfq)],
    ['Commodity', rfq.commodity],
    ['HS code', rfq.hs_code],
    ['Dangerous goods', rfq.dangerous_goods ? ['Yes', rfq.dg_class && `class ${rfq.dg_class}`, rfq.un_number && `UN ${rfq.un_number}`].filter(Boolean).join(', ') : null],
    ['Reefer temperature', rfq.reefer_temp],
    ['Dimensions', rfq.dimensions],
    ['Stackable', rfq.stackable === false ? 'No' : null],
    ['Cargo ready', rfq.ready_date ? new Date(rfq.ready_date).toDateString() : null],
    ['Notes', rfq.notes],
  ].filter(([, v]) => v);
}

function signatureBlock(mb) {
  return mb.signature || `${mb.from_name}`;
}

export function rfqEmail({ rfq, invite, agent, mb }) {
  const rows = detailsRows(rfq);
  const legs = (invite.legs || []).map(legName);
  const deadline = rfq.deadline ? new Date(rfq.deadline).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : null;
  const greet = `Dear ${agent.contact || agent.company},`;
  const text = [
    greet,
    '',
    'Please quote your best rates for the shipment below.',
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    'Please include:',
    ...legs.map((l) => `- ${l}`),
    '',
    'For each charge please mention: currency, rate, basis (per container / per BL / per kg etc.), validity, transit time and free days. Your own format or attachment is fine.',
    deadline ? `Kindly reply by ${deadline}.` : '',
    '',
    'Please keep the reference in the subject when replying.',
    '',
    'Regards,',
    signatureBlock(mb),
  ].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1d2433">
<p>${esc(greet)}</p><p>Please quote your best rates for the shipment below.</p>
<table cellpadding="6" style="border-collapse:collapse;border:1px solid #d6dce5">${rows.map(([k, v]) => `<tr><td style="background:#f2f5f9;border:1px solid #d6dce5;font-weight:bold">${esc(k)}</td><td style="border:1px solid #d6dce5">${esc(v)}</td></tr>`).join('')}</table>
<p><b>Please include:</b></p><ul>${legs.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<p>For each charge please mention: currency, rate, basis (per container / per BL / per kg etc.), validity, transit time and free days. Your own format or attachment is fine.</p>
${deadline ? `<p>Kindly reply by <b>${esc(deadline)}</b>.</p>` : ''}
<p style="color:#5a6b80">Please keep the reference in the subject when replying.</p>
<p>Regards,<br>${esc(signatureBlock(mb)).replace(/\n/g, '<br>')}</p></div>`;
  return { subject: subjectFor(mb, rfq, invite), text, html };
}

function simple({ greet, paragraphs, mb }) {
  const text = [greet, '', ...paragraphs.flatMap((p) => [p, '']), 'Regards,', signatureBlock(mb)].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1d2433"><p>${esc(greet)}</p>${paragraphs.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}<p>Regards,<br>${esc(signatureBlock(mb)).replace(/\n/g, '<br>')}</p></div>`;
  return { text, html };
}

export function reminderEmail({ rfq, invite, agent, mb }) {
  return {
    subject: subjectFor(mb, rfq, invite, 'Reminder: '),
    ...simple({ greet: `Dear ${agent.contact || agent.company},`, mb, paragraphs: [`Gentle reminder on our rate request ${rfq.ref} (${routeText(rfq)}). We would appreciate your quote at the earliest.`, 'If you are unable to quote, a short reply saying so would help us.'] }),
  };
}

export function counterEmail({ rfq, invite, agent, mb, message }) {
  return {
    subject: subjectFor(mb, rfq, invite, 'Re: '),
    ...simple({ greet: `Dear ${agent.contact || agent.company},`, mb, paragraphs: [`Thank you for your quote for ${rfq.ref}.`, message] }),
  };
}

export function awardEmail({ rfq, invite, agent, mb, legs, note }) {
  return {
    subject: subjectFor(mb, rfq, invite, 'Confirmed: '),
    ...simple({ greet: `Dear ${agent.contact || agent.company},`, mb, paragraphs: [`We are pleased to confirm ${rfq.ref} (${routeText(rfq)}) with you for: ${legs.map(legName).join(', ')}, as per your quotation.`, note || 'Our operations team will share booking details shortly. Please confirm space and equipment.'] }),
  };
}

export function regretEmail({ rfq, invite, agent, mb }) {
  return {
    subject: subjectFor(mb, rfq, invite, 'Re: '),
    ...simple({ greet: `Dear ${agent.contact || agent.company},`, mb, paragraphs: [`Thank you for quoting on ${rfq.ref}. This time the shipment has been placed elsewhere. We value your support and look forward to working together on the next one.`] }),
  };
}

export function customerQuoteEmail({ rfq, customer, quote, mb }) {
  const snap = quote.snapshot || {};
  const opts = snap.options || [];
  const fmt = (n) => `${quote.currency} ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  const zh = quote.language === 'zh';
  const paragraphs = zh
    ? [
        `多謝查詢${rfq.requester_ref ? `（貴司參考編號 ${rfq.requester_ref}）` : ''}。附上 ${routeText(rfq)} 的報價單 ${quote.ref}。`,
        opts.length > 1 ? `方案：\n${opts.map((o) => `• ${o.label}: ${fmt(o.totals.grand_total)}`).join('\n')}` : `總計：${fmt(snap.totals?.grand_total)}${quote.valid_until ? `，有效期至 ${quote.valid_until}` : ''}。`,
        ...(snap.previous && snap.changes?.length ? [`本修訂版取代 ${snap.previous.ref}。`] : []),
        '如確認，請回覆此電郵，我們會即時安排訂艙。',
      ]
    : [
        `Thank you for your enquiry${rfq.requester_ref ? ` (your ref ${rfq.requester_ref})` : ''}. Please find attached our quotation ${quote.ref} for ${routeText(rfq)}.`,
        opts.length > 1
          ? `Options:\n${opts.map((o) => `• ${o.label}: ${fmt(o.totals.grand_total)}`).join('\n')}${quote.valid_until ? `\nValid until ${new Date(quote.valid_until).toDateString()}.` : ''}`
          : `Total: ${fmt(snap.totals?.grand_total)}${quote.valid_until ? `, valid until ${new Date(quote.valid_until).toDateString()}` : ''}.`,
        ...(snap.previous && snap.changes?.length ? [`This revision replaces ${snap.previous.ref}. Changes:\n${snap.changes.map((c) => `• ${c}`).join('\n')}`] : []),
        opts.length > 1 ? 'Please reply with the option you prefer and we will proceed with the booking.' : 'Please reply to confirm and we will proceed with the booking.',
      ];
  return {
    subject: `${snap.previous ? 'Revised quotation' : 'Quotation'} ${quote.ref} — ${routeText(rfq)}`,
    ...simple({ greet: zh ? `${customer?.contact || customer?.name || ''} 您好：` : `Dear ${customer?.contact || customer?.name || 'Sir/Madam'},`, mb, paragraphs }),
  };
}

export function quoteFollowupEmail({ rfq, customer, quote, mb }) {
  const total = `${quote.currency} ${Number(quote.snapshot?.totals?.grand_total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  return {
    subject: `Follow-up: quotation ${quote.ref} — ${routeText(rfq)}`,
    ...simple({
      greet: `Dear ${customer?.contact || customer?.name || 'Sir/Madam'},`,
      mb,
      paragraphs: [
        `Following up on our quotation ${quote.ref} for ${routeText(rfq)} (${total})${quote.valid_until ? `, valid until ${new Date(quote.valid_until).toDateString()}` : ''}.`,
        'Please let us know if you would like to go ahead, or if anything needs to change. We are happy to revise the quote.',
      ],
    }),
  };
}

// ---------------- booking ----------------
const partyText = (p) => [p?.name, p?.address, [p?.contact, p?.phone, p?.email].filter(Boolean).join(' / '), p?.tax_id && `Tax ID: ${p.tax_id}`].filter(Boolean).join('\n');
// dates and cut-offs are local port times kept as text ('YYYY-MM-DD' / 'YYYY-MM-DDTHH:MM'): format without time-zone shifts
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtD = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v instanceof Date ? v.toISOString() : String(v || '')); return m ? `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}` : null; };
export const fmtDT = (v) => { const t = /T(\d{2}:\d{2})/.exec(String(v || '')); return fmtD(v) && `${fmtD(v)}${t ? ` ${t[1]}` : ''}`; };

export function bookingRequestEmail({ job, booking, rfq, agent, mb, note }) {
  const tag = `[${job.ref}/${booking.tag}]`;
  const rows = [
    ['Our job reference', job.ref],
    ['Your quote', rfq.ref],
    ['Legs to book', (booking.legs || []).map(legName).join(', ')],
    ['Route', routeText(rfq)],
    ['Mode', rfq.mode === 'AIR' ? 'Air' : `Sea ${rfq.mode}`],
    ['Equipment / cargo', equipmentText(rfq)],
    ['Commodity', rfq.commodity],
    ['HS code', rfq.hs_code],
    ['Dangerous goods', rfq.dangerous_goods ? ['Yes', rfq.dg_class && `class ${rfq.dg_class}`, rfq.un_number && `UN ${rfq.un_number}`].filter(Boolean).join(', ') : null],
    ['Reefer temperature', rfq.reefer_temp],
    ['Cargo ready', fmtD(job.cargo_ready_date)],
    ['Shipper', partyText(job.shipper)],
    ['Consignee', partyText(job.consignee)],
    ['Notify party', partyText(job.notify_party)],
  ].filter(([, v]) => v);
  const greet = `Dear ${agent.contact || agent.company},`;
  const intro = `Please book the shipment below as per your quotation and confirm with booking number, vessel/voyage (or flight), ETD/ETA and cut-offs (SI, VGM, gate-in).`;
  const text = [greet, '', intro, '', ...rows.map(([k, v]) => `${k}: ${String(v).replace(/\n/g, ', ')}`), '', note || '', '', 'Please keep the reference in the subject when replying.', '', 'Regards,', signatureBlock(mb)].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1d2433"><p>${esc(greet)}</p><p>${esc(intro)}</p>
<table cellpadding="6" style="border-collapse:collapse;border:1px solid #d6dce5">${rows.map(([k, v]) => `<tr><td style="background:#f2f5f9;border:1px solid #d6dce5;font-weight:bold;vertical-align:top">${esc(k)}</td><td style="border:1px solid #d6dce5">${esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}</table>
${note ? `<p>${esc(note).replace(/\n/g, '<br>')}</p>` : ''}<p style="color:#5a6b80">Please keep the reference in the subject when replying.</p>
<p>Regards,<br>${esc(signatureBlock(mb)).replace(/\n/g, '<br>')}</p></div>`;
  return { subject: `Booking request ${rfq.pol || ''} to ${rfq.pod || ''} ${tag}`.replace(/\s+/g, ' '), text, html };
}

export function customerBookingEmail({ job, bookings, rfq, customer, mb, note, trackUrl }) {
  const blocks = bookings.map((b) => [
    ['Covers', (b.legs || []).map(legName).join(', ')],
    ['Booking no.', b.booking_no],
    ['Carrier', b.carrier],
    ['Vessel / voyage', [b.vessel, b.voyage].filter(Boolean).join(' / ') || null],
    ['Flight', b.flight_no],
    ['From → to', [b.pol || rfq.pol, b.pod || rfq.pod].filter(Boolean).join(' → ')],
    ['ETD', fmtD(b.etd)],
    ['ETA', fmtD(b.eta)],
    ['SI cut-off', fmtDT(b.cutoffs?.si)],
    ['VGM cut-off', fmtDT(b.cutoffs?.vgm)],
    ['Gate-in cut-off', fmtDT(b.cutoffs?.gate_in)],
    ['Empty pick-up', b.empty_pickup],
  ].filter(([, v]) => v));
  const greet = `Dear ${customer?.contact || customer?.name || 'Sir/Madam'},`;
  const intro = `Your shipment ${job.ref}${job.customer_ref ? ` (your ref ${job.customer_ref})` : ''} for ${routeText(rfq)} is booked. Details below.`;
  const text = [greet, '', intro, '', ...blocks.flatMap((rows) => [...rows.map(([k, v]) => `${k}: ${v}`), '']), note || '', 'Please share the shipping instructions and documents before the cut-offs.', trackUrl ? `\nTrack your shipment live: ${trackUrl}` : '', '', 'Regards,', signatureBlock(mb)].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1d2433"><p>${esc(greet)}</p><p>${esc(intro)}</p>
${blocks.map((rows) => `<table cellpadding="6" style="border-collapse:collapse;border:1px solid #d6dce5;margin-bottom:10px">${rows.map(([k, v]) => `<tr><td style="background:#f2f5f9;border:1px solid #d6dce5;font-weight:bold">${esc(k)}</td><td style="border:1px solid #d6dce5">${esc(v)}</td></tr>`).join('')}</table>`).join('')}
${note ? `<p>${esc(note)}</p>` : ''}<p>Please share the shipping instructions and documents before the cut-offs.</p>${trackUrl ? `<p><a href="${esc(trackUrl)}" style="background:#0b6bff;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Track your shipment</a></p>` : ''}<p>Regards,<br>${esc(signatureBlock(mb)).replace(/\n/g, '<br>')}</p></div>`;
  return { subject: `Booking confirmed ${job.ref} — ${routeText(rfq)}`, text, html };
}

// ---------------- documents ----------------
/** Greeting, paragraphs and an optional list; shared by the document emails. */
function listEmail({ greet, before = [], list = [], after = [], mb }) {
  const text = [greet, '', ...before.flatMap((p) => [p, '']), ...list.map((l) => `- ${l}`), list.length ? '' : null, ...after.flatMap((p) => [p, '']), 'Regards,', signatureBlock(mb)].filter((x) => x !== null).join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1d2433"><p>${esc(greet)}</p>${before.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}${list.length ? `<ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}${after.map((p) => (/^Track your shipment live: /.test(p) ? `<p><a href="${esc(p.replace(/^Track your shipment live: /, ''))}" style="background:#0b6bff;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Track your shipment</a></p>` : `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)).join('')}<p>Regards,<br>${esc(signatureBlock(mb)).replace(/\n/g, '<br>')}</p></div>`;
  return { text, html };
}
const dear = (p) => `Dear ${p?.contact || p?.name || p?.company || 'Sir/Madam'},`;

export function documentRequestEmail({ job, rfq, customer, mb, docs, note, cutoff }) {
  return {
    subject: `Documents needed for ${job.ref} — ${routeText(rfq)}`,
    ...listEmail({
      greet: dear(customer), mb, list: docs,
      before: [`To complete the booking and documentation for your shipment ${job.ref}${job.customer_ref ? ` (your ref ${job.customer_ref})` : ''}, please send us:`],
      after: [cutoff ? `The documentation cut-off is ${cutoff}; please send them before then.` : null, note, 'Simply reply to this email with the documents attached.'].filter(Boolean),
    }),
  };
}

export function siEmail({ job, booking, rfq, agent, mb, note, amended }) {
  const tag = `[${job.ref}/${booking.tag}]`;
  return {
    subject: `${amended ? 'Amended shipping' : 'Shipping'} instructions ${rfq.pol || ''} to ${rfq.pod || ''} ${tag}`.replace(/\s+/g, ' '),
    ...listEmail({
      greet: dear(agent), mb,
      before: [`Please find attached ${amended ? 'our amended' : 'our'} shipping instructions for ${job.ref}${booking.booking_no ? `, booking ${booking.booking_no}` : ''}.${amended ? ' This replaces the earlier version.' : ''}`],
      after: [note, 'Please send the draft BL / AWB for our checking before finalising. Keep the reference in the subject when replying.'].filter(Boolean),
    }),
  };
}

export function blToCustomerEmail({ job, rfq, customer, mb, draft, note, docLabel, trackUrl }) {
  return {
    subject: `${draft ? `Draft ${docLabel} for approval` : `${docLabel} copy`} — ${job.ref}`,
    ...listEmail({
      greet: dear(customer), mb,
      before: [draft
        ? `Please find attached the draft ${docLabel} for your shipment ${job.ref} (${routeText(rfq)}). Kindly check all details and reply with your approval or any corrections.`
        : `Please find attached a copy of the ${docLabel} for your shipment ${job.ref} (${routeText(rfq)}).`],
      after: [note, trackUrl && `Track your shipment live: ${trackUrl}`].filter(Boolean),
    }),
  };
}

export function blDecisionEmail({ job, booking, agent, mb, approve, corrections, note, docLabel }) {
  const tag = `[${job.ref}/${booking.tag}]`;
  return {
    subject: `${approve ? `Draft ${docLabel} approved` : `Corrections to draft ${docLabel}`} ${tag}`,
    ...listEmail({
      greet: dear(agent), mb,
      before: [approve ? `The draft ${docLabel} for ${job.ref} is approved. Please go ahead and issue the final.` : `Please correct the draft ${docLabel} for ${job.ref} as below and send a revised draft:`],
      list: approve ? [] : String(corrections || '').split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean),
      after: [note].filter(Boolean),
    }),
  };
}

// ---------------- milestones / tracking ----------------
const MILESTONE_TEXT = {
  departed: (r) => `Your shipment has departed${r.pol ? ` from ${r.pol}` : ''}.`,
  arrived: (r) => `Your shipment has arrived${r.pod ? ` at ${r.pod}` : ''}.`,
  completed: () => 'Your shipment is completed. Thank you for shipping with us.',
  eta: () => 'The expected arrival date of your shipment has changed.',
};
const MILESTONE_SUBJECT = { departed: 'Departed', arrived: 'Arrived', completed: 'Completed', eta: 'ETA update' };

/** Milestone update for the customer (or a partner agent), with the tracking link. */
export function milestoneEmail({ job, rfq, customer, mb, kind, info, trackUrl, toAgent }) {
  const rows = [
    ['Shipment', `${job.ref}${job.customer_ref ? ` (your ref ${job.customer_ref})` : ''}`],
    ['Route', routeText(rfq)],
    [rfq.mode === 'AIR' ? 'Flight' : 'Vessel / voyage', info.flight || [info.vessel, info.voyage].filter(Boolean).join(' / ') || null],
    [rfq.mode === 'AIR' ? 'AWB' : 'BL', job.bl_no || info.bl || null],
    ['Departed', info.atd ? fmtDT(info.atd) : null],
    [info.arrived ? 'Arrived' : 'Expected arrival', info.eta ? fmtDT(info.eta) : null],
    ['Previous estimate', kind === 'eta' && info.previous_eta ? fmtDT(info.previous_eta) : null],
  ].filter(([, v]) => v);
  return {
    subject: `${MILESTONE_SUBJECT[kind]}: ${job.ref} — ${routeText(rfq)}`,
    ...listEmail({
      greet: dear(customer), mb,
      before: [MILESTONE_TEXT[kind](info), rows.map(([k, v]) => `${k}: ${v}`).join('\n')],
      after: [trackUrl && !toAgent ? `Track your shipment live: ${trackUrl}` : null].filter(Boolean),
    }),
  };
}
