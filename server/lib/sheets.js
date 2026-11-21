// Reading spreadsheets from outside (agent emails, uploads) in a separate worker thread with a time limit.
// The spreadsheet library has known issues with crafted files (prototype pollution, slow regular expressions);
// a worker keeps any such effect out of the main server and is stopped if it runs too long.
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

const XLSX_PATH = createRequire(import.meta.url).resolve('xlsx');

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { buf, mode, sheet, xlsxPath } = workerData;
const XLSX = require(xlsxPath);
const wb = XLSX.read(Buffer.from(buf), { type: 'buffer', cellDates: mode !== 'csv' });
if (mode === 'csv') {
  parentPort.postMessage(wb.SheetNames.map((n) => ({ name: n, csv: XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false }) })));
} else if (mode === 'all') {
  const out = {};
  for (const n of wb.SheetNames) out[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '' }).map((r) => JSON.parse(JSON.stringify(r)));
  parentPort.postMessage(out);
} else {
  const ws = (sheet && wb.Sheets[sheet]) || wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' }).map((r) => JSON.parse(JSON.stringify(r)));
  parentPort.postMessage(rows);
}`;

function run(buf, mode, sheet, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { eval: true, workerData: { buf, mode, sheet, xlsxPath: XLSX_PATH }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => { w.terminate(); reject(new Error('Spreadsheet took too long to read')); }, timeoutMs);
    w.once('message', (m) => { clearTimeout(timer); w.terminate(); resolve(m); });
    w.once('error', (e) => { clearTimeout(timer); reject(e); });
    w.once('exit', (code) => { clearTimeout(timer); if (code) reject(new Error('Spreadsheet could not be read')); });
  });
}

/** All sheets as CSV text: [{ name, csv }] */
export const sheetsAsCsv = (buf) => run(buf, 'csv');
/** Rows (objects keyed by the header row) of the named sheet, else the first. Dates come back as ISO strings. */
export const sheetRows = (buf, sheet) => run(buf, 'rows', sheet);
/** Every sheet's rows: { [sheetName]: rows }. */
export const allSheetRows = (buf) => run(buf, 'all');

// ---------------- reading cell values (shared by every Excel import) ----------------

/** Header "Gross weight (kg)" -> "gross_weight_kg"; trims text values. */
export const normaliseRows = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [String(k).trim().toLowerCase().replace(/\(.*?\)/g, '').trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), typeof v === 'string' ? v.trim() : v])));

/** A date cell (Excel serial, ISO, dd/mm/yyyy or dd-mm-yyyy) as YYYY-MM-DD, else null. */
export const toDate = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}T/.test(String(v))) return String(v).slice(0, 10); // dates from the spreadsheet reader
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // dd/mm/yyyy
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

/** A number cell ("1,250.50" allowed), else null. */
export const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
};

/** yes / y / true / 1 / x */
export const yes = (v) => /^(y|yes|true|1|x)$/i.test(String(v ?? '').trim());
