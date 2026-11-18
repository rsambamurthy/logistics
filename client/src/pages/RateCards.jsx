import { useState } from 'react';
import { api } from '../api.js';
import { useMeta } from '../components/meta.jsx';
import { PageHeader, Card, Table, Button, Modal, FormGrid, Field, Select, Badge, Loading, ErrorBox, useLoad, useAction, fmtDate } from '../components/ui.jsx';
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
  const [filters, setFilters] = useState({ leg: '', vendor: '', status: '' });
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const list = useLoad(() => api.get(`/rate-cards${qs ? `?${qs}` : ''}`), [qs]);
  const vendors = useLoad(() => api.get('/agents?role=agent'));
  const [edit, setEdit] = useState(null);
  const [importing, setImporting] = useState(false);
  const [busy, run] = useAction();
  const open = (c) => run(`o${c.id}`, async () => setEdit(await api.get(`/rate-cards/${c.id}`)));
  return (
    <>
      <PageHeader
        title="Rate cards"
        sub="Your stored buy rates: your own tariffs or a vendor's (line, transporter, customs agent). Matching cards price new RFQs instantly, without emailing anyone."
        actions={<>
          <Button variant="ghost" onClick={() => setImporting(true)}>Import from Excel</Button>
          <Button onClick={() => setEdit({ active: true, leg: 'freight', mode: 'FCL', lines: [] })}>+ New rate card</Button>
        </>}
      />
      <Card actions={null}>
        <div className="row gap wrap" style={{ marginBottom: 12 }}>
          <Select placeholder="All legs" options={meta.legOptions} value={filters.leg} onChange={(e) => setFilters({ ...filters, leg: e.target.value })} />
          <Select placeholder="All vendors" options={[{ value: 'own', label: 'Our own rates' }, ...(vendors.data || []).map((v) => ({ value: v.id, label: v.company }))]} value={filters.vendor} onChange={(e) => setFilters({ ...filters, vendor: e.target.value })} />
          <Select placeholder="Any status" options={[{ value: 'active', label: 'Active' }, { value: 'expiring', label: 'Expiring in 7 days' }, { value: 'expired', label: 'Expired' }]} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} />
        </div>
        {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : (
          <Table
            rows={list.data}
            onRowClick={open}
            empty="No rate cards yet. Add one or import your Excel rate sheet."
            columns={[
              { key: 'name', label: 'Rate card', render: (c) => <b>{c.name}</b> },
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
