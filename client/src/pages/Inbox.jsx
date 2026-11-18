import { useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Card, Table, Button, Modal, Field, Select, Loading, useLoad, useAction, fmtDateTime } from '../components/ui.jsx';
import { EmailView } from './RfqDetail.jsx';

export default function Inbox() {
  const list = useLoad(() => api.get('/inbox/unmatched'));
  const [open, setOpen] = useState(null);
  return (
    <>
      <PageHeader title="Unmatched mail" sub="Emails the system could not file automatically: link a reply to an RFQ, or turn an enquiry into a new RFQ." />
      <Card>
        {list.loading ? <Loading /> : (
          <Table rows={list.data} empty="All incoming emails were matched." onRowClick={setOpen} columns={[
            { key: 'from_addr', label: 'From' },
            { key: 'subject', label: 'Subject', render: (e) => <b>{e.subject}</b> },
            { key: 'preview', label: 'Preview', render: (e) => <span className="small muted">{e.preview?.slice(0, 140)}</span> },
            { key: 'at', label: 'Received', render: (e) => fmtDateTime(e.at) },
          ]} />
        )}
      </Card>
      {open && <AssignModal email={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); list.reload(); }} />}
    </>
  );
}

function AssignModal({ email, onClose, onDone }) {
  const full = useLoad(() => api.get(`/emails/${email.id}`), [email.id]);
  const rfqs = useLoad(() => api.get('/rfqs'));
  const [rfqId, setRfqId] = useState('');
  const detail = useLoad(() => (rfqId ? api.get(`/rfqs/${rfqId}`) : null), [rfqId]);
  const [inviteId, setInviteId] = useState('');
  const [busy, run] = useAction();
  const open = (rfqs.data || []).filter((r) => ['sent', 'quoting', 'quoted'].includes(r.status));
  return (
    <Modal wide title="Link this email" onClose={onClose} footer={<>
      <Button variant="ghost" busy={busy === 'new'} onClick={() => run('new', async () => { const r = await api.post(`/emails/${email.id}/create-rfq`); onDone(); window.location.assign(`/rfqs/${r.id}`); }, 'RFQ created from this enquiry')}>It's a new enquiry → create RFQ</Button>
      <Button variant="ghost" busy={busy === 'ig'} onClick={() => run('ig', async () => { await api.post(`/emails/${email.id}/ignore`); onDone(); }, 'Ignored')}>Ignore</Button>
      <Button busy={busy === 'as'} disabled={!inviteId} onClick={() => run('as', async () => { await api.post(`/emails/${email.id}/assign`, { invite_id: Number(inviteId) }); onDone(); }, 'Linked and read with AI')}>Link & read with AI</Button>
    </>}>
      <div className="grid g2">
        <Field label="RFQ"><Select placeholder="— select —" options={open.map((r) => ({ value: r.id, label: `${r.ref} · ${r.pol || ''} → ${r.pod || ''}` }))} value={rfqId} onChange={(e) => { setRfqId(e.target.value); setInviteId(''); }} /></Field>
        <Field label="Agent"><Select placeholder="— select —" options={(detail.data?.invites || []).map((i) => ({ value: i.id, label: i.agent_company }))} value={inviteId} onChange={(e) => setInviteId(e.target.value)} /></Field>
      </div>
      {full.data && <EmailView email={{ ...full.data, attachments: [] }} />}
    </Modal>
  );
}
