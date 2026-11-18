// Shared reference data (legs, charge codes, bases...) loaded once from the server engine.
import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api.js';

const MetaCtx = createContext(null);

export function MetaProvider({ children }) {
  const [meta, setMeta] = useState(null);
  useEffect(() => { api.get('/meta').then(setMeta).catch(() => {}); }, []);
  if (!meta) return null;
  const helpers = {
    ...meta,
    legName: (c) => meta.legs.find((l) => l.code === c)?.name || c,
    basisName: (c) => meta.bases.find((b) => b.code === c)?.name || c,
    chargeName: (c) => meta.charges.find((x) => x.code === c)?.name || c,
    legOptions: meta.legs.map((l) => ({ value: l.code, label: l.name })),
    basisOptions: meta.bases.map((b) => ({ value: b.code, label: b.name })),
    chargeOptions: meta.charges.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` })),
  };
  return <MetaCtx.Provider value={helpers}>{children}</MetaCtx.Provider>;
}

export const useMeta = () => useContext(MetaCtx);
