import { useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { useCan } from '../components/session.js';
import Roles from './Roles.jsx';
import RateCards from './RateCards.jsx';
import Agents from './Agents.jsx';
import Customers from './Customers.jsx';
import Subscription from './Subscription.jsx';
import Activity from './Activity.jsx';
import { Tenants, Plans } from './Platform.jsx';
import { api } from '../api.js';
import { useMeta } from '../components/meta.jsx';
import { ReadOnly, PageHeader, Card, Table, Button, Modal, FormGrid, Field, Input, Select, Check, Badge, SideMenu, Loading, useLoad, useAction, useToast, fmtDateTime } from '../components/ui.jsx';
import RolePicker, { RolePills } from '../components/RolePicker.jsx';
import ApprovalLevels from '../components/ApprovalLevels.jsx';

// Settings holds everything that is not a transaction: contacts, pricing data and system setup.
const SECTIONS = [
  { group: 'Contacts' },
  // view = permission to see the page (no page without it); edit = permission to change it (otherwise shown read-only)
  { key: 'partner-agents', label: 'Partner agents', hint: 'Who you ask for rates', view: 'contacts.manage' },
  { key: 'customers', label: 'Customers', hint: 'Who asks you for rates', view: 'contacts.manage' },
  { group: 'Pricing' },
  { key: 'rate-cards', label: 'Rate cards', hint: 'Stored buy rates that price RFQs instantly', view: 'ratecards.manage' },
  { key: 'pricing', label: 'Pricing & FX', hint: 'Margins, tax, validity, exchange rates', view: 'settings.manage' },
  { group: 'System' },
  { key: 'mailboxes', label: 'RFQ mailboxes', hint: 'Addresses used to email agents and read replies', view: 'settings.manage' },
  { key: 'company', label: 'Company', hint: 'Details printed on quotations', view: 'settings.manage' },
  { key: 'ai', label: 'AI', hint: 'Reading replies and enquiries', view: 'settings.manage' },
  { key: 'tracking', label: 'Tracking', hint: 'Live tracking and customer updates', view: 'settings.manage' },
  { key: 'users', label: 'Users', hint: 'Who can sign in', view: 'users.manage' },
  { key: 'roles', label: 'Roles', hint: 'What each role can see and do', view: 'users.manage' },
  { key: 'subscription', label: 'Subscription', hint: 'Plan, usage and billing', view: 'billing.manage' },
  { key: 'activity', label: 'Activity log', hint: 'Who did what, and when', view: 'audit.view' },
  { group: 'Integrata admin', platform: true },
  { key: 'tenants', label: 'Tenants', hint: 'All companies on the platform', platform: true },
  { key: 'plans', label: 'Plans', hint: 'Prices and limits', platform: true },
];

/** Settings pages this user's roles allow (group headings with nothing under them dropped). */
export function settingsSections(user) {
  const perms = user?.perms || [];
  const visible = SECTIONS.filter((x) => (x.platform ? user?.platform_admin : !x.view || perms.includes(x.view)));
  return visible.filter((x, i) => !x.group || (visible[i + 1] && !visible[i + 1].group));
}

export default function Settings({ user }) {
  const { section } = useParams();
  const s = useLoad(() => api.get('/settings'));
  const can = useCan();
  const items = settingsSections(user);
  const current = items.find((x) => x.key === section);
  const first = items.find((x) => x.key);
  if (!first) return <div className="alert alert-amber">Your role has no settings to show.</div>;
  if (!current) return <Navigate to={`/settings/${first.key}`} replace />;
  const readOnly = current.edit && !can(current.edit);
  return (
    <div className="with-subnav">
      <SideMenu title="Settings" items={items.map((x) => (x.group ? x : { to: `/settings/${x.key}`, label: x.label, hint: x.hint }))} />
      <div className="subnav-body">
        <ReadOnly when={readOnly}>
        {current.key === 'mailboxes' && <><PageHeader title="RFQ mailboxes" /><Mailboxes /></>}
        {current.key === 'rate-cards' && <RateCards />}
        {current.key === 'partner-agents' && <Agents />}
        {current.key === 'subscription' && <Subscription admin={can('billing.manage')} />}
        {current.key === 'activity' && <Activity />}
        {current.key === 'tenants' && user.platform_admin && <Tenants />}
        {current.key === 'plans' && user.platform_admin && <Plans />}
        {current.key === 'customers' && <Customers />}
        {current.key === 'users' && <><PageHeader title="Users" /><Users admin me={user} /></>}
        {current.key === 'roles' && <Roles />}
        </ReadOnly>
        {['ai', 'tracking', 'company', 'pricing'].includes(current.key) && (!s.data ? <Loading /> : (
          <>
            <PageHeader title={current.label} sub={current.hint} />
            {current.key === 'ai' && <AiSettings data={s.data} onSaved={s.setData} />}
            {current.key === 'tracking' && <TrackingSettings data={s.data} onSaved={s.setData} />}
            {current.key === 'company' && <SimpleSettings k="company" data={s.data} onSaved={s.setData} extra={(f, setF) => <LogoField value={f.logo} onChange={(logo) => setF({ ...f, logo })} />} fields={[
              { key: 'name', label: 'Company name' }, { key: 'gstin', label: 'GSTIN / BR number' }, { key: 'country', label: 'Country', type: 'select', options: [{ value: 'IN', label: 'India' }, { value: 'HK', label: 'Hong Kong' }] },
              { key: 'address', label: 'Address', span: 2 }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
              { key: 'bank_name', label: 'Bank name (printed on quotations)' }, { key: 'bank_account_name', label: 'Account name' }, { key: 'bank_account_no', label: 'Account number' },
              { key: 'bank_ifsc', label: 'IFSC (India)' }, { key: 'bank_swift', label: 'SWIFT' }, { key: 'bank_branch', label: 'Branch' },
            ]} />}
            {current.key === 'pricing' && <PricingSettings data={s.data} onSaved={s.setData} />}
          </>
        ))}
      </div>
    </div>
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
      <p className="muted small">The AI reads partner-agent replies (email text, PDF, Excel and scanned rate sheets) and fills in the quote. Status: {data.ai.has_key ? <Badge color="green">your own API key</Badge> : data.ai.platform_key ? <Badge color="green">included in your plan</Badge> : <Badge color="amber">no API key</Badge>}</p>
      <div className="grid g3">
        <Field label="Your own Anthropic API key (optional)" hint="Stored encrypted. Only needed if AI is not included in your plan. Leave blank to keep the current key."><Input type="password" value={f.api_key} onChange={(e) => setF({ ...f, api_key: e.target.value })} placeholder="sk-ant-…" /></Field>
        <Field label="Model"><Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
        <Field label="Review if confidence below" hint="0–1. Lower-confidence quotes are flagged for a person to check."><Input type="number" step="0.05" value={f.review_threshold} onChange={(e) => setF({ ...f, review_threshold: Number(e.target.value) })} /></Field>
      </div>
      <Check label="Read replies automatically as they arrive" checked={f.auto_parse} onChange={(v) => setF({ ...f, auto_parse: v })} />
    </Card>
  );
}

function TrackingSettings({ data, onSaved }) {
  const t = data.tracking;
  const providers = useLoad(() => api.get('/tracking/providers'));
  const [f, setF] = useState({ provider: t.provider, enabled: t.enabled, poll_hours: t.poll_hours, auto_milestones: t.auto_milestones, email_milestones: t.email_milestones, eta_change_hours: t.eta_change_hours, notify_agents_default: t.notify_agents_default, api_key: '' });
  const [busy, run] = useAction();
  const prov = (providers.data || []).find((p) => p.code === f.provider);
  return (
    <Card title="Live tracking" actions={<Button busy={busy} onClick={() => run('x', async () => { onSaved(await api.put('/settings/tracking', f)); setF({ ...f, api_key: '' }); }, 'Tracking settings saved')}>Save</Button>}>
      <p className="muted small">Quayly follows each booked job by its BL, booking or container number (AWB for air), moves the job to departed and arrived on its own, and emails your customer with a tracking link. Status: {t.has_key ? <Badge color="green">your API key</Badge> : t.platform_key ? <Badge color="green">included in your plan</Badge> : <Badge color="amber">no API key — tracking is off</Badge>}</p>
      <div className="grid g3">
        <Field label="Tracking data provider"><Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} options={(providers.data || []).map((p) => ({ value: p.code, label: `${p.name} (${p.modes.join(' + ')})` }))} /></Field>
        <Field label={`${prov?.name || 'Provider'} API key`} hint={<>Stored encrypted. Leave blank to keep the current key. {prov?.signup && <a href={prov.signup} target="_blank" rel="noreferrer">Get a key</a>}</>}><Input type="password" value={f.api_key} onChange={(e) => setF({ ...f, api_key: e.target.value })} /></Field>
        <Field label="Check each shipment every (hours)" hint="Each check uses provider quota. 6 hours suits most sea shipments."><Input type="number" min="1" value={f.poll_hours} onChange={(e) => setF({ ...f, poll_hours: Number(e.target.value) })} /></Field>
        <Field label="Email the customer when ETA moves by (hours)"><Input type="number" min="1" value={f.eta_change_hours} onChange={(e) => setF({ ...f, eta_change_hours: Number(e.target.value) })} /></Field>
      </div>
      <div className="stack-sm" style={{ marginTop: 10 }}>
        <Check label="Live tracking on" checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} />
        <Check label="Move jobs to departed / arrived automatically from tracking" checked={f.auto_milestones} onChange={(v) => setF({ ...f, auto_milestones: v })} />
        <Check label="Email milestone and ETA updates to the customer" checked={f.email_milestones} onChange={(v) => setF({ ...f, email_milestones: v })} />
        <Check label="For new jobs, also email updates to the partner agents" checked={f.notify_agents_default} onChange={(v) => setF({ ...f, notify_agents_default: v })} />
      </div>
    </Card>
  );
}

