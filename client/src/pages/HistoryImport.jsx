// Import past business from Excel: preview first, then import; each import can be undone.
import { useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Card, Button, Badge, Table, useLoad, useAction, useToast, fmtDate, fmtDateTime } from '../components/ui.jsx';

const LEARNS = [
  ['Agent quotes and replies', 'Agent ranking, reply forecast and chasing, instant estimate, mode advice, missing charges, rate-card renewals'],
  ['Won / lost with your price', 'Margin advice (chance of winning at each margin)'],
  ['Jobs with booked ETA and arrival', 'Delay prediction (how late each lane and carrier usually is), space planning'],
  ['Customer invoices and payment dates', 'Customer payment grade and credit-limit advice'],
];

const OUTCOME = { accepted: ['green', 'won'], lost: ['red', 'lost'], expired: ['grey', 'no answer'] };

export default function HistoryImport() {
  const toast = useToast();
  const [busy, run] = useAction();
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const list = useLoad(() => api.get('/history/imports'), []);
  const form = () => { const fd = new FormData(); fd.append('file', file); return fd; };

  const choose = (f) => {
    setFile(f);
    setResult(null);
    setPreview(null);
    if (f) run('preview', async () => setPreview(await api.form('/history/preview', (() => { const fd = new FormData(); fd.append('file', f); return fd; })())));
  };
  const doImport = () => run('import', async () => {
    const r = await api.form('/history/import', form());
    setResult(r);
    setPreview(null);
    setFile(null);
    await list.reload();
    toast(`Imported ${r.counts.enquiries} enquiries`);
  });
  const undo = (b) => {
    if (!window.confirm(`Undo import #${b.id}? Its enquiries, agent quotes and jobs are removed. Contacts it added are kept if anything else uses them.`)) return;
    run(`undo${b.id}`, async () => { await api.post(`/history/imports/${b.id}/undo`); await list.reload(); }, 'Import undone');
  };
  const c = preview?.counts;

  return (
    <>
      <PageHeader title="Import history" sub="Bring in past enquiries, agent quotes and jobs, so the agent's skills are accurate from day one." />
      <Card title="What the agent learns from it">
        <Table rows={LEARNS.map(([a, b]) => ({ id: a, a, b }))} columns={[{ label: 'From', render: (x) => <b>{x.a}</b> }, { label: 'It improves', key: 'b' }]} />
        <p className="small muted">6 to 12 months is ideal. Only Enquiries is required; the other two sheets add more.</p>
      </Card>

      <Card title="Import">
        <ol className="howto">
          <li><a href="/api/history-template">Download the template</a>: three sheets (Enquiries, Agent quotes, Jobs) with examples and a Help sheet. You can paste your own columns in the same order.</li>
          <li>Choose your filled workbook. You'll see a preview first; nothing is saved until you press Import.</li>
        </ol>
        <div className="row gap-sm">
          <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => choose(e.target.files[0] || null)} />
          {busy === 'preview' && <span className="small muted">Checking…</span>}
        </div>

        {preview && (
          <div className="stack" style={{ marginTop: 14 }}>
            <div className="stats">
              <Stat n={c.enquiries} label="enquiries" sub={preview.from && `${fmtDate(preview.from)} – ${fmtDate(preview.to)}`} />
              <Stat n={c.agent_quotes} label="agent quotes" sub={`${c.no_reply} asked, no reply`} />
              <Stat n={preview.agents} label="agents" />
              <Stat n={preview.customers} label="customers" />
              <Stat n={c.won_lost} label="won / lost with price" />
              <Stat n={c.jobs} label="jobs" sub={`${c.invoices} with invoices`} />
            </div>
            {preview.replace.length > 0 && <div className="alert alert-blue small">{preview.replace.length} enquir{preview.replace.length > 1 ? 'ies were' : 'y was'} imported before and will be replaced: {preview.replace.slice(0, 8).join(', ')}{preview.replace.length > 8 ? '…' : ''}</div>}
            {preview.error_count > 0 && <Problems title={`${preview.error_count} row${preview.error_count > 1 ? 's' : ''} with problems (left out; fix and import again)`} rows={preview.errors} tone="amber" />}
            {preview.warnings.length > 0 && <Problems title="Notes" rows={preview.warnings} tone="blue" />}
            {preview.sample.length > 0 && (
              <Table
                rows={preview.sample.map((s) => ({ ...s, id: s.ref }))}
                columns={[
                  { label: 'Ref', render: (s) => <b>{s.ref}</b> }, { label: 'Date', render: (s) => fmtDate(s.date) }, { label: 'Customer', render: (s) => s.customer || '—' },
                  { label: 'Lane', render: (s) => `${s.mode} ${s.lane}` }, { label: 'Agents asked / quoted', render: (s) => `${s.agents} / ${s.quotes}` },
                  { label: 'Outcome', render: (s) => (OUTCOME[s.outcome] ? <Badge color={OUTCOME[s.outcome][0]}>{OUTCOME[s.outcome][1]}</Badge> : '—') }, { label: 'Job', render: (s) => (s.job ? '✓' : '') },
                ]}
              />
            )}
            <div className="row gap-sm">
              <Button disabled={!c.enquiries} busy={busy === 'import'} onClick={doImport}>Import {c.enquiries} enquiries</Button>
              <Button variant="ghost" onClick={() => choose(null)}>Cancel</Button>
            </div>
          </div>
        )}

        {result && (
          <div className="alert alert-green small" style={{ marginTop: 14 }}>
            Imported {result.counts.enquiries} enquiries, {result.counts.agent_quotes} agent quotes and {result.counts.jobs} jobs{result.counts.replaced ? ` (${result.counts.replaced} replaced)` : ''}. The agent has relearnt from it.
            {result.counts.skipped_rows > 0 && ` ${result.counts.skipped_rows} row(s) with problems were left out.`}
          </div>
        )}
      </Card>

      <Card title="Past imports">
        <Table
          rows={list.data || []}
          empty={list.loading ? 'Loading…' : 'Nothing imported yet.'}
          columns={[
            { label: '#', render: (b) => b.id },
            { label: 'File', render: (b) => <div>{b.filename || '—'}<div className="small muted">{fmtDateTime(b.created_at)}{b.by_name ? ` · ${b.by_name}` : ''}</div></div> },
            { label: 'Imported', render: (b) => <span className="small">{b.counts ? `${b.counts.enquiries} enquiries · ${b.counts.agent_quotes} quotes · ${b.counts.jobs} jobs` : '—'}</span> },
            { label: 'Still in Quayly', render: (b) => (b.undone_at ? <Badge>undone</Badge> : !b.enquiries_now && !b.jobs_now ? <span className="small muted">replaced by a later import</span> : <span className="small">{b.enquiries_now} enquiries · {b.jobs_now} jobs</span>) },
            { label: '', render: (b) => !b.undone_at && (b.enquiries_now > 0 || b.jobs_now > 0) && <Button small variant="ghost" busy={busy === `undo${b.id}`} onClick={() => undo(b)}>Undo</Button> },
          ]}
        />
      </Card>
    </>
  );
}

const Stat = ({ n, label, sub }) => (
  <div className="stat"><b>{n}</b><span>{label}{sub ? ` · ${sub}` : ''}</span></div>
);

const Problems = ({ title, rows, tone }) => (
  <div className={`alert alert-${tone} small`}>
    <b>{title}</b>
    <ul className="reasons">{rows.slice(0, 30).map((e, i) => <li key={i}>{e.sheet} row {e.row}: {e.message}</li>)}</ul>
    {rows.length > 30 && <div>…and {rows.length - 30} more</div>}
  </div>
);
