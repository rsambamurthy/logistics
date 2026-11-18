// SeaRates tracking API: sea (container / BL / booking) and air (AWB). https://docs.searates.com
import { normaliseSeaRatesSea, normaliseSeaRatesAir } from '../../engines/tracking.js';

const base = () => (process.env.SEARATES_BASE_URL || 'https://tracking.searates.com').replace(/\/$/, '');

async function get(path, params) {
  const url = `${base()}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(45000) });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(`SeaRates: HTTP ${res.status}`);
  // errors come back as HTTP 200 with an error in the envelope
  if (json.status && json.status !== 'success' && json.success !== true) throw new Error(`SeaRates: ${json.message || json.status}`);
  if (json.success === false) throw new Error(`SeaRates: ${json.message || json.status_code || 'error'}`);
  return json;
}

export default {
  name: 'SeaRates',
  modes: ['sea', 'air'],
  signup: 'https://www.searates.com/integrations/api-tracking-system/',
  async track({ number, type, mode, key }) {
    if (mode === 'air') return normaliseSeaRatesAir(await get('/air', { api_key: key, number, path: 'true' }));
    const params = { api_key: key, number, sealine: 'auto', route: 'true', ais: 'true' };
    if (type) params.type = type;
    return normaliseSeaRatesSea(await get('/tracking', params));
  },
};
