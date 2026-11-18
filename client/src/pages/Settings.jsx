import { useState } from 'react';
import { api } from '../api.js';
import { useMeta } from '../components/meta.jsx';
import { PageHeader, Card, Table, Button, Modal, FormGrid, Field, Input, Select, Check, Badge, Tabs, Loading, useLoad, useAction, fmtDateTime } from '../components/ui.jsx';

export default function Settings({ user }) {
  const [tab, setTab] = useState('mail');
  const s = useLoad(() => api.get('/settings'));
  const admin = user.role === 'admin';
  return (
    <>
      <PageHeader title="Settings" sub={admin ? null : 'Only admins can change settings.'} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'mail', label: 'RFQ mailboxes' },
        { key: 'ai', label: 'AI' },
        { key: 'company', label: 'Company' },
        { key: 'pricing', label: 'Pricing & FX' },
        { key: 'users', label: 'Users' },
      ]} />
      {tab === 'mail' && <Mailboxes />}
      {!s.data ? <Loading /> : (
        <>
          {tab === 'ai' && <AiSettings data={s.data} onSaved={s.setData} />}
          {tab === 'company' && <SimpleSettings k="company" data={s.data} onSaved={s.setData} fields={[
            { key: 'name', label: 'Company name' }, { key: 'gstin', label: 'GSTIN / BR number' }, { key: 'country', label: 'Country', type: 'select', options: ['IN', 'HK'] },
            { key: 'address', label: 'Address', span: 2 }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
          ]} />}
          {tab === 'pricing' && <PricingSettings data={s.data} onSaved={s.setData} />}
        </>
      )}
      {tab === 'users' && <Users admin={admin} />}
    </>
  );
}

const PRESETS = {
  google: { label: 'Google Workspace / Gmail', smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: true, imap_host: 'imap.gmail.com', imap_port: 993, imap_secure: true, note: 'Use an App Password (Google Account → Security → 2-Step Verification → App passwords).' },
  m365: { label: 'Microsoft 365 / Outlook', smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_secure: false, imap_host: 'outlook.office365.com', imap_port: 993, imap_secure: true, note: 'SMTP AUTH and IMAP must be enabled for this mailbox in the Microsoft 365 admin centre.' },
  zoho: { label: 'Zoho Mail (India)', smtp_host: 'smtp.zoho.in', smtp_port: 465, smtp_secure: true, imap_host: 'imap.zoho.in', imap_port: 993, imap_secure: true, note: 'Enable IMAP access in Zoho Mail settings; use an app-specific password if 2FA is on.' },
  custom: { label: 'Other (custom SMTP/IMAP)', note: 'Get the SMTP and IMAP server details from your email provider.' },
};

const presetCfg = (k) => { const { label, note, ...cfg } = PRESETS[k]; return cfg; };

function Mailboxes() {
  const list = useLoad(() => api.get('/mailboxes'));
  const [edit, setEdit] = useState(null);
  const [test, setTest] = useState(null);
  const [busy, run] = useAction();
  return (
    <>
      <Card title="Dedicated RFQ email addresses" actions={<Button onClick={() => setEdit({ active: true, reminder_hours: 24, max_reminders: 2, subject_template: 'Rate request {{route}} {{tag}}', imap_folder: 'INBOX', preset: 'google', ...presetCfg('google') })}>+ Add mailbox</Button>}>
        <p className="muted small">RFQs to partner agents are sent from, and replies read from, these addresses. Each branch can have its own.</p>
        {list.loading ? <Loading /> : (
          <Table rows={list.data} empty="No mailbox yet. Add one to start emailing agents." onRowClick={(m) => setEdit({ ...m })} columns={[
            { key: 'label', label: 'Label', render: (m) => <><b>{m.label}</b> {m.is_default && <Badge color="blue">default</Badge>} {!m.active && <Badge>inactive</Badge>}</> },
            { key: 'from_email', label: 'Address', render: (m) => `${m.from_name} <${m.from_email}>` },
            { label: 'Sending', render: (m) => (m.smtp_host && m.has_smtp_pass ? <Badge color="green">ready</Badge> : <Badge color="amber">not set</Badge>) },
            { label: 'Receiving', render: (m) => (m.imap_host && m.has_imap_pass ? <Badge color="green">ready</Badge> : <Badge color="amber">not set</Badge>) },
            { label: 'Last check', render: (m) => <>{fmtDateTime(m.last_poll_at)}{m.last_poll_error && <div className="err small">{m.last_poll_error}</div>}</> },
            { label: '', render: (m) => (
              <div className="row gap-sm" onClick={(e) => e.stopPropagation()}>
                <Button small variant="ghost" busy={busy === `t${m.id}`} onClick={() => run(`t${m.id}`, async () => setTest({ m, r: await api.post(`/mailboxes/${m.id}/test`) }))}>Test</Button>
                <Button small variant="ghost" busy={busy === `p${m.id}`} onClick={() => run(`p${m.id}`, async () => { const r = await api.post(`/mailboxes/${m.id}/poll`); await list.reload(); return r; }, 'Checked for new mail')}>Check now</Button>
              </div>
            ) },
          ]} />
        )}
      </Card>
      {edit && <MailboxModal value={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); list.reload(); }} />}
      {test && (
        <Modal title={`Connection test: ${test.m.label}`} onClose={() => setTest(null)}>
          <p><b>Sending (SMTP):</b> {test.r.smtp.ok ? <Badge color="green">ok</Badge> : <><Badge color="red">failed</Badge> <span className="small">{test.r.smtp.error}</span></>}</p>
          <p><b>Receiving (IMAP):</b> {test.r.imap.ok ? <><Badge color="green">ok</Badge> <span className="small">{test.r.imap.messages} messages in folder</span></> : <><Badge color="red">failed</Badge> <span className="small">{test.r.imap.error}</span></>}</p>
          <p className="muted small">To stop RFQs landing in spam on a custom domain, make sure SPF, DKIM and DMARC records are set for the sending domain.</p>
        </Modal>
      )}
    </>
  );
}

