import { useState } from 'react';
import { api } from '../api.js';
import { useMeta } from '../components/meta.jsx';
import { PageHeader, Card, Table, Button, Modal, FormGrid, Field, Select, Badge, Loading, ErrorBox, useLoad, useAction, fmtDate, money } from '../components/ui.jsx';
import { ChargeLinesTable } from '../components/rfq.jsx';

const PLACE_HINT = {
  pickup: ['Pickup area(s)', 'Port / ICD delivered to'],
  delivery: ['Port of arrival', 'Delivery area(s)'],
  freight: ['Port / airport of loading', 'Port / airport of discharge'],
};
const single = (leg) => ['export_customs', 'origin_charges', 'destination_charges', 'import_customs'].includes(leg);

function status(c) {
  const today = new Date().toISOString().slice(0, 10);
  const to = c.valid_to?.slice?.(0, 10);
  if (!c.active) return <Badge>inactive</Badge>;
  if (to && to < today) return <Badge color="red">expired</Badge>;
  if (to && new Date(to) - new Date(today) <= 7 * 864e5) return <Badge color="amber">expiring</Badge>;
  if (c.valid_from && c.valid_from.slice(0, 10) > today) return <Badge color="blue">future</Badge>;
  return <Badge color="green">active</Badge>;
}

export default function RateCards() {
  const meta = useMeta();
  const [filters, setFilters] = useState({ leg: '', vendor: '', status: '', source: '' });
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const list = useLoad(() => api.get(`/rate-cards${qs ? `?${qs}` : ''}`), [qs]);
  const vendors = useLoad(() => api.get('/agents?role=agent'));
  const [edit, setEdit] = useState(null);
  const [importing, setImporting] = useState(false);
  const [aiRead, setAiRead] = useState(false);
  const [busy, run] = useAction();
  const open = (c) => run(`o${c.id}`, async () => setEdit(await api.get(`/rate-cards/${c.id}`)));
  return (
    <>
      <PageHeader
        title="Rate cards"
        sub="Your stored buy rates: your own tariffs or a vendor's (line, transporter, customs agent). Matching cards price new RFQs instantly, without emailing anyone."
        actions={<>
          <Button variant="ghost" onClick={() => setAiRead(true)}>Read a rate sheet with AI</Button>
          <Button variant="ghost" onClick={() => setImporting(true)}>Import from Excel template</Button>
          <Button onClick={() => setEdit({ active: true, leg: 'freight', mode: 'FCL', lines: [] })}>+ New rate card</Button>
        </>}
      />
      <RateMailPanel onApplied={() => list.reload()} />
      <Card actions={null}>
        <div className="row gap wrap filters" style={{ marginBottom: 12 }}>
          <Select placeholder="All legs" options={meta.legOptions} value={filters.leg} onChange={(e) => setFilters({ ...filters, leg: e.target.value })} />
          <Select placeholder="All vendors" options={[{ value: 'own', label: 'Our own rates' }, ...(vendors.data || []).map((v) => ({ value: v.id, label: v.company }))]} value={filters.vendor} onChange={(e) => setFilters({ ...filters, vendor: e.target.value })} />
          <Select placeholder="Any source" options={[{ value: 'manual', label: 'Entered / imported' }, { value: 'memory', label: 'Remembered from agent quotes' }, { value: 'ai_import', label: 'Read by AI' }, { value: 'email', label: 'Updated from email' }]} value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value })} />
          <Select placeholder="Any status" options={[{ value: 'active', label: 'Active' }, { value: 'expiring', label: 'Expiring in 7 days' }, { value: 'expired', label: 'Expired' }]} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} />
        </div>
        {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : (
          <Table
            rows={list.data}
            onRowClick={open}
            empty="No rate cards yet. Add one or import your Excel rate sheet."
            columns={[
              { key: 'name', label: 'Rate card', render: (c) => <><b>{c.name}</b> {c.source === 'memory' && <Badge color="purple">remembered</Badge>}{c.source === 'ai_import' && <Badge color="blue">AI import</Badge>}{c.source === 'email' && <Badge color="blue">from email</Badge>}</> },
              { label: 'Vendor', render: (c) => c.vendor_name || <span className="muted">Own rates</span> },
              { label: 'Leg', render: (c) => meta.legName(c.leg) },
              { key: 'mode', label: 'Mode', render: (c) => c.mode || 'Any' },
              { label: 'Lane', render: (c) => <span className="small">{c.origin || 'Any'}{single(c.leg) ? '' : ` → ${c.destination || 'Any'}`}</span> },
              { key: 'carrier', label: 'Carrier' },
              { label: 'Valid', render: (c) => <span className="small">{fmtDate(c.valid_from)} – {fmtDate(c.valid_to)}</span> },
              { key: 'line_count', label: 'Charges', align: 'center' },
              { label: 'Status', render: status },
            ]}
          />
        )}
      </Card>
      {edit && <CardModal card={edit} vendors={vendors.data || []} onClose={() => setEdit(null)} onDone={() => { setEdit(null); list.reload(); }} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => list.reload()} />}
      {aiRead && <AiReadModal vendors={vendors.data || []} onClose={() => setAiRead(false)} onDone={() => { setAiRead(false); list.reload(); }} />}
    </>
  );
}

