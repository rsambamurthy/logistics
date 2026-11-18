import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from './db.js';
import api from './routes/api.js';
import { pollAll } from './services/mail.js';
import { autoRemind } from './services/rfq.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
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
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

const POLL_SECONDS = Number(process.env.MAIL_POLL_SECONDS || 60);
const port = Number(process.env.PORT || 3000);

(async () => {
  await migrate();
  app.listen(port, () => console.log(`AgentQuote listening on ${port}`));
  setInterval(() => pollAll().catch((e) => console.error('poll', e.message)), POLL_SECONDS * 1000);
  setInterval(() => autoRemind().catch((e) => console.error('remind', e.message)), 15 * 60 * 1000);
})().catch((e) => {
  console.error('Startup failed', e);
  process.exit(1);
});
