/**
 * Refresh token lifecycle management.
 * Long-lived token (30 days) stored as a bcrypt hash in auth_tokens.
 * Refresh: POST /api/auth/refresh  { refresh_token }
 * Revoke:  DELETE /api/auth/refresh  { refresh_token }
 * Revoke all: DELETE /api/auth/refresh/all
 */

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const db = require('../db');
const config = require('../config');

// 30-day refresh token lifetime (env override)
const REFRESH_TTL_DAYS  = Number(process.env.REFRESH_TOKEN_TTL_DAYS)  || 30;
const REFRESH_TTL_SEC   = REFRESH_TTL_DAYS * 86400;
const BCRYPT_ROUNDS     = Number(process.env.BCRYPT_ROUNDS)            || 10;

function generateRefreshToken() {
  return 'jywa_rft_' + crypto.randomBytes(24).toString('base64url');
}

function issueTokens(userId) {
  const accessToken = jwt.sign(
    { sub: userId, type: 'access' },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
  const raw = generateRefreshToken();
  const hash = bcrypt.hashSync(raw, BCRYPT_ROUNDS);
  const id   = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SEC * 1000).toISOString();

  db.prepare(
    `INSERT INTO auth_tokens (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, userId, hash, expiresAt);

  return { accessToken, refreshToken: raw, expiresAt };
}

async function verifyRefreshToken(rawToken, userId) {
  if (!rawToken || typeof rawToken !== 'string') return false;
  const rows = db.prepare(
    `SELECT id, token_hash FROM auth_tokens
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')`
  ).all(userId);

  for (const row of rows) {
    const match = await bcrypt.compare(rawToken, row.token_hash);
    if (match) return row.id;
  }
  return null;
}

function revokeToken(tokenId) {
  db.prepare(
    `UPDATE auth_tokens SET revoked_at = datetime('now') WHERE id = ?`
  ).run(tokenId);
}

function revokeAllUserTokens(userId) {
  db.prepare(
    `UPDATE auth_tokens SET revoked_at = datetime('now') WHERE user_id = ?`
  ).run(userId);
}

module.exports = {
  issueTokens,
  verifyRefreshToken,
  revokeToken,
  revokeAllUserTokens,
  REFRESH_TTL_DAYS,
};