function CardModal({ card, vendors, onClose, onDone }) {
  const meta = useMeta();
  const [c, setC] = useState({ ...card, valid_from: card.valid_from?.slice?.(0, 10) || '', valid_to: card.valid_to?.slice?.(0, 10) || '' });
  const [busy, run] = useAction();
  const [from, to] = single(c.leg) ? ['Port / location', null] : PLACE_HINT[c.leg] || ['From', 'To'];
  const save = () => run('save', async () => {
    const body = { ...c, vendor_id: c.vendor_id || null, mode: c.mode === 'ANY' ? null : c.mode };
    if (c.id) await api.put(`/rate-cards/${c.id}`, body);
    else await api.post('/rate-cards', body);
    onDone();
  }, 'Rate card saved');
  return (
    <Modal wide title={c.id ? `Rate card: ${card.name}` : 'New rate card'} onClose={onClose} footer={<>
      {c.id && <Button variant="ghost" busy={busy === 'del'} onClick={() => run('del', async () => { if (!confirm('Delete this rate card?')) return; await api.del(`/rate-cards/${c.id}`); onDone(); }, 'Deleted')}>Delete</Button>}
      {c.id && <Button variant="ghost" busy={busy === 'copy'} onClick={() => run('copy', async () => { await api.post(`/rate-cards/${c.id}/copy`); onDone(); }, 'Copied. Edit the copy for the new validity.')}>Copy</Button>}
      <Button busy={busy === 'save'} onClick={save}>Save</Button>
    </>}>
      <FormGrid cols={4} value={{ ...c, mode: c.mode || 'ANY', vendor_id: c.vendor_id || '' }} onChange={setC} fields={[
        { key: 'name', label: 'Name', span: 2, placeholder: 'e.g. ONE Chennai–Hong Kong December' },
        { key: 'vendor_id', label: 'Whose rates', type: 'select', placeholder: 'Our own rates', options: vendors.map((v) => ({ value: v.id, label: v.company })) },
        { key: 'leg', label: 'Leg', type: 'select', placeholder: undefined, options: meta.legOptions },
        { key: 'mode', label: 'Mode', type: 'select', placeholder: undefined, options: [...meta.modes.map((m) => ({ value: m.code, label: m.name })), { value: 'ANY', label: 'Any mode' }] },
        { key: 'origin', label: from, hint: 'Names or codes, comma separated (e.g. "Chennai, INMAA"). Blank = any.' },
        ...(to ? [{ key: 'destination', label: to, hint: 'Blank = any' }] : []),
        { key: 'carrier', label: 'Carrier / line' },
        { key: 'valid_from', label: 'Valid from', type: 'date' },
        { key: 'valid_to', label: 'Valid to', type: 'date' },
        { key: 'transit_days', label: 'Transit days', type: 'number' },
        { key: 'free_days', label: 'Free days', type: 'number' },
        { key: 'active', label: 'Status', type: 'checkbox', checkLabel: 'Active' },
        { key: 'notes', label: 'Notes', span: 4 },
      ]} />
      <Field label="Charges">
        <ChargeLinesTable
          lines={c.lines || []}
          onChange={(lines) => setC({ ...c, lines })}
          opts={{ equipment: c.mode === 'FCL' || !c.mode || c.mode === 'ANY', breaks: c.mode !== 'FCL' }}
          newLine={() => ({ charge_code: c.leg === 'freight' ? (c.mode === 'AIR' ? 'AFR' : 'OFR') : 'OTHER', basis: c.mode === 'AIR' ? 'per_kg' : 'per_container', currency: 'USD', rate: '' })}
        />
      </Field>
      <p className="muted small">Lines with a container type only apply when the RFQ has that container. Weight breaks use chargeable kg (per kg) or cbm (per cbm); the minimum replaces the amount when it is lower.</p>
    </Modal>
  );
}

