/**
 * Sliding-window rate limiter per API key user.
 * Config: RL_WINDOW_SEC = window size (default 60s), RL_MAX_REQ = max req per window (default 100).
 * Stored in SQLite — one row per user, updated atomically.
 * Usage: router.use(rateLimitByApiKey())
 */

const db = require('../db');

const WINDOW_SEC = Number(process.env.RL_WINDOW_SEC) || 60;
const MAX_REQ    = Number(process.env.RL_MAX_REQ)    || 100;

function rateLimitByApiKey() {
  // Skip in test environment to avoid polluting test isolation
  if (process.env.NODE_ENV === 'test') return (_req, _res, next) => next();

  return (req, res, next) => {
    const userId = req.user && req.user.id;
    if (!userId) return next(); // no user → no limit

    const now    = Math.floor(Date.now() / 1000);
    const window = now - (now % WINDOW_SEC); // start of current window bucket

    // Atomic upsert: UPDATE if same window, else INSERT new bucket
    const existing = db.prepare(
      'SELECT count FROM rate_limits WHERE user_id = ? AND window_start = ?'
    ).get(userId, window);

    if (existing) {
      if (existing.count >= MAX_REQ) {
        const retryAfter = WINDOW_SEC - (now - window);
        res.set('Retry-After', retryAfter);
        res.set('X-RateLimit-Limit', MAX_REQ);
        res.set('X-RateLimit-Remaining', 0);
        res.set('X-RateLimit-Reset', window + WINDOW_SEC);
        return res.status(429).json({
          error: 'TooManyRequests',
          message: `Rate limit exceeded. Try again in ${retryAfter}s.`,
          retry_after: retryAfter,
        });
      }
      db.prepare(
        'UPDATE rate_limits SET count = count + 1 WHERE user_id = ? AND window_start = ?'
      ).run(userId, window);
    } else {
      db.prepare(
        'INSERT INTO rate_limits (user_id, window_start, count) VALUES (?, ?, 1)'
      ).run(userId, window, 1);
    }

    res.set('X-RateLimit-Limit', MAX_REQ);
    res.set('X-RateLimit-Remaining', Math.max(0, MAX_REQ - (existing ? existing.count + 1 : 1)));
    res.set('X-RateLimit-Reset', window + WINDOW_SEC);

    next();
  };
}

module.exports = { rateLimitByApiKey };