function MailboxModal({ value, onClose, onDone }) {
  const [m, setM] = useState({ preset: value.id ? 'custom' : 'google', ...value });
  const [busy, run] = useAction();
  const preset = PRESETS[m.preset] || PRESETS.custom;
  const applyPreset = (p) => setM({ ...m, ...presetCfg(p), preset: p });
  const save = () => run('x', async () => {
    const { preset: _p, has_smtp_pass, has_imap_pass, last_poll_at, last_poll_error, created_at, last_uid, ...body } = m;
    if (m.id) await api.put(`/mailboxes/${m.id}`, body);
    else await api.post('/mailboxes', body);
    onDone();
  }, 'Mailbox saved');
  return (
    <Modal wide title={m.id ? `Mailbox: ${m.label}` : 'Add RFQ mailbox'} onClose={onClose} footer={<Button busy={busy} onClick={save}>Save</Button>}>
      <div className="stack">
        <FormGrid cols={3} value={m} onChange={setM} fields={[
          { key: 'label', label: 'Label', placeholder: 'e.g. Chennai branch' },
          { key: 'from_name', label: 'Sender name', placeholder: 'e.g. ABC Logistics Pricing' },
          { key: 'from_email', label: 'RFQ email address', type: 'email', placeholder: 'rfq@yourcompany.com' },
          { key: 'reply_to', label: 'Reply-to (optional)', hint: 'Leave blank so replies come back to this mailbox' },
          { key: 'cc', label: 'Always CC (optional)' },
          { key: 'bcc', label: 'Always BCC (optional)' },
          { key: 'subject_template', label: 'Subject format', span: 2, hint: 'Placeholders: {{route}} {{ref}} {{mode}} {{tag}}. The reference tag is always added.' },
          { key: 'reminder_hours', label: 'Auto-remind after (hours, 0 = off)', type: 'number' },
          { key: 'max_reminders', label: 'Max reminders', type: 'number' },
          { key: 'is_default', label: 'Default', type: 'checkbox', checkLabel: 'Default mailbox' },
          { key: 'active', label: 'Status', type: 'checkbox', checkLabel: 'Active' },
          { key: 'signature', label: 'Email signature', type: 'textarea', span: 3, rows: 3 },
        ]} />
        <Field label="Email provider">
          <Select options={Object.entries(PRESETS).map(([k, v]) => ({ value: k, label: v.label }))} value={m.preset} onChange={(e) => applyPreset(e.target.value)} />
        </Field>
        <div className="alert alert-blue small">{preset.note}</div>
        <div className="grid g2">
          <Card title="Sending (SMTP)">
            <FormGrid cols={2} value={m} onChange={setM} fields={[
              { key: 'smtp_host', label: 'Server' }, { key: 'smtp_port', label: 'Port', type: 'number' },
              { key: 'smtp_user', label: 'Username' }, { key: 'smtp_pass', label: m.has_smtp_pass ? 'Password (saved, leave blank to keep)' : 'Password', type: 'password' },
              { key: 'smtp_secure', label: 'Security', type: 'checkbox', checkLabel: 'SSL/TLS (port 465)' },
            ]} />
          </Card>
          <Card title="Receiving (IMAP)">
            <FormGrid cols={2} value={m} onChange={setM} fields={[
              { key: 'imap_host', label: 'Server' }, { key: 'imap_port', label: 'Port', type: 'number' },
              { key: 'imap_user', label: 'Username' }, { key: 'imap_pass', label: m.has_imap_pass ? 'Password (saved, leave blank to keep)' : 'Password', type: 'password' },
              { key: 'imap_folder', label: 'Folder' },
              { key: 'imap_secure', label: 'Security', type: 'checkbox', checkLabel: 'SSL/TLS' },
            ]} />
          </Card>
        </div>
      </div>
    </Modal>
  );
}