function ImportModal({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, run] = useAction();
  const go = () => run('x', async () => {
    const fd = new FormData();
    fd.append('file', file);
    const r = await api.form('/rate-cards/import', fd);
    setResult(r);
    onDone();
  });
  return (
    <Modal title="Import rate cards from Excel" onClose={onClose} footer={<Button busy={busy} disabled={!file} onClick={go}>Import</Button>}>
      <p>1. <a href="/api/rate-cards-template">Download the template</a>. It has examples and a Help sheet with all codes.</p>
      <p>2. Fill one row per charge. Rows with the same card name form one rate card. Re-importing a card with the same name replaces it.</p>
      <Field label="3. Choose your file (.xlsx or .csv)"><input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files[0])} /></Field>
      {result && (
        <div className={`alert ${result.errors.length ? 'alert-amber' : 'alert-blue'}`}>
          {result.created} new card(s), {result.replaced} updated, {result.lines} charge line(s).
          {result.errors.length > 0 && <ul className="small">{result.errors.slice(0, 15).map((e, i) => <li key={i}>{e}</li>)}</ul>}
        </div>
      )}
    </Modal>
  );
}

function AiReadModal({ vendors, onClose, onDone }) {
  const meta = useMeta();
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [vendor, setVendor] = useState('');
  const [result, setResult] = useState(null);
  const [keep, setKeep] = useState({});
  const [busy, run] = useAction();
  const read = () => run('read', async () => {
    const fd = new FormData();
    if (file) fd.append('file', file);
    if (text) fd.append('text', text);
    const v = vendors.find((x) => String(x.id) === String(vendor));
    if (v) fd.append('hint', `rates from ${v.company}`);
    const r = await api.form('/rate-cards/ai-read', fd);
    setResult(r);
    setKeep(Object.fromEntries(r.cards.map((_, i) => [i, true])));
  });
  const save = () => run('save', async () => {
    const cards = result.cards.filter((_, i) => keep[i]);
    await api.post('/rate-cards/bulk', { cards, vendor_id: vendor || null });
    onDone();
  }, 'Rate cards saved');
  return (
    <Modal wide title="Read a rate sheet with AI" onClose={onClose} footer={result ? <Button busy={busy === 'save'} disabled={!Object.values(keep).some(Boolean)} onClick={save}>Save {Object.values(keep).filter(Boolean).length} rate card(s)</Button> : <Button busy={busy === 'read'} disabled={!file && !text.trim()} onClick={read}>Read</Button>}>
      {!result ? (
        <div className="stack">
          <p className="muted">Upload a carrier's or agent's rate sheet in any layout (PDF, Excel, photo) or paste the email text. The AI turns it into rate cards for you to check before saving.</p>
          <Field label="Whose rates are these?"><Select placeholder="Our own rates" options={vendors.map((v) => ({ value: v.id, label: v.company }))} value={vendor} onChange={(e) => setVendor(e.target.value)} /></Field>
          <Field label="Rate sheet file"><input type="file" accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files[0])} /></Field>
          <Field label="…or paste the rates"><textarea className="input" rows={6} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        </div>
      ) : (
        <div className="stack">
          {result.notes && <div className="alert alert-amber small">{result.notes}</div>}
          {!result.cards.length && <div className="empty">No rates found in this file.</div>}
          {result.cards.map((c, i) => (
            <RateCardPreview key={i} card={c} checked={!!keep[i]} onCheck={(v) => setKeep({ ...keep, [i]: v })} />
          ))}
          <p className="muted small">You can edit any card after saving.</p>
        </div>
      )}
    </Modal>
  );
}

