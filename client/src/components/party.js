// Shared field definitions for the single party list (partner agents and customers).
export const AGENT_TYPES = ['Overseas agent', 'Freight forwarder', 'Co-loader / NVOCC', 'Shipping line', 'Airline / GSA', 'Transporter', 'Customs broker / CHA', 'Shipper / exporter', 'Importer', 'Other'];

export const roleLabel = (p) => [p.is_customer && 'customer', p.is_agent && 'partner agent'].filter(Boolean).join(' + ') || '—';

export function partyFields(currencies) {
  return [
    { key: 'company', label: 'Company' },
    { key: 'contact', label: 'Contact person' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'cc', label: 'CC (comma separated)' },
    { key: 'agent_type', label: 'Type', type: 'select', options: AGENT_TYPES },
    { key: 'country', label: 'Country' },
    { key: 'city', label: 'City' },
    { key: 'ports', label: 'Ports / lanes covered', span: 2, hint: 'Used to suggest them as a partner agent, e.g. "Chennai, Nhava Sheva, Hong Kong"' },
    { key: 'is_agent', label: 'Partner agent', type: 'checkbox', checkLabel: 'We ask them for rates' },
    { key: 'is_customer', label: 'Customer', type: 'checkbox', checkLabel: 'They ask us for rates' },
    { key: 'active', label: 'Status', type: 'checkbox', checkLabel: 'Active' },
    { key: 'currency', label: 'Quote them in', type: 'select', options: currencies, placeholder: 'Default' },
    { key: 'margin_pct', label: 'Our margin % when quoting them', type: 'number', hint: 'Blank = default for customers / agents' },
    { key: 'tax_pct', label: 'Tax % on our quotes', type: 'number', hint: 'Blank = 18% on INR quotes, 0 otherwise' },
    { key: 'credit_days', label: 'Credit days', type: 'number', hint: 'Days to pay our invoice; blank = 30' },
    { key: 'quote_language', label: 'Quotation language', type: 'select', options: [{ value: 'en', label: 'English' }, { value: 'zh', label: '繁體中文' }], placeholder: 'English' },
    { key: 'notes', label: 'Notes', type: 'textarea', span: 3, rows: 2 },
  ];
}
