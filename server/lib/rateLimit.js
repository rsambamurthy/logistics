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
