import { useMeta } from '../components/meta.jsx';
import CrudPage from '../components/CrudPage.jsx';

export default function Customers() {
  const meta = useMeta();
  return (
    <CrudPage
      title="Customers"
      sub="Shippers you send quotations to."
      endpoint="/customers"
      blank={{ currency: 'INR' }}
      columns={[
        { key: 'name', label: 'Name', render: (c) => <b>{c.name}</b> },
        { key: 'contact', label: 'Contact' },
        { key: 'email', label: 'Email' },
        { key: 'country', label: 'Country' },
        { key: 'currency', label: 'Quote currency' },
        { key: 'margin_pct', label: 'Margin %', render: (c) => (c.margin_pct ?? '') },
      ]}
      fields={[
        { key: 'name', label: 'Company name' },
        { key: 'contact', label: 'Contact person' },
        { key: 'email', label: 'Email', type: 'email' },
        { key: 'country', label: 'Country' },
        { key: 'currency', label: 'Quote currency', type: 'select', options: meta.currencies },
        { key: 'margin_pct', label: 'Default margin %', type: 'number', hint: 'Blank = company default' },
      ]}
    />
  );
}
