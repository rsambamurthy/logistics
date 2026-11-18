import { useMeta } from '../components/meta.jsx';
import CrudPage from '../components/CrudPage.jsx';
import { Badge } from '../components/ui.jsx';
import { partyFields } from '../components/party.js';

export default function Customers() {
  const meta = useMeta();
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
      ]}
      fields={partyFields(meta.currencies)}
    />
  );
}
