// Permission catalog and built-in roles. Pure: shared by the server (enforcement) and the client (what to show).
// As in VendorGate: roles bundle permissions; a user can hold several roles; approval authority is NOT a
// permission — approval levels are assigned to roles (Settings > Pricing), so everyone holding that role can approve.

export const PERMISSION_GROUPS = [
  {
    name: 'RFQs and quotations',
    items: [
      { code: 'rfqs.view', label: 'See RFQs and quotations' },
      { code: 'rfqs.edit', label: 'Create and edit RFQs, ask agents for rates', requires: ['rfqs.view'] },
      { code: 'quotes.prepare', label: 'Prepare customer quotations', requires: ['rfqs.view', 'costs.view'] },
      { code: 'quotes.send', label: 'Send quotations and follow-ups to customers', requires: ['rfqs.view'] },
      { code: 'quotes.decide', label: 'Mark quotations won or lost, award agents', requires: ['rfqs.view'] },
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
    name: 'Business Partners',
    items: [{ code: 'partners.manage', label: 'Add and edit business partners (partner agents and customers)' }],
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

const EVERYDAY = ['rfqs.view', 'rfqs.edit', 'quotes.prepare', 'quotes.send', 'quotes.decide', 'inbox.view', 'jobs.view', 'jobs.manage', 'costs.view', 'ratecards.manage', 'reports.view', 'partners.manage', 'data.all'];

/** Built-in roles. They match how Quayly worked before roles could be changed; Admin cannot be edited. */
export const SYSTEM_ROLES = [
  { key: 'admin', name: 'Administrator', description: 'Full access to the workspace', permissions: PERMISSION_CODES, locked: true },
  { key: 'manager', name: 'Manager', description: 'Everyday work; approves low-margin quotations (approval level)', permissions: EVERYDAY },
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

/**
 * Approval levels for low-margin quotations: [{ below_pct, role }]. The deepest level the margin falls under
 * decides which role must approve (e.g. below 8% → Manager, below 3% → Administrator). null = no approval needed.
 */
export function approvalLevelFor(marginPct, levels) {
  const hit = (levels || []).filter((l) => Number(marginPct) < Number(l.below_pct)).sort((a, b) => Number(a.below_pct) - Number(b.below_pct));
  return hit[0] || null;
}
/** Holding the level's role approves; the Administrator role can approve every level. */
export const canApproveLevel = (userRoles, role) => !!role && (userRoles || []).some((r) => r === role || r === 'admin');