function SimpleSettings({ k, data, onSaved, fields, extra }) {
  const [f, setF] = useState(data[k]);
  const [busy, run] = useAction();
  return (
    <Card actions={<Button busy={busy} onClick={() => run('x', async () => onSaved(await api.put(`/settings/${k}`, f)), 'Saved')}>Save</Button>}>
      <div className="stack">
        {extra?.(f, setF)}
        <FormGrid fields={fields} value={f} onChange={setF} />
      </div>
    </Card>
  );
}

function LogoField({ value, onChange }) {
  const toast = useToast();
  const pick = (file) => {
    if (!file) return;
    if (!/image\/(png|jpe?g)/.test(file.type)) return toast('Use a PNG or JPG image', 'error');
    if (file.size > 400 * 1024) return toast('Logo must be under 400 KB', 'error');
    const r = new FileReader();
    r.onload = () => onChange(r.result);
    r.readAsDataURL(file);
  };
  return (
    <Field label="Logo (printed on quotations)">
      <div className="row gap">
        {value ? <img src={value} alt="logo" style={{ maxHeight: 50, maxWidth: 160, border: '1px solid var(--line)', borderRadius: 6, padding: 4 }} /> : <span className="muted small">No logo</span>}
        <input type="file" accept="image/png,image/jpeg" onChange={(e) => pick(e.target.files[0])} />
        {value && <button type="button" className="link" onClick={() => onChange('')}>remove</button>}
      </div>
    </Field>
  );
}

