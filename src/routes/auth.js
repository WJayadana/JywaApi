const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const db = require('../db');
const config = require('../config');
const {
  PUBLIC_USER_COLUMNS,
  serializeUser,
  normalizeUsername,
  normalizeEmail,
  normalizePhone,
  validateUserFields,
} = require('../user-utils');

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

    return res.status(201).json({ user: serializeUser(user), token: issueToken(userId) });
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

    return res.json({
      user: serializeUser(user),
      token: issueToken(user.id),
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
