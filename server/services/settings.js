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
  pricing: {
    default_margin_pct: 10,
    default_agent_margin_pct: 5,
    floor_margin_pct: 3,
    default_tax_pct: 18,
    quote_validity_days: 7,
    auto_followup: true,
    rate_memory: true,
    rate_memory_days: 14,
    followup_days_before_expiry: 2,
    terms: 'Rates subject to space and equipment availability at time of booking.\nCharges not mentioned are payable at actuals.\nValidity as stated; surcharges as per carrier at time of shipment.',
  },
  ai: {
    model: 'claude-sonnet-5-5',
    key_enc: null,
    auto_parse: true,
    review_threshold: 0.75,
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
  out.ai = { ...out.ai, has_key: !!out.ai.key_enc, platform_key: !!process.env.ANTHROPIC_API_KEY && currentTenant()?.ai_enabled !== false, key_enc: undefined };
  return out;
}

export async function saveAi({ api_key, ...rest }) {
  const patch = { ...rest };
  if (api_key) patch.key_enc = encrypt(api_key);
  if (api_key === '') patch.key_enc = null;
  return setSetting('ai', patch);
}

/** Tenant's own key first; otherwise the platform key if the tenant's plan includes AI. */
export async function getAiKey() {
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
