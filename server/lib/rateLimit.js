// Small in-memory rate limiter (per IP and route). Enough for one app instance.
const hits = new Map();

export function rateLimit({ windowMs = 15 * 60 * 1000, max = 10, key = (req) => `${req.ip}|${req.baseUrl}${req.path}` } = {}) {
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const list = (hits.get(k) || []).filter((t) => t > now - windowMs);
    if (list.length >= max) {
      res.setHeader('Retry-After', Math.ceil((list[0] + windowMs - now) / 1000));
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    list.push(now);
    hits.set(k, list);
    next();
  };
}

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, v] of hits) if (!v.some((t) => t > cutoff)) hits.delete(k);
}, 10 * 60 * 1000).unref();

/**
 * Counts only failed attempts (e.g. wrong passwords for one account from any address).
 * Use: const f = failureLimit(...); route uses f.check, and calls f.fail(req) when the attempt fails.
 */
export function failureLimit({ windowMs = 15 * 60 * 1000, max = 20, key }) {
  const fails = new Map();
  const recent = (k) => (fails.get(k) || []).filter((t) => t > Date.now() - windowMs);
  return {
    check(req, res, next) {
      if (recent(key(req)).length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
      next();
    },
    fail(req) {
      const k = key(req);
      fails.set(k, [...recent(k), Date.now()]);
    },
  };
}
