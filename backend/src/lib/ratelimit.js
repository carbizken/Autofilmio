/**
 * In-memory sliding-window rate limiter.
 * Zero dependencies. Suitable for a single Render instance;
 * swap the Map for Redis when scaling horizontally.
 */

const buckets = new Map();

// Sweep expired entries every 5 minutes so the Map doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > bucket.windowMs * 2) buckets.delete(key);
  }
}, 300_000).unref?.();

/**
 * Create a rate-limit middleware.
 * @param {object} opts
 * @param {number} opts.windowMs - window size in ms (default 60s)
 * @param {number} opts.max      - max requests per window (default 60)
 * @param {string} opts.keyBy    - 'ip' (default) or a function(req) => string
 */
export function rateLimit({ windowMs = 60_000, max = 60, keyBy = 'ip' } = {}) {
  return (req, res, next) => {
    const id = typeof keyBy === 'function'
      ? keyBy(req)
      : (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown');

    const key = `${req.baseUrl || req.path}:${id}`;
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { windowStart: now, count: 0, windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Slow down.' });
    }

    next();
  };
}
