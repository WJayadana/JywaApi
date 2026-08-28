const jwt = require('jsonwebtoken');
const db = require('../db');
const { jwtSecret } = require('../config');

const USER_COLUMNS =
  'id, username, email, phone, role, balance, status, api_key, created_at, updated_at';

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res
      .status(401)
      .json({ error: 'Unauthorized', message: 'Missing bearer token' });
  }

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret);
  } catch (e) {
    return res
      .status(401)
      .json({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }

  const user = db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .get(payload.sub);

  if (!user) {
    return res
      .status(401)
      .json({ error: 'Unauthorized', message: 'User not found' });
  }
  if (user.status !== 'active') {
    return res
      .status(403)
      .json({ error: 'Forbidden', message: `Account is ${user.status}` });
  }

  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ error: 'Forbidden', message: 'Insufficient role' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole, USER_COLUMNS };
