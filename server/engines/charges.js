// Single source of truth for legs, charge codes and bases.
// Used by the AI reader, the manual editor, comparison and the customer quote.

export const LEGS = [
  { code: 'pickup', name: 'Origin trucking / pickup' },
  { code: 'export_customs', name: 'Export customs clearance' },
  { code: 'origin_charges', name: 'Origin port / terminal charges' },
  { code: 'freight', name: 'Main freight (sea / air)' },
  { code: 'destination_charges', name: 'Destination port / terminal charges' },
  { code: 'import_customs', name: 'Import customs clearance' },
  { code: 'delivery', name: 'Destination trucking / delivery' },
];
export const LEG_CODES = LEGS.map((l) => l.code);
export const legName = (code) => LEGS.find((l) => l.code === code)?.name || code;

export const BASES = [
  { code: 'per_shipment', name: 'Per shipment' },
  { code: 'per_container', name: 'Per container (all)' },
  { code: 'per_20', name: "Per 20' container" },
  { code: 'per_40', name: "Per 40' container" },
  { code: 'per_cbm', name: 'Per CBM' },
  { code: 'per_kg', name: 'Per kg (chargeable)' },
  { code: 'per_wm', name: 'Per W/M (revenue ton)' },
  { code: 'per_bl', name: 'Per BL / AWB' },
  { code: 'per_declaration', name: 'Per declaration (SB/BE/TDEC)' },
  { code: 'per_trip', name: 'Per truck trip' },
];
export const BASIS_CODES = BASES.map((b) => b.code);

// code, display name, default leg, default basis, synonyms used for normalisation
export const CHARGE_CODES = [
  ['OFR', 'Ocean freight', 'freight', 'per_container', ['ocean freight', 'sea freight', 'o/f', 'freight', 'basic freight', 'base rate']],
  ['AFR', 'Air freight', 'freight', 'per_kg', ['air freight', 'a/f', 'airfreight', 'weight charge']],
  ['BAF', 'Bunker adjustment', 'freight', 'per_container', ['baf', 'bunker', 'bunker surcharge', 'fuel surcharge sea', 'eba', 'lss', 'low sulphur', 'ets']],
  ['PSS', 'Peak season surcharge', 'freight', 'per_container', ['pss', 'peak season', 'gri', 'general rate increase']],
  ['CAF', 'Currency adjustment', 'freight', 'per_container', ['caf', 'currency adjustment']],
  ['FSC', 'Fuel surcharge (air)', 'freight', 'per_kg', ['fsc', 'myc', 'fuel surcharge']],
  ['SSC', 'Security surcharge (air)', 'freight', 'per_kg', ['ssc', 'security surcharge', 'xray', 'x-ray']],
  ['OTHC', 'Origin THC', 'origin_charges', 'per_container', ['othc', 'origin thc', 'thc origin', 'terminal handling origin', 'thc']],
  ['DTHC', 'Destination THC', 'destination_charges', 'per_container', ['dthc', 'destination thc', 'thc destination', 'terminal handling destination']],
  ['DOC', 'Documentation', 'origin_charges', 'per_bl', ['documentation', 'doc fee', 'docs', 'bl fee', 'b/l fee', 'awb fee']],
  ['SEAL', 'Seal fee', 'origin_charges', 'per_container', ['seal']],
  ['VGM', 'VGM / weighment', 'origin_charges', 'per_container', ['vgm', 'weighment']],
  ['CFS', 'CFS / warehouse handling', 'origin_charges', 'per_wm', ['cfs', 'cfs charges', 'warehouse', 'handling']],
  ['DO', 'Delivery order', 'destination_charges', 'per_bl', ['do', 'delivery order', 'd/o']],
  ['CHA', 'Customs agency fee', 'export_customs', 'per_declaration', ['cha', 'clearing charges', 'customs clearance', 'agency fee', 'brokerage', 'customs brokerage', 'tdec']],
  ['EXAM', 'Customs examination', 'export_customs', 'per_container', ['examination', 'exam', 'inspection', 'scanning']],
  ['PERMIT', 'Permits / certificates', 'export_customs', 'per_shipment', ['permit', 'coo', 'certificate of origin', 'phyto', 'fumigation']],
  ['TRUCK', 'Trucking', 'pickup', 'per_trip', ['trucking', 'transport', 'haulage', 'cartage', 'pickup', 'delivery', 'drayage', 'inland']],
  ['TOLL', 'Toll / escort', 'pickup', 'per_trip', ['toll', 'escort']],
  ['DET', 'Detention / waiting', 'pickup', 'per_trip', ['detention', 'waiting']],
  ['INS', 'Insurance', 'freight', 'per_shipment', ['insurance']],
  ['OTHER', 'Other charge', 'freight', 'per_shipment', []],
].map(([code, name, leg, basis, synonyms]) => ({ code, name, leg, basis, synonyms }));

export const chargeByCode = (code) => CHARGE_CODES.find((c) => c.code === code);

/** Map free-text charge name to a standard charge code. */
export function normaliseCharge(text = '', leg) {
  const t = String(text).toLowerCase().trim();
  if (!t) return 'OTHER';
  const exact = CHARGE_CODES.find((c) => c.code.toLowerCase() === t);
  if (exact) return exact.code;
  let best = null;
  let bestLen = 0;
  for (const c of CHARGE_CODES) {
    for (const s of c.synonyms) {
      if (t.includes(s) && s.length > bestLen) {
        // prefer leg-consistent matches for ambiguous words like "thc"
        if (s === 'thc' && leg === 'destination_charges') { best = 'DTHC'; bestLen = s.length; continue; }
        best = c.code;
        bestLen = s.length;
      }
    }
  }
  return best || 'OTHER';
}

export function normaliseBasis(text = '') {
  const t = String(text).toLowerCase();
  if (BASIS_CODES.includes(t)) return t;
  if (/20/.test(t) && /(ft|'|gp|dv|cont|box)/.test(t)) return 'per_20';
  if (/40/.test(t) && /(ft|'|hc|gp|dv|cont|box)/.test(t)) return 'per_40';
  if (/(cont|box|teu|unit|cntr|ctr)/.test(t)) return 'per_container';
  if (/(w\/m|wm|revenue ton|rt\b)/.test(t)) return 'per_wm';
  if (/cbm|m3/.test(t)) return 'per_cbm';
  if (/kg|kilo/.test(t)) return 'per_kg';
  if (/(bl|b\/l|awb|hbl|mbl)/.test(t)) return 'per_bl';
  if (/(declaration|shipping bill|bill of entry|\bsb\b|\bbe\b|tdec)/.test(t)) return 'per_declaration';
  if (/(trip|truck|trailer|vehicle)/.test(t)) return 'per_trip';
  return 'per_shipment';
}

export const CONTAINER_TYPES = ['20GP', '40GP', '40HC', '20RF', '40RF', '20OT', '40OT', '20FR', '40FR', '45HC'];
export const MODES = [
  { code: 'FCL', name: 'Sea FCL' },
  { code: 'LCL', name: 'Sea LCL' },
  { code: 'AIR', name: 'Air' },
];
export const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];
export const CURRENCIES = ['INR', 'USD', 'HKD', 'EUR', 'CNY', 'SGD', 'AED', 'GBP'];
