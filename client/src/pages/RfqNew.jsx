import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { PageHeader, Card, Button, Textarea, useLoad, useAction, useToast } from '../components/ui.jsx';
import { ShipmentForm, AgentPicker } from '../components/rfq.jsx';

const EMPTY = { mode: 'FCL', containers: [{ type: '40HC', qty: 1 }], legs: ['freight'] };

export default function RfqNew() {
  const nav = useNavigate();
  const toast = useToast();
  const customers = useLoad(() => api.get('/customers'));
  const mailboxes = useLoad(() => api.get('/mailboxes'));
  const [rfq, setRfq] = useState(EMPTY);
  const [invites, setInvites] = useState([]);
  const [enquiry, setEnquiry] = useState('');
  const [busy, run] = useAction();

  const readEnquiry = () => run('ai', async () => {
    const r = await api.post('/enquiry/parse', { text: enquiry });
    const match = r.customer_name && (customers.data || []).find((c) => c.name.toLowerCase().includes(r.customer_name.toLowerCase()) || r.customer_name.toLowerCase().includes(c.name.toLowerCase()));
    setRfq((x) => ({
      ...x,
      ...Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== null && v !== undefined && v !== '' && k !== 'customer_name')),
      containers: r.containers?.length ? r.containers : x.containers,
      customer_id: match?.id || x.customer_id,
    }));
    toast(match || !r.customer_name ? 'Enquiry read. Please check the details.' : `Enquiry read. Customer "${r.customer_name}" is not in your list yet.`);
  });

  const save = (send) => run(send ? 'send' : 'save', async () => {
    if (!rfq.legs?.length) throw new Error('Pick at least one leg to price');
    if (send && !invites.length) throw new Error('Add at least one partner agent');
    if (invites.some((i) => !i.legs.length)) throw new Error('Each agent needs at least one leg');
    const body = { ...rfq, deadline: rfq.deadline ? new Date(rfq.deadline).toISOString() : null, invites };
    const created = await api.post('/rfqs', body);
    if (send) {
      const res = await api.post(`/rfqs/${created.id}/send`);
      const failed = res.filter((x) => !x.ok);
      if (failed.length) toast(`${res.length - failed.length} sent, ${failed.length} failed: ${failed[0].error}`, 'error');
      else toast(`RFQ ${created.ref} sent to ${res.length} agent(s)`);
    } else toast(`Saved ${created.ref} as draft`);
    nav(`/rfqs/${created.id}`);
  });

  return (
    <>
      <PageHeader title="New RFQ" sub="Paste the customer's enquiry, check the details, pick partner agents, send." />
      <Card title="1. Customer enquiry (optional)" actions={<Button variant="ghost" busy={busy === 'ai'} disabled={!enquiry.trim()} onClick={readEnquiry}>Read with AI</Button>}>
        <Textarea rows={5} placeholder="Paste the customer's email or WhatsApp message here…" value={enquiry} onChange={(e) => setEnquiry(e.target.value)} />
      </Card>
      <Card title="2. Shipment">
        <ShipmentForm value={rfq} onChange={setRfq} customers={customers.data || []} mailboxes={mailboxes.data || []} />
      </Card>
      <Card title="3. Partner agents">
        <AgentPicker rfq={rfq} invites={invites} onChange={setInvites} />
      </Card>
      <div className="row gap end">
        <Button variant="ghost" busy={busy === 'save'} onClick={() => save(false)}>Save draft</Button>
        <Button busy={busy === 'send'} onClick={() => save(true)}>Save & email agents</Button>
      </div>
    </>
  );
}
