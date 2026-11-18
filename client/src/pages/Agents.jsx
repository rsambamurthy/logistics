import { useMeta } from '../components/meta.jsx';
import { api } from '../api.js';
import CrudPage from '../components/CrudPage.jsx';
import { Badge, Field, useLoad } from '../components/ui.jsx';
import { LegPicker } from '../components/rfq.jsx';

const TYPES = ['Overseas agent', 'Co-loader / NVOCC', 'Shipping line', 'Airline / GSA', 'Transporter', 'Customs broker / CHA', 'Other'];

export default function Agents() {
  const meta = useMeta();
  const stats = useLoad(() => api.get('/agents-stats'));
  const st = (id) => (stats.data || []).find((s) => s.id === id) || {};
  return (
    <CrudPage
      title="Partner agents"
      sub="Agents you request quotes from. They only ever receive and reply by email."
      endpoint="/agents"
      blank={{ active: true, services: ['freight'] }}
      searchText={(a) => `${a.company} ${a.contact} ${a.email} ${a.ports} ${a.country} ${a.city}`}
      columns={[
        { key: 'company', label: 'Company', render: (a) => <div><b>{a.company}</b>{!a.active && <> <Badge>inactive</Badge></>}<div className="muted small">{a.contact}</div></div> },
        { key: 'email', label: 'Email' },
        { key: 'agent_type', label: 'Type' },
        { label: 'Location', render: (a) => [a.city, a.country].filter(Boolean).join(', ') },
        { label: 'Quotes for', render: (a) => <span className="small">{(a.services || []).map(meta.legName).join(', ')}</span> },
        { label: 'Reply rate', render: (a) => { const s = st(a.id); return s.invited ? `${Math.round((s.replied / s.invited) * 100)}% (${s.replied}/${s.invited})` : '—'; } },
        { label: 'Avg reply', render: (a) => (st(a.id).avg_reply_hours ? `${st(a.id).avg_reply_hours} h` : '—') },
        { label: 'Won', render: (a) => st(a.id).won || '' },
      ]}
      fields={[
        { key: 'company', label: 'Company' },
        { key: 'contact', label: 'Contact person' },
        { key: 'email', label: 'Email (RFQs go here)', type: 'email' },
        { key: 'cc', label: 'CC (comma separated)' },
        { key: 'agent_type', label: 'Type', type: 'select', options: TYPES },
        { key: 'country', label: 'Country' },
        { key: 'city', label: 'City' },
        { key: 'ports', label: 'Ports / lanes covered', span: 2, hint: 'Used to suggest this agent, e.g. "Chennai, Nhava Sheva, Hong Kong, Shenzhen"' },
        { key: 'notes', label: 'Notes', type: 'textarea', span: 2, rows: 2 },
        { key: 'active', label: 'Status', type: 'checkbox', checkLabel: 'Active' },
      ]}
      renderExtraFields={(v, set) => <Field label="Legs this agent quotes for"><LegPicker value={v.services || []} onChange={(s) => set({ ...v, services: s })} /></Field>}
    />
  );
}
