// Tracking data providers. Each provider: { name, modes, track({ number, type, mode, key }) -> normalised snapshot }.
// Add a provider by adding a file here and an entry below; nothing else changes.
import searates from './searates.js';

export const PROVIDERS = { searates };
export const providerList = () => Object.entries(PROVIDERS).map(([code, p]) => ({ code, name: p.name, modes: p.modes, signup: p.signup }));
export const getProvider = (code) => PROVIDERS[code] || null;