function PricingSettings({ data, onSaved }) {
  const meta = useMeta();
  const [p, setP] = useState(() => ({ ...data.pricing, approval_levels: data.pricing.approval_levels ?? [{ below_pct: Number(data.pricing.floor_margin_pct || 0), role: 'manager' }] }));
  const [fx, setFx] = useState(data.fx);
  const roles = useLoad(() => api.get('/roles').catch(() => []));
  const [busy, run] = useAction();
  const save = () => run('x', async () => { await api.put('/settings/pricing', p); onSaved(await api.put('/settings/fx', fx)); }, 'Saved');
  return (
    <Card actions={<Button busy={busy} onClick={save}>Save</Button>}>
      <FormGrid value={p} onChange={setP} cols={5} fields={[
        { key: 'default_margin_pct', label: 'Default margin % (customers)', type: 'number' },
        { key: 'default_agent_margin_pct', label: 'Default margin % (partner agents)', type: 'number' },
        { key: 'default_tax_pct', label: 'GST % on INR quotes', type: 'number' },
        { key: 'quote_validity_days', label: 'Customer quote validity (days)', type: 'number' },
        { key: 'auto_followup', label: 'Follow-up', type: 'checkbox', checkLabel: 'Email the requester before a quote expires' },
        { key: 'followup_days_before_expiry', label: 'Days before expiry to follow up', type: 'number' },
        { key: 'rate_memory', label: 'Rate memory', type: 'checkbox', checkLabel: 'Save checked agent quotes as rate cards' },
        { key: 'rate_memory_days', label: 'Remembered rates valid for (days, if agent gave no validity)', type: 'number' },
        { key: 'terms', label: 'Default terms on quotations', type: 'textarea', span: 5, rows: 4 },
      ]} />
      <h4>Approval levels</h4>
      <ApprovalLevels value={p.approval_levels} roles={roles.data || []} onChange={(v) => setP({ ...p, approval_levels: v })} />
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


function Users({ admin, me }) {
  const list = useLoad(() => api.get('/users').catch(() => []));
  const roles = useLoad(() => api.get('/roles').catch(() => []));
  const [f, setF] = useState(null);
  const [edit, setEdit] = useState(null);
  const [off, setOff] = useState(null);
  const [busy, run] = useAction();
  const status = (u) => (u.disabled_at ? <Badge color="gray">switched off</Badge> : u.email_verified_at ? <Badge color="green">active</Badge> : <Badge color="amber">invited</Badge>);
  return (
    <Card title="Users" actions={admin && <Button onClick={() => setF({ roles: ['user'] })}>+ Add user</Button>}>
      <Table rows={list.data} rowClass={(u) => (u.disabled_at ? 'row-muted' : '')} columns={[
        { label: 'Name', render: (u) => <>{u.name}{u.id === me?.id && <span className="small muted"> (you)</span>}</> },
        { key: 'email', label: 'Email' },
        { label: 'Roles', render: (u) => <RolePills keys={u.roles?.length ? u.roles : [u.role]} roles={roles.data || []} /> },
        { label: 'Status', render: (u) => <>{status(u)}{u.disabled_at && <div className="small muted">by {u.disabled_by || 'an admin'}, {fmtDateTime(u.disabled_at)}</div>}</> },
        { label: '', render: (u) => admin && (
          <div className="row gap-sm end wrap">
            {!u.disabled_at && <Button small variant="ghost" onClick={() => setEdit({ id: u.id, name: u.name, email: u.email, roles: u.roles?.length ? u.roles : [u.role], invited: !u.email_verified_at, self: u.id === me?.id })}>Edit</Button>}
            {!u.disabled_at && !u.email_verified_at && <Button small variant="ghost" busy={busy === `i${u.id}`} onClick={() => run(`i${u.id}`, () => api.post(`/users/${u.id}/resend-invite`), 'Invite sent again')}>Resend invite</Button>}
            {!u.disabled_at && u.id !== me?.id && <Button small variant="ghost" onClick={() => setOff(u)}>Switch off</Button>}
            {u.disabled_at && <Button small variant="ghost" busy={busy === `on${u.id}`} onClick={() => run(`on${u.id}`, async () => list.setData(await api.post(`/users/${u.id}/enable`)), `${u.name} can sign in again`)}>Switch back on</Button>}
          </div>
        ) },
      ]} />
      <p className="small muted">Switched-off users can't sign in and don't count towards your plan's user limit. Their RFQs, quotations and history stay as they are.</p>
      {f && (
        <Modal title="Add user" onClose={() => setF(null)} footer={<Button busy={busy === 'add'} disabled={!f.roles?.length} onClick={() => run('add', async () => {
          const u = await api.post('/users', f);
          setF(null);
          list.reload();
          if (u.invite_error) throw new Error(`User added, but the invite email failed: ${u.invite_error}`);
        }, 'User added. They will get an email to set their password.')}>Add & send invite</Button>}>
          <FormGrid cols={2} value={f} onChange={setF} fields={[{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email', type: 'email' }]} />
          <Field label="Roles" hint="Give at least one. Someone with several roles gets everything any of them allows."><RolePicker roles={roles.data || []} value={f.roles || []} onChange={(v) => setF({ ...f, roles: v })} /></Field>
          <p className="muted small">They receive an email from Quayly with a link to choose their own password.</p>
        </Modal>
      )}
      {edit && (
        <Modal title={`Edit ${edit.name}`} onClose={() => setEdit(null)} footer={<Button busy={busy === 'ed'} disabled={!edit.roles?.length} onClick={() => run('ed', async () => {
          const { id, invited, self, ...body } = edit;
          if (!invited) delete body.email;
          if (self) delete body.roles;
          list.setData(await api.put(`/users/${id}`, body));
          setEdit(null);
        }, 'Saved')}>Save</Button>}>
          <FormGrid cols={2} value={edit} onChange={setEdit} fields={[
            { key: 'name', label: 'Name' },
            { key: 'email', label: 'Email', type: 'email', disabled: !edit.invited, hint: edit.invited ? 'Changing it sends the invite to the new address.' : 'Fixed once they have signed in. To move someone to a new email, add them again and switch off this user.' },
          ]} />
          <Field label="Roles" hint={edit.self ? "You can't change your own roles." : 'Takes effect on their next click.'}><RolePicker roles={roles.data || []} value={edit.roles || []} disabled={edit.self} onChange={(v) => setEdit({ ...edit, roles: v })} /></Field>
        </Modal>
      )}
      {off && (
        <Modal title={`Switch off ${off.name}?`} onClose={() => setOff(null)} footer={<Button busy={busy === 'off'} onClick={() => run('off', async () => { list.setData(await api.post(`/users/${off.id}/disable`)); setOff(null); }, `${off.name} is switched off`)}>Switch off</Button>}>
          <p>{off.name} ({off.email}) is signed out straight away and can't sign in or reset their password. Their work stays, and you can switch them back on later.</p>
        </Modal>
      )}
    </Card>
  );
}
