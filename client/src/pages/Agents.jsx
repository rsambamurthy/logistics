import { useMeta } from '../components/meta.jsx';
import { api } from '../api.js';
import CrudPage from '../components/CrudPage.jsx';
import { Badge, Field, useLoad } from '../components/ui.jsx';
import { LegPicker } from '../components/rfq.jsx';
import { partyFields } from '../components/party.js';

export default function Agents() {
  const meta = useMeta();
  const stats = useLoad(() => api.get('/agents-stats'));
  const st = (id) => (stats.data || []).find((s) => s.id === id) || {};
  return (
    <CrudPage
      title="Partner agents"
      sub="Agents you ask for rates. They only ever receive and reply by email. A company can also be a customer."
      endpoint="/agents"
      listUrl="/agents?role=agent"
      blank={{ active: true, is_agent: true, is_customer: false, services: ['freight'] }}
      searchText={(a) => `${a.company} ${a.contact} ${a.email} ${a.ports} ${a.country} ${a.city}`}
      columns={[
        { key: 'company', label: 'Company', render: (a) => <div><b>{a.company}</b> {a.is_customer && <Badge color="purple">also customer</Badge>}{!a.active && <> <Badge>inactive</Badge></>}<div className="muted small">{a.contact}</div></div> },
        { key: 'email', label: 'Email' },
        { key: 'agent_type', label: 'Type' },
        { label: 'Location', render: (a) => [a.city, a.country].filter(Boolean).join(', ') },
        { label: 'Quotes for', render: (a) => <span className="small">{(a.services || []).map(meta.legName).join(', ')}</span> },
        { label: 'Reply rate', render: (a) => { const s = st(a.id); return s.invited ? `${Math.round((s.replied / s.invited) * 100)}% (${s.replied}/${s.invited})` : '—'; } },
        { label: 'Avg reply', render: (a) => (st(a.id).avg_reply_hours ? `${st(a.id).avg_reply_hours} h` : '—') },
        { label: 'Won', render: (a) => st(a.id).won || '' },
      ]}
      fields={partyFields(meta.currencies)}
      renderExtraFields={(v, set) => <Field label="Legs this agent quotes for"><LegPicker value={v.services || []} onChange={(s) => set({ ...v, services: s })} /></Field>}
    />
  );
}
