// Email templates for partner agents and customers. Pure functions.
import { legName } from '../engines/charges.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const tagOf = (rfq, invite) => `[${rfq.ref}/${invite.tag}]`;
export const TAG_REGEX = /\[(RFQ-\d{4}-\d{3,})\/([A-Z0-9]{4})\]/;

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
  return {
    subject: `Quotation ${quote.ref} — ${routeText(rfq)}`,
    ...simple({ greet: `Dear ${customer?.contact || customer?.name || 'Sir/Madam'},`, mb, paragraphs: [`Thank you for your enquiry${rfq.requester_ref ? ` (your ref ${rfq.requester_ref})` : ''}. Please find attached our quotation ${quote.ref} for ${routeText(rfq)}.`, `Total: ${quote.currency} ${Number(quote.snapshot?.totals?.grand_total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}${quote.valid_until ? `, valid until ${new Date(quote.valid_until).toDateString()}` : ''}.`, 'Please reply to confirm and we will proceed with the booking.'] }),
  };
}
