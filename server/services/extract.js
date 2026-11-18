// Turns email attachments into content blocks the AI can read.
import * as XLSX from 'xlsx';

const MAX_TEXT = 60000;

function sheetToText(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  return wb.SheetNames.map((n) => `--- Sheet: ${n} ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })}`).join('\n').slice(0, MAX_TEXT);
}

/** Returns Anthropic content blocks for one attachment. */
export function attachmentBlocks(att) {
  const name = att.filename || 'attachment';
  const type = (att.content_type || '').toLowerCase();
  const data = Buffer.isBuffer(att.data) ? att.data : Buffer.from(att.data || []);
  if (!data.length) return [];
  if (type.includes('pdf') || /\.pdf$/i.test(name)) {
    if (data.length > 20 * 1024 * 1024) return [{ type: 'text', text: `[Attachment ${name}: PDF too large to read]` }];
    return [
      { type: 'text', text: `Attachment: ${name}` },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } },
    ];
  }
  if (/image\/(png|jpe?g|gif|webp)/.test(type) || /\.(png|jpe?g|gif|webp)$/i.test(name)) {
    const media = type.startsWith('image/') ? type.replace('jpg', 'jpeg') : `image/${name.split('.').pop().toLowerCase().replace('jpg', 'jpeg')}`;
    if (data.length > 5 * 1024 * 1024) return [{ type: 'text', text: `[Attachment ${name}: image too large]` }];
    return [{ type: 'text', text: `Attachment: ${name}` }, { type: 'image', source: { type: 'base64', media_type: media, data: data.toString('base64') } }];
  }
  if (/sheet|excel|csv/.test(type) || /\.(xlsx|xls|csv|ods)$/i.test(name)) {
    try {
      return [{ type: 'text', text: `Attachment: ${name}\n${sheetToText(data)}` }];
    } catch (e) {
      return [{ type: 'text', text: `[Attachment ${name}: could not read spreadsheet: ${e.message}]` }];
    }
  }
  if (type.startsWith('text/') || /\.(txt|html?)$/i.test(name)) {
    return [{ type: 'text', text: `Attachment: ${name}\n${data.toString('utf8').slice(0, MAX_TEXT)}` }];
  }
  return [{ type: 'text', text: `[Attachment ${name} (${type || 'unknown type'}) not readable]` }];
}

export function htmlToText(html = '') {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
