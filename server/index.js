import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from './db.js';
import api from './routes/api.js';
import { pollAll } from './services/mail.js';
import { autoRemind } from './services/rfq.js';
import { forEachTenant } from './services/tenants.js';
import { quoteHousekeeping } from './services/customerQuote.js';
import { PRODUCT } from './lib/brand.js';
import { lifecycleSweep } from './services/lifecycle.js';
import { trackingSweep } from './services/tracking.js';
import { liveSideEffects } from './lib/runtime.js';
import { securityHeaders } from './lib/security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit: '5mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (15 MB maximum).' });
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Too many files.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  // never show internal error text (database messages, stack details) to the browser
  res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message || 'Error' });
});

const POLL_SECONDS = Number(process.env.MAIL_POLL_SECONDS || 60);
const port = Number(process.env.PORT || 3000);

(async () => {
  if (process.env.NODE_ENV === 'production' && (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32)) throw new Error('APP_SECRET must be set (32+ characters) in production');
  await migrate();
  app.listen(port, () => console.log(`${PRODUCT.name} listening on ${port}`));
  if (!liveSideEffects()) {
    console.log('Test copy: background jobs, mailbox polling and outgoing email are switched off (SIDE_EFFECTS=on to enable).');
    return;
  }
  // background work runs once per tenant, inside that tenant's context
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await forEachTenant(() => pollAll()); } catch (e) { console.error('poll', e.message); } finally { busy = false; }
  }, POLL_SECONDS * 1000);
  setInterval(() => forEachTenant(async () => { await autoRemind(); await quoteHousekeeping(); }).catch((e) => console.error('housekeeping', e.message)), 15 * 60 * 1000);
  // live tracking: due shipments every 30 minutes (each provider call has a quota, so polling is per job setting)
  setInterval(() => forEachTenant(() => trackingSweep()).catch((e) => console.error('tracking', e.message)), 30 * 60 * 1000);
  // account emails (trial reminders, overdue notices): shortly after start, then hourly
  const sweep = () => lifecycleSweep().then((n) => n && console.log(`lifecycle emails sent: ${n}`)).catch((e) => console.error('lifecycle', e.message));
  setTimeout(sweep, 60 * 1000);
  setInterval(sweep, 60 * 60 * 1000);
})().catch((e) => {
  console.error('Startup failed', e);
  process.exit(1);
});
