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
const wb = XLSX.read(Buffer.from(buf), { type: 'buffer', cellDates: mode === 'rows' });
if (mode === 'csv') {
  parentPort.postMessage(wb.SheetNames.map((n) => ({ name: n, csv: XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false }) })));
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
