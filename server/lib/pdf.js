// Shared PDF layout for every document Quayly prints: quotations, shipping instructions.
import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT } from './brand.js';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
export const BLUE = '#0b2a4a';

function decodeImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(dataUrl || '');
  return m ? Buffer.from(m[2], 'base64') : null;
}

/** New A4 document. zh = true registers Traditional Chinese fonts. Returns { doc, REG, BOLD, done }. */
export function createPdf({ title, zh = false }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: title, Producer: PRODUCT.name } });
  if (zh) {
    doc.registerFont('zh', path.join(FONT_DIR, 'NotoSansTC-Regular.ttf'));
    doc.registerFont('zh-b', path.join(FONT_DIR, 'NotoSansTC-Bold.ttf'));
  }
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  return { doc, REG: zh ? 'zh' : 'Helvetica', BOLD: zh ? 'zh-b' : 'Helvetica-Bold', done };
}

/** Company letterhead (logo, name, contact line) then a document title with its reference. */
export function letterhead(doc, company, { REG, BOLD }, title, ref) {
  const logo = decodeImage(company.logo);
  let textX = 40;
  if (logo) {
    try { doc.image(logo, 40, 36, { fit: [90, 50] }); textX = 140; } catch { /* unreadable logo */ }
  }
  doc.fillColor(BLUE).fontSize(17).font(BOLD).text(company.name || '', textX, 40, { width: 555 - textX });
  doc.fontSize(8.5).font(REG).fillColor('#444').text([company.address, company.phone, company.email, company.gstin && `${company.country === 'HK' ? 'BR' : 'GSTIN'}: ${company.gstin}`].filter(Boolean).join('  |  '), textX, doc.y, { width: 555 - textX });
  doc.y = Math.max(doc.y, logo ? 92 : doc.y);
  doc.moveDown(0.8);
  doc.fillColor(BLUE).fontSize(14).font(BOLD).text(title, 40, doc.y, { continued: !!ref });
  if (ref) doc.font(REG).fontSize(10).fillColor('#444').text(`   ${ref}`);
  doc.moveDown(0.3);
}

/** Label / value rows. */
export function kvRows(doc, rows, { REG, BOLD }, { labelWidth = 110, size = 9 } = {}) {
  doc.fontSize(size);
  for (const [k, v] of rows.filter(([, x]) => x !== null && x !== undefined && x !== '')) {
    if (doc.y > 770) doc.addPage();
    const y = doc.y;
    doc.font(BOLD).fillColor('#333').text(k, 40, y, { width: labelWidth });
    doc.font(REG).text(String(v), 40 + labelWidth, y, { width: 515 - labelWidth });
  }
}

/** Bordered boxes side by side (e.g. shipper / consignee / notify). boxes: [{ title, text }] */
export function boxes(doc, items, { REG, BOLD }) {
  const w = 515 / items.length;
  const y = doc.y;
  let h = 0;
  doc.fontSize(8.5);
  for (const b of items) h = Math.max(h, doc.font(REG).heightOfString(b.text || '-', { width: w - 12 }) + 22);
  if (y + h > 780) { doc.addPage(); return boxes(doc, items, { REG, BOLD }); }
  items.forEach((b, i) => {
    const x = 40 + i * w;
    doc.rect(x, y, w, h).strokeColor('#c9d2de').lineWidth(0.7).stroke();
    doc.font(BOLD).fontSize(8).fillColor(BLUE).text(b.title, x + 6, y + 5, { width: w - 12 });
    doc.font(REG).fontSize(8.5).fillColor('#222').text(b.text || '-', x + 6, y + 17, { width: w - 12 });
  });
  doc.y = y + h + 8;
}

/** Simple table. cols: [{ label, width, align }]; rows: arrays of strings. */
export function table(doc, cols, rows, { REG, BOLD }) {
  const head = () => {
    const y = doc.y;
    doc.rect(40, y - 3, 515, 16).fill(BLUE);
    doc.fillColor('#fff').font(BOLD).fontSize(8.5);
    let x = 40;
    for (const c of cols) { doc.text(c.label, x + 3, y, { width: c.width - 6, align: c.align || 'left' }); x += c.width; }
    doc.y = y + 18;
  };
  head();
  for (const r of rows) {
    doc.font(REG).fontSize(8.5).fillColor('#222');
    const h = Math.max(11, ...r.map((v, i) => doc.heightOfString(String(v ?? ''), { width: cols[i].width - 6 })));
    if (doc.y + h > 780) { doc.addPage(); doc.y = 50; head(); }
    const y = doc.y;
    let x = 40;
    r.forEach((v, i) => { doc.text(String(v ?? ''), x + 3, y, { width: cols[i].width - 6, align: cols[i].align || 'left' }); x += cols[i].width; });
    doc.y = y + h + 5;
    doc.moveTo(40, doc.y - 2).lineTo(555, doc.y - 2).strokeColor('#e1e6ee').lineWidth(0.5).stroke();
  }
  doc.moveDown(0.4);
}

/** Product footer on every page, then close. Resolves to the PDF buffer. */
export function finish(pdf) {
  const { doc, done } = pdf;
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // allow writing in the footer area without adding a page
    doc.font('Helvetica').fontSize(7).fillColor('#9aa5b4').text(`Prepared with ${PRODUCT.name} · quayly.integratatech.ai`, 40, 812, { width: 515, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}
