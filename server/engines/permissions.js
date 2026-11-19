// Permission catalog and built-in roles. Pure: shared by the server (enforcement) and the client (what to show).

export const PERMISSION_GROUPS = [
  {
    name: 'RFQs and quotations',
    items: [
      { code: 'rfqs.view', label: 'See RFQs and quotations' },
      { code: 'rfqs.edit', label: 'Create and edit RFQs, ask agents for rates', requires: ['rfqs.view'] },
      { code: 'quotes.prepare', label: 'Prepare customer quotations', requires: ['rfqs.view', 'costs.view'] },
      { code: 'quotes.send', label: 'Send quotations and follow-ups to customers', requires: ['rfqs.view'] },
      { code: 'quotes.decide', label: 'Mark quotations won or lost, award agents', requires: ['rfqs.view'] },
      { code: 'quotes.approve', label: 'Approve quotations below the minimum margin', requires: ['rfqs.view', 'costs.view'] },
      { code: 'inbox.view', label: 'Unmatched mail (assign, ignore, create RFQs from emails)', requires: ['rfqs.view'] },
    ],
  },
  {
    name: 'Jobs',
    items: [
      { code: 'jobs.view', label: 'See jobs, bookings, documents and tracking' },
      { code: 'jobs.manage', label: 'Bookings, documents, milestones and emails to agents and customers', requires: ['jobs.view'] },
    ],
  },
  {
    name: 'Money',
    items: [
      { code: 'costs.view', label: 'See buy rates, agent quotes, margins and profit' },
      { code: 'ratecards.manage', label: 'Add and change rate cards', requires: ['costs.view'] },
      { code: 'reports.view', label: 'Reports (company-wide figures)', requires: ['costs.view', 'data.all'] },
    ],
  },
  {
    name: 'Contacts',
    items: [{ code: 'contacts.manage', label: 'Add and edit partner agents and customers' }],
  },
  {
    name: 'Administration',
    items: [
      { code: 'settings.manage', label: 'Company, pricing and FX, mailboxes, AI, tracking' },
      { code: 'users.manage', label: 'Users and roles' },
      { code: 'billing.manage', label: 'Subscription and billing' },
      { code: 'audit.view', label: 'Activity log for the whole company' },
    ],
  },
  {
    name: 'Whose records',
    items: [{ code: 'data.all', label: "See everyone's RFQs and jobs (otherwise only their own and those assigned to them)" }],
  },
];

export const PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items);
export const PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

const EVERYDAY = ['rfqs.view', 'rfqs.edit', 'quotes.prepare', 'quotes.send', 'quotes.decide', 'inbox.view', 'jobs.view', 'jobs.manage', 'costs.view', 'ratecards.manage', 'reports.view', 'contacts.manage', 'data.all'];

/** Built-in roles. They match how Quayly worked before roles could be changed; Admin cannot be edited. */
export const SYSTEM_ROLES = [
  { key: 'admin', name: 'Admin', description: 'Everything, including settings, users and billing', permissions: PERMISSION_CODES, locked: true },
  { key: 'manager', name: 'Manager', description: 'Everyday work plus approving low-margin quotations', permissions: [...EVERYDAY, 'quotes.approve'] },
  { key: 'user', name: 'User', description: 'Everyday work: RFQs, quotations and jobs', permissions: EVERYDAY },
];

/** Add what each permission needs (e.g. rate cards need costs) and drop unknown codes. */
export function normalisePermissions(list) {
  const out = new Set((list || []).filter((c) => PERMISSION_CODES.includes(c)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of [...out]) {
      for (const r of PERMISSIONS.find((p) => p.code === c)?.requires || []) {
        if (!out.has(r)) { out.add(r); grew = true; }
      }
    }
  }
  return PERMISSION_CODES.filter((c) => out.has(c));
}

export const can = (perms, code) => Array.isArray(perms) && perms.includes(code);
