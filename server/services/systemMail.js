// System emails (account emails, not tenant RFQ mail), sent through Resend.
import { liveSideEffects } from '../lib/runtime.js';
import { PRODUCT } from '../lib/brand.js';

const FROM = () => process.env.SYSTEM_MAIL_FROM || 'Quayly <no-reply@integratatech.ai>';
export const appUrl = () => (process.env.APP_URL || 'https://quayly.integratatech.ai').replace(/\/$/, '');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Branded layout with one call-to-action button. */
export function layout({ title, intro, button, link, outro }) {
  const html = `<div style="background:#f4f6f9;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:#1d2433">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e1e6ee;border-radius:12px;padding:28px">
    <div style="font-size:22px;font-weight:800;color:#0b2a4a;margin-bottom:18px">${esc(PRODUCT.name)}</div>
    <h2 style="font-size:18px;margin:0 0 12px;color:#0b2a4a">${esc(title)}</h2>
    <p style="font-size:14px;line-height:1.5;margin:0 0 20px">${esc(intro)}</p>
    <a href="${esc(link)}" style="display:inline-block;background:#0b6efd;color:#fff;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:8px">${esc(button)}</a>
    <p style="font-size:12px;color:#5a6b80;line-height:1.5;margin:20px 0 0">${esc(outro)}</p>
    <p style="font-size:12px;color:#5a6b80;word-break:break-all;margin:12px 0 0">If the button does not work, open this link:<br>${esc(link)}</p>
  </div>
  <p style="text-align:center;font-size:11px;color:#9aa5b4;margin-top:14px">${esc(PRODUCT.name)} by ${esc(PRODUCT.maker)}</p>
</div>`;
  const text = `${title}\n\n${intro}\n\n${button}: ${link}\n\n${outro}`;
  return { html, text };
}

export async function sendSystemMail({ to, subject, html, text }) {
  const key = liveSideEffects() ? process.env.RESEND_API_KEY : null;
  if (!key) {
    // development fallback: show the link in the server log instead of sending
    console.log(`[system mail not sent: RESEND_API_KEY missing] to=${to} subject="${subject}"\n${text}`);
    return { skipped: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM(), to: [to], subject, html, text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Resend error', res.status, body);
    throw Object.assign(new Error('Could not send the email right now. Please try again in a minute.'), { status: 502 });
  }
  return body;
}