function AiSettings({ data, onSaved }) {
  const [f, setF] = useState({ model: data.ai.model, auto_parse: data.ai.auto_parse, review_threshold: data.ai.review_threshold, api_key: '' });
  const [busy, run] = useAction();
  return (
    <Card title="AI reply reader" actions={<Button busy={busy} onClick={() => run('x', async () => onSaved(await api.put('/settings/ai', f)), 'AI settings saved')}>Save</Button>}>
      <p className="muted small">The AI reads partner-agent replies (email text, PDF, Excel and scanned rate sheets) and fills in the quote. Status: {data.ai.has_key ? <Badge color="green">API key set</Badge> : <Badge color="amber">no API key</Badge>}</p>
      <div className="grid g3">
        <Field label="Anthropic API key" hint="Stored encrypted. Leave blank to keep the current key."><Input type="password" value={f.api_key} onChange={(e) => setF({ ...f, api_key: e.target.value })} placeholder="sk-ant-…" /></Field>
        <Field label="Model"><Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
        <Field label="Review if confidence below" hint="0–1. Lower-confidence quotes are flagged for a person to check."><Input type="number" step="0.05" value={f.review_threshold} onChange={(e) => setF({ ...f, review_threshold: Number(e.target.value) })} /></Field>
      </div>
      <Check label="Read replies automatically as they arrive" checked={f.auto_parse} onChange={(v) => setF({ ...f, auto_parse: v })} />
    </Card>
  );
}

function SimpleSettings({ k, data, onSaved, fields }) {
  const [f, setF] = useState(data[k]);
  const [busy, run] = useAction();
  return (
    <Card actions={<Button busy={busy} onClick={() => run('x', async () => onSaved(await api.put(`/settings/${k}`, f)), 'Saved')}>Save</Button>}>
      <FormGrid fields={fields} value={f} onChange={setF} />
    </Card>
  );
}

function PricingSettings({ data, onSaved }) {
  const meta = useMeta();
  const [p, setP] = useState(data.pricing);
  const [fx, setFx] = useState(data.fx);
  const [busy, run] = useAction();
  const save = () => run('x', async () => { await api.put('/settings/pricing', p); onSaved(await api.put('/settings/fx', fx)); }, 'Saved');
  return (
    <Card actions={<Button busy={busy} onClick={save}>Save</Button>}>
      <FormGrid value={p} onChange={setP} cols={5} fields={[
        { key: 'default_margin_pct', label: 'Default margin % (customers)', type: 'number' },
        { key: 'default_agent_margin_pct', label: 'Default margin % (partner agents)', type: 'number' },
        { key: 'floor_margin_pct', label: 'Minimum margin % (needs approval below)', type: 'number' },
        { key: 'default_tax_pct', label: 'GST % on INR quotes', type: 'number' },
        { key: 'quote_validity_days', label: 'Customer quote validity (days)', type: 'number' },
        { key: 'terms', label: 'Default terms on quotations', type: 'textarea', span: 5, rows: 4 },
      ]} />
      <h4>Exchange rates</h4>
      <div className="grid g6">
        <Field label="Base currency"><Select options={meta.currencies} value={fx.base} onChange={(e) => setFx({ ...fx, base: e.target.value })} /></Field>
        {meta.currencies.filter((c) => c !== fx.base).map((c) => (
          <Field key={c} label={`1 ${c} = ? ${fx.base}`}><Input type="number" step="0.0001" value={fx.rates[c]} onChange={(e) => setFx({ ...fx, rates: { ...fx.rates, [c]: Number(e.target.value) } })} /></Field>
        ))}
      </div>
    </Card>
  );
}

function Users({ admin }) {
  const list = useLoad(() => api.get('/users').catch(() => []));
  const [f, setF] = useState(null);
  const [busy, run] = useAction();
  return (
    <Card title="Users" actions={admin && <Button onClick={() => setF({ role: 'user' })}>+ Add user</Button>}>
      <Table rows={list.data} columns={[{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'role', label: 'Role' }]} />
      {f && (
        <Modal title="Add user" onClose={() => setF(null)} footer={<Button busy={busy} onClick={() => run('x', async () => { await api.post('/users', f); setF(null); list.reload(); }, 'User added')}>Add</Button>}>
          <FormGrid cols={2} value={f} onChange={setF} fields={[{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email', type: 'email' }, { key: 'password', label: 'Temporary password', type: 'password' }, { key: 'role', label: 'Role', type: 'select', options: ['user', 'admin'] }]} />
        </Modal>
      )}
    </Card>
  );
}
