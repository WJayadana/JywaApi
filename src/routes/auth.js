const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const db = require('../db');
const config = require('../config');
const { logAuthEvent } = require('../services/auth-log');
const {
  PUBLIC_USER_COLUMNS,
  serializeUser,
  normalizeUsername,
  normalizeEmail,
  normalizePhone,
  validateUserFields,
} = require('../user-utils');
const {
  issueTokens,
  verifyRefreshToken,
  revokeToken,
  revokeAllUserTokens,
  REFRESH_TTL_DAYS,
} = require('../services/refresh-token');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

function issueToken(userId) {
  return jwt.sign({ sub: userId }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

function isUniqueConstraint(error) {
  return error && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

router.post('/register', async (req, res, next) => {
  try {
    const body = req.body || {};
    const username = normalizeUsername(body.username);
    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone);
    const password = body.password;
    const errors = validateUserFields({ username, email, phone, password });

    if (Object.keys(errors).length) {
      return res.status(400).json({ error: 'ValidationError', fields: errors });
    }

    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    const userId = randomUUID();
    db.prepare(
      `INSERT INTO users (id, username, email, phone, password_hash, role)
       VALUES (?, ?, ?, ?, ?, 'bronze')`
    ).run(userId, username, email, phone, passwordHash);

    const user = db
      .prepare(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`)
      .get(userId);

    return res.status(201).json({
      user: serializeUser(user),
      token: issueToken(userId),
      access_token: issueToken(userId), // same value, for new clients
      refresh_token: null,
      expires_in: 86400,
    });
  } catch (error) {
    if (isUniqueConstraint(error)) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'username or email is already registered',
      });
    }
    return next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const body = req.body || {};
    const identifier = typeof body.identifier === 'string'
      ? body.identifier.trim().toLowerCase()
      : (typeof body.username === 'string' ? body.username.trim().toLowerCase() : '');
    const password = body.password;

    if (!identifier || typeof password !== 'string') {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'identifier (or username) and password are required',
      });
    }

    const user = db
      .prepare(`SELECT ${PUBLIC_USER_COLUMNS}, password_hash FROM users
                WHERE username = ? OR email = ? LIMIT 1`)
      .get(identifier, identifier);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      if (user) logAuthEvent(user.id, 'login_failed', req);
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'invalid credentials',
      });
    }
    if (user.status !== 'active') {
      return res.status(403).json({
        error: 'Forbidden',
        message: `Account is ${user.status}`,
      });
    }

    logAuthEvent(user.id, 'login_success', req);
    const tokens = issueTokens(user.id);
    return res.json({
      user: serializeUser(user),
      token: tokens.accessToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: 86400,
      refresh_expires_in: REFRESH_TTL_DAYS * 86400,
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/auth/refresh — exchange refresh token for new access token
router.post('/refresh', async (req, res) => {
  const { refresh_token: rawToken } = req.body || {};
  if (!rawToken || typeof rawToken !== 'string') {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'refresh_token is required',
    });
  }

  // Find token by comparing hash across all active tokens
  const allTokens = db.prepare(
    `SELECT at.id, at.user_id
       FROM auth_tokens at
      WHERE at.revoked_at IS NULL AND at.expires_at > datetime('now')`
  ).all();

  let matchedTokenId = null;
  let matchedUserId = null;
  for (const t of allTokens) {
    const rowData = db.prepare(`SELECT token_hash FROM auth_tokens WHERE id = ?`).get(t.id);
    if (rowData && await bcrypt.compare(rawToken, rowData.token_hash)) {
      matchedTokenId = t.id;
      matchedUserId = t.user_id;
      break;
    }
  }

  if (!matchedTokenId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'invalid or expired refresh token',
    });
  }

  const userRow = db.prepare(
    `SELECT id, username, email, role, status FROM users WHERE id = ?`
  ).get(matchedUserId);

  if (!userRow || userRow.status !== 'active') {
    return res.status(401).json({ error: 'Unauthorized', message: 'account not active' });
  }

  // Rotate: revoke old, issue new
  revokeToken(matchedTokenId);
  const tokens = issueTokens(matchedUserId);
  logAuthEvent(matchedUserId, 'refresh', req);

  return res.json({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_in: 86400,
    refresh_expires_in: REFRESH_TTL_DAYS * 86400,
  });
});

// DELETE /api/auth/refresh — revoke one refresh token
router.delete('/refresh', async (req, res) => {
  const { refresh_token: rawToken } = req.body || {};
  if (!rawToken || typeof rawToken !== 'string') {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'refresh_token is required',
    });
  }
  // bcrypt is already at module level
  const allTokens = db.prepare(
    `SELECT id, token_hash FROM auth_tokens
      WHERE revoked_at IS NULL AND expires_at > datetime('now')`
  ).all();
  let matchedId = null;
  for (const t of allTokens) {
    if (await bcrypt.compare(rawToken, t.token_hash)) { matchedId = t.id; break; }
  }
  if (!matchedId) {
    return res.status(404).json({ error: 'NotFound', message: 'token not found or already revoked' });
  }
  revokeToken(matchedId);
  return res.json({ revoked: true });
});

// DELETE /api/auth/refresh/all — revoke all refresh tokens for caller
router.delete('/refresh/all', authenticate, (req, res) => {
  revokeAllUserTokens(req.user.id);
  return res.json({ revoked: true, message: 'all refresh tokens revoked' });
});

module.exports = router;
