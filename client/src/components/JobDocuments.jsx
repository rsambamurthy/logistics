// Documents tab of a job: checklist, files, shipping instructions, draft / final BL-AWB.
import { useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Badge, Table, Modal, Field, Input, Textarea, Select, Check, Loading, useAction, useLoad, fmtDateTime } from './ui.jsx';
import { PartyFields } from './jobs.jsx';

const CHECK_STATUS = {
  missing: ['Missing', 'red'],
  received: ['Received', 'green'],
  draft: ['In progress', 'amber'],
  sent: ['Sent', 'green'],
  final: ['Final', 'green'],
  waived: ['Not needed', 'gray'],
};
const BL_STATUS = {
  received: ['Received — to check', 'amber'],
  with_customer: ['With customer', 'blue'],
  customer_approved: ['Customer approved', 'green'],
  customer_corrections: ['Customer wants changes', 'red'],
  approved: ['Approved with agent', 'green'],
  corrections_sent: ['Corrections sent to agent', 'amber'],
  superseded: ['Replaced by newer draft', 'gray'],
  final: ['Final', 'green'],
};
const FROM = { customer: 'Customer', agent: 'Agent', us: 'Us', customs: 'Customs filing' };
const SI_STATUS = { new: ['Not started', 'gray'], draft: ['Draft', 'amber'], sent: ['Sent to agent', 'green'], amended: ['Changed since sent', 'red'] };

const B = ({ map, s }) => {
  const [l, c] = map[s] || [s, 'gray'];
  return <Badge color={c}>{l}</Badge>;
};

