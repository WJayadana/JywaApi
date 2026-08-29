const db = require('../db');
const { ipMatches } = require('../services/ip-whitelist');
const { logAuthEvent } = require('../services/auth-log');

const USER_COLUMNS =
  'id, username, email, phone, role, balance, status, api_key_ips, created_at, updated_at';

/**
 * Authenticate an API v1 request by API key (Bearer token = users.api_key).
 * Unlike JWT auth, this resolves the caller directly from the API key column.
 * Attaches req.user with role, balance, status (no password/api_key leak).
 *
 * If the user has configured an IP whitelist (api_key_ips), the request IP
 * must match one of the entries; otherwise 403 + auth_log.
 */
function apiKeyAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res
      .status(401)
      .json({ error: 'Unauthorized', message: 'Missing API key' });
  }

  const user = db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE api_key = ?`)
    .get(token);

  if (!user) {
    return res
      .status(401)
      .json({ error: 'Unauthorized', message: 'Invalid API key' });
  }

  if (user.status !== 'active') {
    return res
      .status(403)
      .json({ error: 'Forbidden', message: `Account is ${user.status}` });
  }

  // IP whitelist enforcement (empty/NULL = allow all)
  let whitelist = null;
  if (user.api_key_ips) {
    try { whitelist = JSON.parse(user.api_key_ips); } catch { whitelist = null; }
  }
  if (Array.isArray(whitelist) && whitelist.length > 0 && !ipMatches(req.ip, whitelist)) {
    logAuthEvent(user.id, 'api_ip_rejected', req);
    return res
      .status(403)
      .json({ error: 'Forbidden', message: 'IP not whitelisted' });
  }

  req.user = user;
  next();
}

module.exports = { apiKeyAuth, USER_COLUMNS };
