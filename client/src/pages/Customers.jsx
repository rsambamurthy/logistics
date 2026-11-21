import { useMeta } from '../components/meta.jsx';
import CrudPage from '../components/CrudPage.jsx';
import { Badge, useLoad } from '../components/ui.jsx';
import { api } from '../api.js';
import { PaymentBadge } from '../components/planning.jsx';
import { useCan } from '../components/session.js';
import { partyFields } from '../components/party.js';

export default function Customers() {
  const meta = useMeta();
  const can = useCan();
  const risk = useLoad(() => (can('jobs.view') || can('quotes.prepare') ? api.get('/customers/payment-risk') : Promise.resolve({})), []);
  const r = risk.data || {};
  return (
    <CrudPage
      title="Customers"
      sub="Everyone who asks you for rates: shippers, and partner agents asking on behalf of their own customers."
      endpoint="/agents"
      listUrl="/agents?role=customer"
      blank={{ active: true, is_customer: true, is_agent: false, currency: 'INR', services: [] }}
      searchText={(c) => `${c.company} ${c.contact} ${c.email} ${c.country}`}
      columns={[
        { key: 'company', label: 'Company', render: (c) => <><b>{c.company}</b> {c.is_agent && <Badge color="blue">also partner agent</Badge>} {c.source === 'email' && <Badge color="amber">from email</Badge>}</> },
        { key: 'contact', label: 'Contact' },
        { key: 'email', label: 'Email' },
        { key: 'country', label: 'Country' },
        { key: 'currency', label: 'Quote currency' },
        { key: 'margin_pct', label: 'Margin %', render: (c) => (c.margin_pct ?? '') },
        { key: 'pays', label: 'Pays', render: (c) => (r[c.id] ? <span title={r[c.id].advice}><PaymentBadge r={r[c.id]} />{r[c.id].overdue > 0 && <div className="small err">{r[c.id].overdue.toLocaleString('en-IN')} {r[c.id].currency} overdue</div>}</span> : <span className="small muted">no invoices</span>) },
      ]}
      fields={partyFields(meta.currencies)}
    />
  );
}
