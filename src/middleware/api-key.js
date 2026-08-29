const db = require('../db');

const USER_COLUMNS =
  'id, username, email, phone, role, balance, status, created_at, updated_at';

/**
 * Authenticate an API v1 request by API key (Bearer token = users.api_key).
 * Unlike JWT auth, this resolves the caller directly from the API key column.
 * Attaches req.user with role, balance, status (no password/api_key leak).
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

  req.user = user;
  next();
}

module.exports = { apiKeyAuth, USER_COLUMNS };