const lineKey = (l) => `${l.charge_code}|${l.equipment || ''}|${l.qty_from ?? ''}`;

/** One AI-read rate card: lane, validity and charges; with `current`, shows the stored rate beside the new one. */
export function RateCardPreview({ card: c, checked, onCheck, current }) {
  const meta = useMeta();
  const old = Object.fromEntries((current?.lines || []).map((l) => [lineKey(l), l]));
  return (
    <div className="quote-card">
      <label className="check"><input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} /> <b>{c.name}</b>{' '}
        {current ? <Badge color="amber">{`updates ${current.name}`}</Badge>
          : c.follows_name ? <Badge color="blue">{`new card from ${c.valid_from}; ${c.follows_name} stays in use until then`}</Badge>
          : c.match_id === null ? <Badge color="blue">new card</Badge> : null}
      </label>
      <div className="small muted">{meta.legName(c.leg)} · {c.mode || 'Any mode'} · {c.origin || 'Any'}{c.destination ? ` → ${c.destination}` : ''}{c.carrier ? ` · ${c.carrier}` : ''} · valid {c.valid_from || '?'} – {c.valid_to || '?'}
        {current && <> (now {fmtDate(current.valid_from)} – {fmtDate(current.valid_to)})</>}</div>
      <table className="table compact">
        <thead><tr><th>Charge</th><th>Basis</th><th>Container / break</th>{current && <th style={{ textAlign: 'right' }}>Now</th>}<th style={{ textAlign: 'right' }}>{current ? 'New' : 'Rate'}</th></tr></thead>
        <tbody>{c.lines.map((l, j) => {
          const was = old[lineKey(l)];
          const changed = current && (!was || Number(was.rate) !== Number(l.rate) || was.currency !== l.currency);
          return (
            <tr key={j}><td>{l.description || meta.chargeName(l.charge_code)} <span className="muted small">{l.charge_code}</span></td><td>{meta.basisName(l.basis)}</td>
              <td className="small">{l.equipment || ''}{l.qty_from !== null || l.qty_to !== null ? ` ${l.qty_from ?? 0}–${l.qty_to ?? '∞'}` : ''}{l.min_amount ? ` min ${l.min_amount}` : ''}</td>
              {current && <td style={{ textAlign: 'right' }} className="muted">{was ? money(was.rate, was.currency) : '—'}</td>}
              <td style={{ textAlign: 'right' }}>{changed ? <b>{money(l.rate, l.currency)}</b> : money(l.rate, l.currency)}</td></tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

/** Rate sheets that arrived by email and were read by the AI, waiting to be applied. */
function RateMailPanel({ onApplied }) {
  const list = useLoad(() => api.get('/rate-mail'), [], { refresh: 60000 });
  const [open, setOpen] = useState(null);
  if (!list.data?.length) return null;
  return (
    <Card title={`Rates received by email (${list.data.length})`} actions={<span className="muted small">Read by AI from agents' rate sheets. Check and apply to update your rate cards.</span>}>
      <Table rows={list.data} onRowClick={(e) => setOpen(e.id)} columns={[
        { label: 'From', render: (e) => <>{e.rate_proposal?.agent_name ? <b>{e.rate_proposal.agent_name}</b> : <span>{e.from_addr}</span>}{!e.rate_proposal?.agent_id && <div className="small muted">sender not in your partner agents</div>}</> },
        { key: 'subject', label: 'Subject' },
        { label: 'Cards', render: (e) => { const cs = e.rate_proposal?.cards || []; const up = cs.filter((c) => c.match_id).length; return <span className="small">{up ? `${up} update${up > 1 ? 's' : ''}` : ''}{up && cs.length - up ? ', ' : ''}{cs.length - up ? `${cs.length - up} new` : ''}</span>; } },
        { label: 'Received', render: (e) => fmtDate(e.at) },
        { label: '', render: () => <Button small variant="ghost">Review</Button> },
      ]} />
      {open && <RateMailModal id={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); list.reload(); onApplied(); }} />}
    </Card>
  );
}

function RateMailModal({ id, onClose, onDone }) {
  const d = useLoad(() => api.get(`/rate-mail/${id}`), [id]);
  const vendors = useLoad(() => api.get('/agents?role=agent'));
  const [keep, setKeep] = useState(null);
  const [agent, setAgent] = useState(undefined);
  const [busy, run] = useAction();
  if (!d.data) return <Modal title="Rates received by email" onClose={onClose}>{d.error ? <ErrorBox error={d.error} /> : <Loading />}</Modal>;
  const p = d.data.rate_proposal;
  const ticks = keep || Object.fromEntries(p.cards.map((_, i) => [i, true]));
  const agentId = agent === undefined ? p.agent_id || '' : agent;
  // a card only updates a stored card of the same agent
  const sameAgent = String(agentId || '') === String(p.agent_id || '');
  const n = Object.values(ticks).filter(Boolean).length;
  const apply = () => run('apply', async () => {
    const cards = p.cards.map((c, i) => ({ ...c, include: !!ticks[i], match_id: sameAgent ? c.match_id : null }));
    await api.post(`/rate-mail/${id}/apply`, { cards, agent_id: agentId ? Number(agentId) : null });
    onDone();
  }, 'Rate cards updated');
  const dismiss = () => run('dis', async () => { await api.post(`/rate-mail/${id}/dismiss`); onDone(); }, 'Dismissed');
  return (
    <Modal wide title={d.data.subject || 'Rates received by email'} onClose={onClose} footer={<>
      <Button variant="ghost" busy={busy === 'dis'} onClick={dismiss}>Dismiss</Button>
      <Button busy={busy === 'apply'} disabled={!n} onClick={apply}>Apply {n} card{n === 1 ? '' : 's'}</Button>
    </>}>
      <div className="stack">
        <div className="small muted">From {d.data.from_addr} · received {fmtDate(d.data.at)}</div>
        <Field label="Whose rates are these?" hint={p.agent_id ? 'Recognised from the sender’s email address.' : 'The sender is not one of your partner agents. Pick the agent, or keep them as your own rates.'}>
          <Select placeholder="Our own rates" options={(vendors.data || []).map((v) => ({ value: v.id, label: v.company }))} value={agentId} onChange={(e) => setAgent(e.target.value)} />
        </Field>
        {p.notes && <div className="alert alert-amber small">{p.notes}</div>}
        {p.cards.map((c, i) => (
          <RateCardPreview key={i} card={sameAgent ? c : { ...c, match_id: null, follows_name: null }} current={sameAgent ? c.current : null} checked={!!ticks[i]} onCheck={(v) => setKeep({ ...ticks, [i]: v })} />
        ))}
        <p className="muted small">Applying replaces the rates and validity of the cards marked “updates” and adds the new ones. Every change is in the activity log.</p>
      </div>
    </Modal>
  );
}
