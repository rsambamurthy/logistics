// Live tracking card on the job page: public link, numbers being tracked, events, update emails.
import { useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Badge, Table, Modal, Field, Input, Select, Check, useAction, useToast, fmtDateTime } from './ui.jsx';
import { fmtLocal } from './jobs.jsx';
import TrackMap from './TrackMap.jsx';

const sp = (v) => fmtLocal(String(v || '').replace(' ', 'T'));
const KIND = { departed: 'Departed', arrived: 'Arrived', completed: 'Completed', eta: 'ETA update' };

export default function JobTracking({ d, set }) {
  const tr = d.tracking;
  const [busy, run] = useAction();
  const toast = useToast();
  const [add, setAdd] = useState(null);
  const [send, setSend] = useState(null);
  const snap = tr.rows.find((r) => r.snapshot?.pol || r.snapshot?.position)?.snapshot;
  const copy = async () => { await navigator.clipboard.writeText(tr.url); toast('Link copied'); };
  const sent = Object.entries(tr.last_notified || {}).filter(([k]) => KIND[k]);
  return (
    <Card title="Live tracking" actions={
      <div className="row gap-sm wrap">
        {tr.url ? <>
          <Button small variant="ghost" onClick={copy}>Copy tracking link</Button>
          <a className="btn btn-ghost btn-sm" href={tr.url} target="_blank" rel="noreferrer">Open</a>
        </> : <Button small variant="ghost" busy={busy === 'ln'} onClick={() => run('ln', async () => set(await api.post(`/jobs/${d.job.id}/tracking/link`)))}>Create tracking link</Button>}
        <Button small variant="ghost" onClick={() => setSend({ kind: { booked: 'eta', departed: 'departed', arrived: 'arrived', completed: 'completed' }[d.job.status] || 'eta' })}>Send update email</Button>
        <Button small busy={busy === 'rf'} disabled={!tr.configured} onClick={() => run('rf', async () => { const r = await api.post(`/jobs/${d.job.id}/tracking/refresh`); set(r); if (r.warnings?.length) throw new Error(r.warnings[0]); }, 'Tracking refreshed')}>Refresh now</Button>
      </div>
    }>
      {!tr.configured && <div className="alert alert-amber">Live tracking is not switched on yet. Add your {tr.provider} API key in Settings → Tracking. Until then, milestones are set by hand and the tracking link shows the booking details.</div>}
      <div className="row gap wrap" style={{ marginBottom: 10 }}>
        <Check label="Tracking link on (customer can open it)" checked={tr.enabled} onChange={(v) => run('en', async () => set(await api.put(`/jobs/${d.job.id}/tracking`, { track_enabled: v })))} />
        <Check label="Also email milestone updates to the partner agents" checked={tr.notify_agents} onChange={(v) => run('na', async () => set(await api.put(`/jobs/${d.job.id}/tracking`, { notify_agents: v })))} />
        {tr.url && <Button small variant="ghost" onClick={() => confirm('Make a new link? The old link stops working.') && run('rs', async () => set(await api.post(`/jobs/${d.job.id}/tracking/link`, { reset: true })), 'New link created')}>New link</Button>}
      </div>
      {sent.length > 0 && <p className="small muted">Emailed to customer: {sent.map(([k, v]) => `${KIND[k]} (${fmtDateTime(v)})`).join(', ')}</p>}

      <Table
        rows={tr.rows}
        empty="Nothing tracked yet. Tracking starts once the main-freight booking has a BL, booking or container number (AWB for air)."
        columns={[
          { label: 'Number', render: (r) => <><b>{r.number}</b> <span className="small muted">{r.number_type}</span></> },
          { label: 'Status', render: (r) => (r.last_error ? <span className="small err">{r.last_error}</span> : <Badge color={r.status === 'arrived' || r.status === 'delivered' ? 'green' : 'blue'}>{(r.status || 'waiting').replace('_', ' ')}</Badge>) },
          { label: 'Vessel / flight', render: (r) => r.snapshot?.flight || [r.snapshot?.vessel, r.snapshot?.voyage].filter(Boolean).join(' / ') || '—' },
          { label: 'ETA', render: (r) => (r.snapshot?.eta ? `${sp(r.snapshot.predicted_eta || r.snapshot.eta.at)}${r.snapshot.eta.actual ? ' (arrived)' : ''}` : '—') },
          { label: 'Checked', render: (r) => <span className="small">{r.last_polled_at ? fmtDateTime(r.last_polled_at) : 'not yet'}{r.active ? '' : ' · finished'}</span> },
          { label: '', render: (r) => <Button small variant="ghost" onClick={() => confirm('Stop tracking this number?') && run(`x${r.id}`, async () => set(await api.del(`/tracking/${r.id}`)))}>Remove</Button> },
        ]}
      />
      <div style={{ margin: '8px 0 14px' }}><Button small variant="ghost" onClick={() => setAdd({ number: '', number_type: d.rfq?.mode === 'AIR' ? 'AWB' : 'CT', mode: d.rfq?.mode === 'AIR' ? 'air' : 'sea' })}>+ Track another number</Button></div>

      {(snap?.path?.length > 0 || snap?.position) && <TrackMap path={snap.path} position={snap.position} height={260} />}
      {tr.events.length > 0 && (
        <ul className="track-events" style={{ marginTop: 12 }}>
          {tr.events.map((e) => (
            <li key={e.id} className={e.actual ? '' : 'planned'}>
              <span className="when">{sp(e.at)}{e.actual ? '' : ' (planned)'}</span>
              <span><b>{e.description}</b>{e.location ? ` — ${e.location}` : ''}{e.container ? <span className="small muted"> · {e.container}</span> : null}</span>
            </li>
          ))}
        </ul>
      )}

      {add && (
        <Modal title="Track another number" onClose={() => setAdd(null)} footer={<Button busy={busy === 'add'} onClick={() => run('add', async () => { set(await api.post(`/jobs/${d.job.id}/tracking`, add)); setAdd(null); }, 'Added. It is checked on the next refresh.')}>Add</Button>}>
          <Field label="Number"><Input value={add.number} onChange={(e) => setAdd({ ...add, number: e.target.value })} /></Field>
          <Field label="Type"><Select value={add.number_type} onChange={(e) => setAdd({ ...add, number_type: e.target.value, mode: e.target.value === 'AWB' ? 'air' : 'sea' })} options={[{ value: 'CT', label: 'Container number' }, { value: 'BL', label: 'Bill of lading' }, { value: 'BK', label: 'Booking number' }, { value: 'AWB', label: 'Air waybill' }]} /></Field>
        </Modal>
      )}
      {send && (
        <Modal title="Send update email to customer" onClose={() => setSend(null)} footer={<Button busy={busy === 'snd'} onClick={() => run('snd', async () => { set(await api.post(`/jobs/${d.job.id}/notify`, send)); setSend(null); }, 'Update sent')}>Send</Button>}>
          <Field label="Update"><Select value={send.kind} onChange={(e) => setSend({ ...send, kind: e.target.value })} options={Object.entries(KIND).map(([value, label]) => ({ value, label }))} /></Field>
          <p className="small muted">Goes to the customer in their thread with vessel, dates and the tracking link{tr.notify_agents ? ', and to the partner agents' : ''}. Departed and arrived updates are sent once, automatically, when live tracking or you mark the milestone.</p>
        </Modal>
      )}
    </Card>
  );
}