function SiForm({ value, onChange, air }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const f = (k, label, type) => <Field label={label}><Input type={type} value={value[k]} onChange={(e) => set(k, type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)} /></Field>;
  const conts = value.containers || [];
  const setC = (i, k, v) => set('containers', conts.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  return (
    <div className="stack">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <PartyFields label="Shipper" value={value.shipper} onChange={(v) => set('shipper', v)} />
        <PartyFields label="Consignee" value={value.consignee} onChange={(v) => set('consignee', v)} />
        <PartyFields label="Notify party" value={value.notify_party} onChange={(v) => set('notify_party', v)} />
      </div>
      <div className="grid g4">
        {f('place_of_receipt', 'Place of receipt')}
        {f('pol', air ? 'Airport of departure' : 'Port of loading')}
        {f('pod', air ? 'Airport of destination' : 'Port of discharge')}
        {f('place_of_delivery', 'Place of delivery')}
        {f('booking_no', 'Booking no.')}
        {air ? f('flight_no', 'Flight') : <>{f('vessel', 'Vessel')}{f('voyage', 'Voyage')}</>}
        <Field label="Freight"><Select value={value.freight_terms || ''} placeholder="—" onChange={(e) => set('freight_terms', e.target.value)} options={[{ value: 'prepaid', label: 'Prepaid' }, { value: 'collect', label: 'Collect' }]} /></Field>
        {!air && <Field label="BL type"><Select value={value.bl_type || ''} placeholder="—" onChange={(e) => set('bl_type', e.target.value)} options={[{ value: 'original', label: 'Original' }, { value: 'seaway', label: 'Seaway bill' }, { value: 'telex', label: 'Telex release' }, { value: 'express', label: 'Express' }]} /></Field>}
        {!air && f('originals', 'Originals', 'number')}
        {f('hs_code', 'HS code')}
        {f('invoice_no', 'Invoice no.')}
      </div>
      <div className="grid g2">
        <Field label="Marks and numbers"><Textarea rows={3} value={value.marks} onChange={(e) => set('marks', e.target.value)} /></Field>
        <Field label="Description of goods"><Textarea rows={3} value={value.description} onChange={(e) => set('description', e.target.value)} /></Field>
      </div>
      <div className="grid g5">
        {f('packages', 'Packages', 'number')}
        {f('package_type', 'Package type')}
        {f('gross_weight_kg', 'Gross weight (kg)', 'number')}
        {f('net_weight_kg', 'Net weight (kg)', 'number')}
        {f('volume_cbm', 'Volume (cbm)', 'number')}
      </div>
      {!air && (
        <Field label="Containers">
          <div className="stack-sm">
            {conts.map((c, i) => (
              <div key={i} className="grid g6">
                <Input placeholder="Container no." value={c.number} onChange={(e) => setC(i, 'number', e.target.value)} />
                <Input placeholder="Seal" value={c.seal} onChange={(e) => setC(i, 'seal', e.target.value)} />
                <Input placeholder="Type" value={c.type} onChange={(e) => setC(i, 'type', e.target.value)} />
                <Input placeholder="Packages" type="number" value={c.packages} onChange={(e) => setC(i, 'packages', e.target.value)} />
                <Input placeholder="Gross kg" type="number" value={c.gross_weight_kg} onChange={(e) => setC(i, 'gross_weight_kg', e.target.value)} />
                <Button small variant="ghost" onClick={() => set('containers', conts.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
            <div><Button small variant="ghost" onClick={() => set('containers', [...conts, {}])}>+ Container</Button></div>
          </div>
        </Field>
      )}
      <Field label="Remarks"><Textarea rows={2} value={value.remarks} onChange={(e) => set('remarks', e.target.value)} /></Field>
    </div>
  );
}

function ShippingInstructions({ d, set }) {
  const { job, rfq } = d;
  const air = rfq?.mode === 'AIR';
  const si = useLoad(() => api.get(`/jobs/${job.id}/si`), [job.id, d.docs.si?.updated_at, d.docs.si?.status]);
  const [busy, run] = useAction();
  const [edit, setEdit] = useState(null);
  const [send, setSend] = useState(null);
  const agentBookings = d.bookings.filter((b) => b.source !== 'own' && b.status !== 'cancelled');
  const title = air ? "Shipper's letter of instruction" : 'Shipping instructions';
  const s = si.data;
  const save = async (v) => { await api.put(`/jobs/${job.id}/si`, { data: v.data, booking_id: v.booking_id }); await si.reload(); };
  return (
    <Card title={title} actions={s && (
      <div className="row gap-sm wrap">
        <Button small variant="ghost" busy={busy === 'ai'} onClick={() => run('ai', async () => { await api.post(`/jobs/${job.id}/si/prefill`); set(await api.get(`/jobs/${job.id}`)); await si.reload(); }, 'Filled from the documents. Please check.')}>Fill from invoice & packing list (AI)</Button>
        <Button small variant="ghost" onClick={() => setEdit({ data: s.data || {}, booking_id: s.booking_id })}>Edit</Button>
        {s.status !== 'new' && <a className="btn btn-ghost btn-sm" href={`/api/jobs/${job.id}/si/pdf`} target="_blank" rel="noreferrer">PDF</a>}
        <Button small onClick={() => setSend({ booking_id: s.booking_id || agentBookings.find((b) => b.legs.includes('freight'))?.id || agentBookings[0]?.id || '', note: '', fileIds: [] })} disabled={!agentBookings.length}>{s.sent_count ? 'Send amended SI' : 'Send to agent'}</Button>
      </div>
    )}>
      {si.loading && !s ? <Loading /> : s && (
        <>
          <dl className="kv">
            <div><dt>Status</dt><dd><B map={SI_STATUS} s={s.status} />{s.source === 'ai' && <> <Badge color="amber">filled by AI</Badge></>}</dd></div>
            <div><dt>Sent</dt><dd>{s.sent_at ? `${fmtDateTime(s.sent_at)}${s.sent_count > 1 ? ` (${s.sent_count}×)` : ''}` : 'Not yet'}</dd></div>
            <div><dt>Shipper</dt><dd>{s.data?.shipper?.name || '—'}</dd></div>
            <div><dt>Consignee</dt><dd>{s.data?.consignee?.name || '—'}</dd></div>
            <div><dt>Goods</dt><dd>{s.data?.description || '—'}</dd></div>
            <div><dt>Packages / weight</dt><dd>{[s.data?.packages && `${s.data.packages} ${s.data.package_type || ''}`, s.data?.gross_weight_kg && `${s.data.gross_weight_kg} kg`].filter(Boolean).join(' · ') || '—'}</dd></div>
          </dl>
          {!agentBookings.length && <p className="small muted">All legs use your own rates, so there is no agent to send the SI to. Use the PDF.</p>}
        </>
      )}
      {edit && (
        <Modal wide title={title} onClose={() => setEdit(null)} footer={<Button busy={busy === 'save'} onClick={() => run('save', async () => { await save(edit); set(await api.get(`/jobs/${job.id}`)); setEdit(null); }, 'Saved')}>Save</Button>}>
          <SiForm value={edit.data} onChange={(v) => setEdit({ ...edit, data: v })} air={air} />
        </Modal>
      )}
      {send && (
        <Modal title={`Send ${air ? 'SLI' : 'SI'} to agent`} onClose={() => setSend(null)} footer={<Button busy={busy === 'send'} disabled={!send.booking_id} onClick={() => run('send', async () => { set(await api.post(`/jobs/${job.id}/si/send`, send)); setSend(null); await si.reload(); }, 'Sent to agent')}>Send with PDF</Button>}>
          <Field label="Agent"><Select value={send.booking_id} onChange={(e) => setSend({ ...send, booking_id: Number(e.target.value) })} options={agentBookings.map((b) => ({ value: b.id, label: `${b.agent} — ${b.legs.join(', ')}` }))} /></Field>
          <Field label="Also attach">
            {d.files.length ? d.files.filter((f) => !['draft_bl', 'bl'].includes(f.kind)).map((f) => <Check key={f.id} label={f.filename} checked={send.fileIds.includes(f.id)} onChange={(v) => setSend({ ...send, fileIds: v ? [...send.fileIds, f.id] : send.fileIds.filter((x) => x !== f.id) })} />) : <span className="small muted">No documents uploaded.</span>}
          </Field>
          <Field label="Note (optional)"><Textarea rows={3} value={send.note} onChange={(e) => setSend({ ...send, note: e.target.value })} /></Field>
          <p className="small muted">Sent in the agent's booking thread and asks for the draft {air ? 'AWB' : 'BL'}. Their draft is read by AI and checked against these instructions.</p>
        </Modal>
      )}
    </Card>
  );
}

function BillsOfLading({ d, set }) {
  const { job, rfq } = d;
  const label = rfq?.mode === 'AIR' ? 'AWB' : 'BL';
  const [busy, run] = useAction();
  const [upload, setUpload] = useState(null);
  const [toCustomer, setToCustomer] = useState(null);
  const [answer, setAnswer] = useState(null);
  const [agentReply, setAgentReply] = useState(null);
  const agentBookings = d.bookings.filter((b) => b.source !== 'own');
  const bls = d.docs.bls;
  const fileOf = (b) => d.files.find((f) => f.id === b.file_id);
  return (
    <Card title={`Draft and final ${label}`} actions={<Button small variant="ghost" onClick={() => setUpload({ is_final: false, booking_id: agentBookings[0]?.id || '', file: null })}>Upload {label}</Button>}>
      {!bls.length && <div className="empty">No draft yet. When the agent emails the draft {label}, it is read by AI and checked against the shipping instructions here.</div>}
      {bls.map((b) => (
        <div key={b.id} className="booking" style={b.status === 'superseded' ? { opacity: 0.6 } : {}}>
          <div className="booking-head">
            <div>
              <b>{b.is_final ? `Final ${label}` : `Draft ${label} v${b.version}`}</b> <B map={BL_STATUS} s={b.status} />
              <div className="small muted">{b.agent || 'Uploaded'} · {fmtDateTime(b.created_at)}{b.extracted?.bl_no ? ` · ${label} no. ${b.extracted.bl_no}` : ''}{b.confidence ? ` · AI confidence ${Math.round(b.confidence * 100)}%` : ''}</div>
              {b.extracted?.error && <div className="small err">AI could not read it: {b.extracted.error}</div>}
            </div>
            <div className="row gap-sm wrap">
              {fileOf(b) && <a className="btn btn-ghost btn-sm" href={`/api/job-files/${b.file_id}`} target="_blank" rel="noreferrer">Open</a>}
              <Button small variant="ghost" busy={busy === `rd${b.id}`} onClick={() => run(`rd${b.id}`, async () => set(await api.post(`/bl/${b.id}/read`)), 'Read again')}>Read again</Button>
              {b.status !== 'superseded' && <Button small variant={b.is_final || ['received'].includes(b.status) ? 'primary' : 'ghost'} onClick={() => setToCustomer({ bl: b, to: job.customer_email || '', note: '' })}>{b.is_final ? 'Send copy to customer' : b.sent_to_customer_at ? 'Send to customer again' : 'Send to customer for approval'}</Button>}
              {!b.is_final && ['with_customer', 'received'].includes(b.status) && <Button small variant="ghost" onClick={() => setAnswer({ bl: b, approved: true, corrections: '' })}>Customer answered</Button>}
              {!b.is_final && b.status !== 'superseded' && b.booking_id && <Button small variant={['customer_approved', 'customer_corrections'].includes(b.status) ? 'primary' : 'ghost'} onClick={() => setAgentReply({ bl: b, approve: b.status === 'customer_approved' || (!b.suggested_corrections), corrections: b.suggested_corrections || '', note: '' })}>Reply to agent</Button>}
            </div>
          </div>
          {b.status !== 'superseded' && !b.is_final && (b.discrepancies?.length ? (
            <div className="alert alert-amber">
              <b>{b.discrepancies.length} difference(s) from the shipping instructions</b>
              <Table rows={b.discrepancies.map((x, i) => ({ ...x, id: i }))} columns={[
                { key: 'label', label: 'Field' },
                { label: 'Our SI', render: (x) => x.si ?? '—' },
                { label: `Draft ${label}`, render: (x) => x.bl ?? <i>missing</i> },
              ]} />
            </div>
          ) : b.extracted && Object.keys(b.extracted).length && !b.extracted.error ? <div className="alert alert-blue">{d.docs.si ? 'Matches the shipping instructions.' : 'No shipping instructions to compare with yet.'}</div> : null)}
          {b.customer_note && <div className="small"><b>Customer's corrections:</b> {b.customer_note}</div>}
        </div>
      ))}

      {upload && (
        <Modal title={`Upload ${label}`} onClose={() => setUpload(null)} footer={<Button busy={busy === 'up'} disabled={!upload.file} onClick={() => run('up', async () => {
          const fd = new FormData();
          fd.append('file', upload.file);
          fd.append('is_final', upload.is_final);
          if (upload.booking_id) fd.append('booking_id', upload.booking_id);
          set(await api.form(`/jobs/${job.id}/bl`, fd));
          setUpload(null);
        }, 'Uploaded')}>Upload</Button>}>
          <Field label="File"><input type="file" onChange={(e) => setUpload({ ...upload, file: e.target.files[0] })} /></Field>
          <Field label="Which"><Select value={String(upload.is_final)} onChange={(e) => setUpload({ ...upload, is_final: e.target.value === 'true' })} options={[{ value: 'false', label: `Draft ${label}` }, { value: 'true', label: `Final ${label}` }]} /></Field>
          {agentBookings.length > 0 && <Field label="From agent"><Select value={upload.booking_id} placeholder="—" onChange={(e) => setUpload({ ...upload, booking_id: e.target.value })} options={agentBookings.map((b) => ({ value: b.id, label: b.agent }))} /></Field>}
        </Modal>
      )}
      {toCustomer && (
        <Modal title={toCustomer.bl.is_final ? `${label} copy to customer` : `Draft ${label} to customer for approval`} onClose={() => setToCustomer(null)} footer={<Button busy={busy === 'tc'} onClick={() => run('tc', async () => { set(await api.post(`/bl/${toCustomer.bl.id}/send-customer`, toCustomer)); setToCustomer(null); }, 'Sent to customer')}>Send</Button>}>
          {!toCustomer.bl.is_final && toCustomer.bl.discrepancies?.length > 0 && <div className="alert alert-amber">This draft differs from the SI in {toCustomer.bl.discrepancies.length} place(s). You may want to ask the agent to correct it first.</div>}
          <Field label="To"><Input value={toCustomer.to} onChange={(e) => setToCustomer({ ...toCustomer, to: e.target.value })} /></Field>
          <Field label="Note (optional)"><Textarea rows={3} value={toCustomer.note} onChange={(e) => setToCustomer({ ...toCustomer, note: e.target.value })} /></Field>
          <p className="small muted">Sent in the customer's thread with the file attached. Their reply (approval or corrections) is read by AI.</p>
        </Modal>
      )}
      {answer && (
        <Modal title="Customer's answer on the draft" onClose={() => setAnswer(null)} footer={<Button busy={busy === 'ans'} onClick={() => run('ans', async () => { set(await api.post(`/bl/${answer.bl.id}/customer-decision`, answer)); setAnswer(null); }, 'Saved')}>Save</Button>}>
          <Field label="Answer"><Select value={String(answer.approved)} onChange={(e) => setAnswer({ ...answer, approved: e.target.value === 'true' })} options={[{ value: 'true', label: 'Approved' }, { value: 'false', label: 'Wants corrections' }]} /></Field>
          {!answer.approved && <Field label="Corrections"><Textarea rows={4} value={answer.corrections} onChange={(e) => setAnswer({ ...answer, corrections: e.target.value })} /></Field>}
        </Modal>
      )}
      {agentReply && (
        <Modal title={`Reply to agent on draft ${label}`} onClose={() => setAgentReply(null)} footer={<Button busy={busy === 'ar'} onClick={() => run('ar', async () => { set(await api.post(`/bl/${agentReply.bl.id}/reply-agent`, agentReply)); setAgentReply(null); }, 'Sent to agent')}>Send</Button>}>
          <Field label="Reply"><Select value={String(agentReply.approve)} onChange={(e) => setAgentReply({ ...agentReply, approve: e.target.value === 'true' })} options={[{ value: 'true', label: 'Approved — issue the final' }, { value: 'false', label: 'Corrections needed' }]} /></Field>
          {!agentReply.approve && <Field label="Corrections" hint="Pre-filled from the SI check and the customer's reply. Edit as needed."><Textarea rows={8} value={agentReply.corrections} onChange={(e) => setAgentReply({ ...agentReply, corrections: e.target.value })} /></Field>}
          {agentReply.approve && agentReply.bl.status !== 'customer_approved' && <div className="alert alert-amber">The customer has not approved this draft yet.</div>}
          <Field label="Note (optional)"><Input value={agentReply.note} onChange={(e) => setAgentReply({ ...agentReply, note: e.target.value })} /></Field>
        </Modal>
      )}
    </Card>
  );
}

function Checklist({ d, set }) {
  const { job } = d;
  const [busy, run] = useAction();
  const [ask, setAsk] = useState(null);
  const [add, setAdd] = useState('');
  const customerDocs = d.docs.doc_types.filter((t) => t.from === 'customer' && t.code !== 'other');
  const listed = new Set(d.docs.checklist.map((r) => r.code));
  const req = (body) => run(`r${body.code}`, async () => set(await api.post(`/jobs/${job.id}/doc-requirement`, body)));
  return (
    <Card title="Document checklist" actions={
      <div className="row gap-sm wrap filters">
        <Select value={add} placeholder="+ Add to checklist" onChange={(e) => { if (e.target.value) req({ code: e.target.value, extra: true }); setAdd(''); }} options={d.docs.doc_types.filter((t) => !listed.has(t.code) && t.code !== 'other').map((t) => ({ value: t.code, label: t.name }))} />
        <Button small onClick={() => setAsk({ codes: d.docs.missing_from_customer, note: '', to: job.customer_email || '' })}>Ask customer for documents</Button>
      </div>
    }>
      <Table
        rowKey="code"
        rows={d.docs.checklist}
        columns={[
          { label: 'Document', render: (r) => <b>{r.name}</b> },
          { label: 'Comes from', render: (r) => FROM[r.from] || r.from },
          { label: 'Status', render: (r) => <B map={CHECK_STATUS} s={r.status} /> },
          { label: 'Files', render: (r) => r.files.map((id) => { const f = d.files.find((x) => x.id === id); return f && <a key={id} href={`/api/job-files/${id}`} target="_blank" rel="noreferrer" className="small">{f.filename} </a>; }) },
          { label: '', render: (r) => (
            <div className="row gap-sm end">
              {r.status === 'missing' && <Button small variant="ghost" busy={busy === `r${r.code}`} onClick={() => req({ code: r.code, waived: true })}>Not needed</Button>}
              {r.status === 'waived' && <Button small variant="ghost" busy={busy === `r${r.code}`} onClick={() => req({ code: r.code, waived: false })}>Needed</Button>}
              {!r.required && r.status === 'missing' && <Button small variant="ghost" onClick={() => req({ code: r.code, extra: false })}>Remove</Button>}
            </div>
          ) },
        ]}
      />
      {job.docs_requested_at && <p className="small muted">Last asked the customer {fmtDateTime(job.docs_requested_at)}. Documents they email back are filed here automatically.</p>}
      {ask && (
        <Modal title="Ask customer for documents" onClose={() => setAsk(null)} footer={<Button busy={busy === 'ask'} disabled={!ask.codes.length} onClick={() => run('ask', async () => { set(await api.post(`/jobs/${job.id}/request-documents`, ask)); setAsk(null); }, 'Request sent')}>Send request</Button>}>
          <Field label="To"><Input value={ask.to} onChange={(e) => setAsk({ ...ask, to: e.target.value })} /></Field>
          <Field label="Documents">
            {customerDocs.map((t) => <Check key={t.code} label={t.name} checked={ask.codes.includes(t.code)} onChange={(v) => setAsk({ ...ask, codes: v ? [...ask.codes, t.code] : ask.codes.filter((c) => c !== t.code) })} />)}
          </Field>
          <Field label="Note (optional)"><Textarea rows={3} value={ask.note} onChange={(e) => setAsk({ ...ask, note: e.target.value })} /></Field>
          <p className="small muted">The SI cut-off, if known, is mentioned in the email.</p>
        </Modal>
      )}
    </Card>
  );
}

function Files({ d, set }) {
  const [busy, run] = useAction();
  const [kind, setKind] = useState('invoice');
  const types = d.docs.doc_types.map((t) => ({ value: t.code, label: t.name }));
  const upload = (files) => run('up', async () => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    fd.append('kind', kind);
    set(await api.form(`/jobs/${d.job.id}/files`, fd));
  }, 'Uploaded');
  return (
    <Card title="Files" actions={
      <div className="row gap-sm filters">
        <Select value={kind} onChange={(e) => setKind(e.target.value)} options={types} />
        <label className="btn btn-primary btn-sm">{busy === 'up' ? 'Uploading…' : 'Upload'}<input type="file" multiple hidden onChange={(e) => e.target.files.length && upload([...e.target.files])} /></label>
      </div>
    }>
      <Table
        rows={d.files}
        empty="No files yet. Files the customer and agents email are added here automatically."
        columns={[
          { label: 'File', render: (f) => <a href={`/api/job-files/${f.id}`} target="_blank" rel="noreferrer">{f.filename}</a> },
          { label: 'Type', render: (f) => <Select value={f.kind || 'other'} onChange={(e) => run(`k${f.id}`, async () => set(await api.put(`/job-files/${f.id}`, { kind: e.target.value })))} options={types} /> },
          { label: 'From', render: (f) => (f.email_id ? 'email' : 'uploaded') },
          { label: 'Size', render: (f) => `${Math.max(1, Math.round((f.size || 0) / 1024))} KB` },
          { label: 'Added', render: (f) => fmtDateTime(f.created_at) },
          { label: '', render: (f) => <Button small variant="ghost" busy={busy === `x${f.id}`} onClick={() => confirm('Delete this file?') && run(`x${f.id}`, async () => set(await api.del(`/job-files/${f.id}`)))}>Delete</Button> },
        ]}
      />
    </Card>
  );
}

export default function JobDocuments({ d, set }) {
  return (
    <div className="stack">
      <Checklist d={d} set={set} />
      <ShippingInstructions d={d} set={set} />
      <BillsOfLading d={d} set={set} />
      <Files d={d} set={set} />
    </div>
  );
}
