// Per-company caches of what the agent has learnt (reply habits, prices, win rates, punctuality).
// Each cache registers here so that new history (an import) can clear them all at once.
import { currentTenant } from '../db.js';

const caches = new Set();

/** Register a Map keyed by tenant id; returns it. */
export function learningCache(map = new Map()) {
  caches.add(map);
  return map;
}

/** Forget what was learnt for the current company, so the next request relearns from the data. */
export function clearLearning() {
  const id = currentTenant()?.id;
  for (const m of caches) m.delete(id);
}
