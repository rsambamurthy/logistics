import { liveSideEffects } from '../lib/runtime.js';
import { q, one, currentTenant } from '../db.js';
import { encrypt, decrypt } from '../lib/crypto.js';

export const DEFAULTS = {
  company: {
    name: 'Your Company Pvt Ltd',
    address: '',
    phone: '',
    email: '',
    gstin: '',
    country: 'IN',
    logo_url: '',
  },
  fx: {
    base: 'INR',
    buffer_pct: 1,
    rates: { USD: 84.5, HKD: 10.85, EUR: 91.5, CNY: 11.7, SGD: 63, AED: 23, GBP: 107 },
  },
  consol: { window_days: 3, capacity_kg: null, container: '40HC' }, // consolidation agent
  pricing: {
    default_margin_pct: 10,
    default_agent_margin_pct: 5,
    floor_margin_pct: 3,
    approval_levels: null, // [{ below_pct, role }]; null = one level: below floor_margin_pct → Manager
    default_tax_pct: 18,
    quote_validity_days: 7,
    auto_followup: true,
    rate_memory: true,
    rate_memory_days: 14,
    followup_days_before_expiry: 2,
    terms: 'Rates subject to space and equipment availability at time of booking.\nCharges not mentioned are payable at actuals.\nValidity as stated; surcharges as per carrier at time of shipment.',
  },
  onboarding: { dismissed: false },
  tracking: {
    provider: 'searates',
    key_enc: null,
    enabled: true,
    poll_hours: 6,
    auto_milestones: true,
    email_milestones: true,
    eta_change_hours: 24,
    auto_delay_email: false, // email the customer as soon as a delay is predicted
    notify_agents_default: false,
  },
  ai: {
    model: 'claude-sonnet-5-5',
    key_enc: null,
    auto_parse: true,
    review_threshold: 0.75,
    auto_apply_rates: false, // rate sheets by email: apply without review
  },
};

export async function getSetting(key) {
  const row = await one('SELECT value FROM settings WHERE key=$1', [key]);
  return { ...DEFAULTS[key], ...(row?.value || {}) };
}

export async function setSetting(key, value) {
  const current = await getSetting(key);
  const merged = { ...current, ...value };
  await q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, merged]);
  return merged;
}

export async function getAllPublic() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = await getSetting(k);
  out.tracking = { ...out.tracking, has_key: !!out.tracking.key_enc, platform_key: !!process.env.SEARATES_API_KEY, key_enc: undefined };
  out.ai = { ...out.ai, has_key: !!out.ai.key_enc, platform_key: !!process.env.ANTHROPIC_API_KEY && currentTenant()?.ai_enabled !== false, key_enc: undefined };
  return out;
}

export async function saveAi({ api_key, remove_key, ...rest }) {
  const patch = { ...rest };
  if (api_key) patch.key_enc = encrypt(api_key);
  if (remove_key) patch.key_enc = null; // a blank key box keeps the stored key
  return setSetting('ai', patch);
}

/** Tenant's own key first; otherwise the platform key if the tenant's plan includes AI. */
export async function getAiKey() {
  if (!liveSideEffects()) return null; // test copies never spend AI credits
  const ai = await getSetting('ai');
  const own = decrypt(ai.key_enc);
  if (own) return own;
  const t = currentTenant();
  if (t && t.ai_enabled === false) return null;
  return process.env.ANTHROPIC_API_KEY || null;
}

export async function getFx() {
  return getSetting('fx');
}

export async function saveTracking({ api_key, remove_key, ...rest }) {
  const patch = { ...rest };
  if (api_key) patch.key_enc = encrypt(api_key);
  if (remove_key) patch.key_enc = null; // a blank key box keeps the stored key
  return setSetting('tracking', patch);
}

/** Tracking provider key: the tenant's own, else the platform's (SEARATES_API_KEY etc.). */
export async function getTrackingConfig() {
  const t = await getSetting('tracking');
  const envKey = process.env[`${String(t.provider || '').toUpperCase()}_API_KEY`] || null;
  return { ...t, key: liveSideEffects() ? decrypt(t.key_enc) || envKey : null };
}

/** Approval levels for low-margin quotes (older settings: one level below the minimum margin, approved by Manager). */
export async function getApprovalLevels() {
  const p = await getSetting('pricing');
  if (Array.isArray(p.approval_levels)) return p.approval_levels.filter((l) => l.role && l.below_pct !== '' && l.below_pct !== null);
  return [{ below_pct: Number(p.floor_margin_pct || 0), role: 'manager' }];
}
