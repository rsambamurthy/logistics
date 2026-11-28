import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { PageHeader, Card, Button, Textarea, useLoad, useAction, useToast } from '../components/ui.jsx';
import { ShipmentForm, AgentPicker } from '../components/rfq.jsx';

const EMPTY = { requester_role: 'customer', mode: 'FCL', containers: [{ type: '40HC', qty: 1 }], legs: ['freight'] };

export default function RfqNew() {
  const nav = useNavigate();
  const toast = useToast();
  const parties = useLoad(() => api.get('/agents'));
  const mailboxes = useLoad(() => api.get('/mailboxes'));
  const settings = useLoad(() => api.get('/settings'));
  const aiReady = !settings.data || settings.data.ai?.has_key || settings.data.ai?.platform_key;
  const [rfq, setRfq] = useState(EMPTY);
  const [invites, setInvites] = useState([]);
  const [enquiry, setEnquiry] = useState('');
  const [busy, run] = useAction();

  const readEnquiry = () => run('ai', async () => {
    const r = await api.post('/enquiry/parse', { text: enquiry });
    const n = (r.customer_name || '').toLowerCase();
    const match = n && (parties.data || []).find((c) => c.company.toLowerCase().includes(n) || n.includes(c.company.toLowerCase()));
    setRfq((x) => ({
      ...x,
      ...Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== null && v !== undefined && v !== '' && !['customer_name', 'requester_reference'].includes(k))),
      containers: r.containers?.length ? r.containers : x.containers,
      requester_ref: r.requester_reference || x.requester_ref,
      requester_id: match?.id || x.requester_id,
      requester_role: match ? (match.is_agent && !match.is_customer ? 'agent' : 'customer') : x.requester_role,
    }));
    toast(match || !r.customer_name ? 'Enquiry read. Please check the details.' : `Enquiry read. "${r.customer_name}" is not in your Business Partners yet.`);
  });

  const save = (send) => run(send ? 'send' : 'save', async () => {
    if (!rfq.legs?.length) throw new Error('Pick at least one leg to price');
    if (send && !invites.length) throw new Error('Add at least one partner agent');
    if (invites.some((i) => !i.legs.length)) throw new Error('Each agent needs at least one leg');
    const body = { ...rfq, deadline: rfq.deadline ? new Date(rfq.deadline).toISOString() : null, invites };
    const created = await api.post('/rfqs', body);
    const priced = (created.rate_cards?.results || []).filter((x) => !x.skipped);
    if (priced.length) toast(`Priced from rate cards: ${priced.map((x) => x.party).join(', ')}${created.rate_cards.missing_names.length ? ` (still missing: ${created.rate_cards.missing_names.join(', ')})` : ''}`);
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
      <Card title="1. Enquiry from customer or partner agent (optional)" actions={<Button variant="ghost" busy={busy === 'ai'} disabled={!enquiry.trim() || !aiReady} title={aiReady ? '' : 'AI reading is not set up yet'} onClick={readEnquiry}>Read with AI</Button>}>
        {!aiReady && <div className="alert alert-amber small">AI reading is not set up for your company yet, so fill in the shipment details below by hand. An administrator can add the AI key in Settings → AI.</div>}
        <Textarea rows={5} placeholder="Paste the customer's email or WhatsApp message here…" value={enquiry} onChange={(e) => setEnquiry(e.target.value)} />
      </Card>
      <Card title="2. Shipment">
        <ShipmentForm value={rfq} onChange={setRfq} parties={parties.data || []} mailboxes={mailboxes.data || []} />
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
