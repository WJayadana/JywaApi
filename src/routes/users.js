const express = require('express');
const { randomUUID } = require('node:crypto');

const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { applyBalance } = require('../balance');
const { logAuthEvent, EVENTS } = require('../services/auth-log');
const { validateIpList } = require('../services/ip-whitelist');
const {
  validateWebhookUrl,
  generateSecret: generateWebhookSecret,
} = require('../services/webhook-reseller');
const {
  PUBLIC_USER_COLUMNS,
  serializeUser,
  normalizeUsername,
  normalizeEmail,
  normalizePhone,
  isValidUsername,
  isValidEmail,
  isValidPhone,
  parsePositiveInteger,
  parsePagination,
  assertOneOf,
  roles,
  statuses,
  mutationTypes,
  mutationDirections,
} = require('../user-utils');

const router = express.Router();
const ownerOnly = requireRole('owner');

function uniqueConstraint(error) {
  return error && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function getUser(id) {
  return db.prepare(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`).get(id);
}

function getMutations(userId, query) {
  const { page, limit, offset } = parsePagination(query);
  const type = typeof query.type === 'string' ? query.type : null;
  if (type && !mutationTypes.includes(type)) {
    return { error: `type must be one of: ${mutationTypes.join(', ')}` };
  }

  const where = type ? 'WHERE user_id = ? AND type = ?' : 'WHERE user_id = ?';
  const params = type ? [userId, type] : [userId];
  const total = db.prepare(`SELECT COUNT(*) AS count FROM mutations ${where}`).get(...params).count;
  const mutations = db.prepare(
    `SELECT id, user_id, type, direction, amount, balance_before,
            balance_after, note, ref_id, created_at
       FROM mutations ${where}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return {
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
    mutations,
  };
}

function getAuthLogs(userId, query) {
  const { page, limit, offset } = parsePagination(query);
  const event = typeof query.event === 'string' ? query.event : null;
  if (event && !EVENTS.includes(event)) {
    return { error: `event must be one of: ${EVENTS.join(', ')}` };
  }

  const where = event ? 'WHERE user_id = ? AND event = ?' : 'WHERE user_id = ?';
  const params = event ? [userId, event] : [userId];
  const total = db.prepare(`SELECT COUNT(*) AS count FROM auth_logs ${where}`).get(...params).count;
  const logs = db.prepare(
    `SELECT id, event, ip, user_agent, created_at
       FROM auth_logs ${where}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return { page, limit, total, pages: Math.ceil(total / limit), logs };
}

router.use(authenticate);

router.get('/me', (req, res) => {
  res.json({ user: serializeUser(req.user) });
});

router.put('/me', (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = [];
    const values = [];

    if (body.username !== undefined) {
      const username = normalizeUsername(body.username);
      if (!isValidUsername(username)) {
        return res.status(400).json({ error: 'ValidationError', message: 'username is invalid' });
      }
      updates.push('username = ?');
      values.push(username);
    }
    if (body.email !== undefined) {
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'ValidationError', message: 'email is invalid' });
      }
      updates.push('email = ?');
      values.push(email);
    }
    if (body.phone !== undefined) {
      const phone = normalizePhone(body.phone);
      if (!isValidPhone(phone)) {
        return res.status(400).json({ error: 'ValidationError', message: 'phone is invalid' });
      }
      updates.push('phone = ?');
      values.push(phone);
    }
    if (!updates.length) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'provide at least one of username, email, or phone',
      });
    }

    updates.push("updated_at = datetime('now')");
    values.push(req.user.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return res.json({ user: getUser(req.user.id) });
  } catch (error) {
    if (uniqueConstraint(error)) {
      return res.status(409).json({ error: 'Conflict', message: 'username or email is already in use' });
    }
    return next(error);
  }
});

router.get('/me/mutations', (req, res) => {
  const result = getMutations(req.user.id, req.query);
  if (result.error) return res.status(400).json({ error: 'ValidationError', message: result.error });
  res.json(result);
});

// GET /api/users/me/activity?event=&page=&limit=
// User's own auth audit trail: logins (success/failed), API key changes.
router.get('/me/activity', (req, res) => {
  const result = getAuthLogs(req.user.id, req.query);
  if (result.error) return res.status(400).json({ error: 'ValidationError', message: result.error });
  res.json(result);
});

/** Generate a fresh API key for the caller. Any existing key is replaced. */
function generateApiKey() {
  return 'jywa_live_' + randomUUID().replace(/-/g, '');
}

router.post('/me/api-key', (req, res) => {
  const apiKey = generateApiKey();
  db.prepare("UPDATE users SET api_key = ?, updated_at = datetime('now') WHERE id = ?")
    .run(apiKey, req.user.id);
  logAuthEvent(req.user.id, 'api_key_generated', req);
  res.json({ api_key: apiKey });
});

router.delete('/me/api-key', (req, res) => {
  db.prepare('UPDATE users SET api_key = NULL, updated_at = datetime(\'now\') WHERE id = ?')
    .run(req.user.id);
  logAuthEvent(req.user.id, 'api_key_revoked', req);
  res.json({ revoked: true });
});

// ─── API key IP whitelist (self-service) ───────────────────────────
// Empty list = allow all IPs (default). Requests from other IPs get 403.

router.get('/me/api-key/ips', (req, res) => {
  const row = db.prepare('SELECT api_key_ips FROM users WHERE id = ?').get(req.user.id);
  let ips = [];
  if (row && row.api_key_ips) {
    try { ips = JSON.parse(row.api_key_ips) || []; } catch { ips = []; }
  }
  res.json({ ips });
});

router.put('/me/api-key/ips', (req, res) => {
  const body = req.body || {};
  const result = validateIpList(body.ips);
  if (!result.ok) {
    return res.status(400).json({ error: 'ValidationError', message: result.error });
  }
  const stored = result.ips.length ? JSON.stringify(result.ips) : null;
  db.prepare("UPDATE users SET api_key_ips = ?, updated_at = datetime('now') WHERE id = ?")
    .run(stored, req.user.id);
  res.json({ ips: result.ips });
});

// ─── Reseller webhook (self-service) ────────────────────────────────
// Owner can register a single endpoint to receive `transaction.update` events.
// Set → generates secret (returned once). Get → returns URL only.
// Test ping → POST fires a `ping` event. Delete → no more deliveries.

router.get('/me/webhook', (req, res) => {
  const row = db.prepare('SELECT webhook_url FROM users WHERE id = ?').get(req.user.id);
  res.json({ url: row && row.webhook_url ? row.webhook_url : null });
});

router.put('/me/webhook', (req, res) => {
  const body = req.body || {};
  const validation = validateWebhookUrl(body.url);
  if (!validation.ok) {
    return res.status(400).json({ error: 'ValidationError', message: validation.error });
  }
  const url = validation.url;
  const existing = db.prepare(
    'SELECT webhook_secret FROM users WHERE id = ?'
  ).get(req.user.id);
  const secret = existing && existing.webhook_secret ? existing.webhook_secret : generateWebhookSecret();
  db.prepare(
    "UPDATE users SET webhook_url = ?, webhook_secret = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(url, secret, req.user.id);
  res.json({ url, webhook_secret: secret });
});

router.post('/me/webhook/test', async (req, res) => {
  const { dispatch } = require('../services/webhook-reseller');
  dispatch(req.user.id, 'ping', { message: 'test ping from jywa-api' });
  res.json({ sent: true });
});

router.delete('/me/webhook', (req, res) => {
  db.prepare(
    "UPDATE users SET webhook_url = NULL, webhook_secret = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(req.user.id);
  res.json({ deleted: true });
});

router.get('/', ownerOnly, (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const conditions = [];
  const params = [];

  if (req.query.role !== undefined) {
    const roleError = assertOneOf(req.query.role, roles, 'role');
    if (roleError) return res.status(400).json({ error: 'ValidationError', message: roleError });
    conditions.push('role = ?');
    params.push(req.query.role);
  }
  if (req.query.status !== undefined) {
    const statusError = assertOneOf(req.query.status, statuses, 'status');
    if (statusError) return res.status(400).json({ error: 'ValidationError', message: statusError });
    conditions.push('status = ?');
    params.push(req.query.status);
  }
  if (req.query.search) {
    const search = `%${String(req.query.search).trim()}%`;
    conditions.push('(username LIKE ? OR email LIKE ? OR phone LIKE ?)');
    params.push(search, search, search);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS count FROM users ${where}`).get(...params).count;
  const users = db.prepare(
    `SELECT ${PUBLIC_USER_COLUMNS} FROM users ${where}
     ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
    users: users.map(serializeUser),
  });
});

router.get('/:id', ownerOnly, (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'NotFound', message: 'user not found' });
  res.json({ user: serializeUser(user) });
});

router.put('/:id', ownerOnly, (req, res, next) => {
  try {
    const target = getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'NotFound', message: 'user not found' });

    const body = req.body || {};
    const updates = [];
    const values = [];
    const username = body.username === undefined ? undefined : normalizeUsername(body.username);
    const email = body.email === undefined ? undefined : normalizeEmail(body.email);
    const phone = body.phone === undefined ? undefined : normalizePhone(body.phone);

    if (username !== undefined) {
      if (!isValidUsername(username)) return res.status(400).json({ error: 'ValidationError', message: 'username is invalid' });
      updates.push('username = ?'); values.push(username);
    }
    if (email !== undefined) {
      if (!isValidEmail(email)) return res.status(400).json({ error: 'ValidationError', message: 'email is invalid' });
      updates.push('email = ?'); values.push(email);
    }
    if (phone !== undefined) {
      if (!isValidPhone(phone)) return res.status(400).json({ error: 'ValidationError', message: 'phone is invalid' });
      updates.push('phone = ?'); values.push(phone);
    }
    if (body.role !== undefined) {
      const roleError = assertOneOf(body.role, roles, 'role');
      if (roleError) return res.status(400).json({ error: 'ValidationError', message: roleError });
      updates.push('role = ?'); values.push(body.role);
    }
    if (body.status !== undefined) {
      const statusError = assertOneOf(body.status, statuses, 'status');
      if (statusError) return res.status(400).json({ error: 'ValidationError', message: statusError });
      updates.push('status = ?'); values.push(body.status);
    }
    if (req.params.id === req.user.id &&
        ((body.role !== undefined && body.role !== 'owner') ||
         (body.status !== undefined && body.status !== 'active'))) {
      return res.status(400).json({ error: 'ValidationError', message: 'owner cannot demote or deactivate itself' });
    }
    if (!updates.length) return res.status(400).json({ error: 'ValidationError', message: 'no editable fields provided' });

    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json({ user: getUser(req.params.id) });
  } catch (error) {
    if (uniqueConstraint(error)) {
      return res.status(409).json({ error: 'Conflict', message: 'username or email is already in use' });
    }
    return next(error);
  }
});

router.delete('/:id', ownerOnly, (req, res, next) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'ValidationError', message: 'owner cannot ban itself' });
    }
    const target = getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'NotFound', message: 'user not found' });
    db.prepare("UPDATE users SET status = 'banned', updated_at = datetime('now') WHERE id = ?")
      .run(req.params.id);
    res.json({ message: 'user banned', user: getUser(req.params.id) });
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/balance', ownerOnly, (req, res, next) => {
  try {
    const target = getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'NotFound', message: 'user not found' });

    const body = req.body || {};
    const typeError = assertOneOf(body.type, mutationTypes, 'type');
    const directionError = assertOneOf(body.direction, mutationDirections, 'direction');
    const amount = parsePositiveInteger(body.amount);
    if (typeError || directionError || !amount) {
      return res.status(400).json({
        error: 'ValidationError',
        message: typeError || directionError || 'amount must be a positive integer in Rupiah',
      });
    }

    const result = applyBalance(req.params.id, {
      type: body.type,
      direction: body.direction,
      amount,
      note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null,
      refId: typeof body.ref_id === 'string' ? body.ref_id.trim().slice(0, 100) : null,
    });

    res.status(201).json({
      user: getUser(req.params.id),
      mutation: result,
    });
  } catch (error) {
    if (error.message === 'insufficient balance') {
      return res.status(409).json({ error: 'Conflict', message: error.message });
    }
    if (error.message === 'user not found') {
      return res.status(404).json({ error: 'NotFound', message: error.message });
    }
    if (error.message.startsWith('amount ') || error.message.startsWith('direction ')) {
      return res.status(400).json({ error: 'ValidationError', message: error.message });
    }
    return next(error);
  }
});

router.get('/:id/mutations', ownerOnly, (req, res) => {
  if (!getUser(req.params.id)) return res.status(404).json({ error: 'NotFound', message: 'user not found' });
  const result = getMutations(req.params.id, req.query);
  if (result.error) return res.status(400).json({ error: 'ValidationError', message: result.error });
  res.json(result);
});

module.exports = router;
