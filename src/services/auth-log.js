const { randomUUID } = require('node:crypto');

const db = require('../db');

const EVENTS = [
  'login_success',
  'login_failed',
  'api_key_generated',
  'api_key_revoked',
  'api_ip_rejected',
];

/**
 * Record an auth-related event for a user's own audit trail.
 * Never throws — logging must not break the actual auth flow.
 *
 * @param {string} userId - target user id
 * @param {string} event  - one of EVENTS
 * @param {object} req    - Express request (for ip + user agent)
 */
function logAuthEvent(userId, event, req) {
  if (!userId || !EVENTS.includes(event)) return;
  try {
    const ip = (req && req.ip) || null;
    const userAgent = req && typeof req.headers?.['user-agent'] === 'string'
      ? req.headers['user-agent'].slice(0, 300)
      : null;
    db.prepare(
      'INSERT INTO auth_logs (id, user_id, event, ip, user_agent) VALUES (?, ?, ?, ?, ?)'
    ).run(randomUUID(), userId, event, ip, userAgent);
  } catch (error) {
    console.error(`[auth-log] failed to record ${event}: ${error.message}`);
  }
}

/** Delete logs older than `days` (retention). Returns number of rows removed. */
function pruneOldLogs(days = 90) {
  const result = db.prepare(
    "DELETE FROM auth_logs WHERE created_at < datetime('now', ?)"
  ).run(`-${days} days`);
  return result.changes;
}

module.exports = { logAuthEvent, pruneOldLogs, EVENTS };
