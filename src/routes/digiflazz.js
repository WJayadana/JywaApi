const express = require('express');

const { authenticate, requireRole } = require('../middleware/auth');
const Digiflazz = require('../providers/digiflazz');
const { DigiflazzError } = require('../providers/digiflazz');
const config = require('../config');
const pricelist = require('../services/pricelist');

const router = express.Router();
const ownerOnly = requireRole('owner');

function client() {
  return new Digiflazz(
    config.digiflazz.username,
    config.digiflazz.apiKey,
    config.digiflazz.webhookSecret
  );
}

function handleError(error, res, next) {
  if (error instanceof DigiflazzError) {
    return res.status(502).json({
      error: 'DigiflazzError',
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
  next(error);
}

// ─── Public (any authenticated user) ───────────────────────────────
router.use(authenticate);

// GET /api/digiflazz/harga?cmd=prepaid|pasca&category=&search=&status=&role=bronze|silver|gold|reseller|owner
// Reads from JSON cache (no upstream). Price is automatically marked up per caller's role.
// Without `role` query, returns the full per-role price map so the frontend can render multiple tiers.
router.get('/harga', async (req, res, next) => {
  const cmd = req.query.cmd || 'prepaid';
  if (cmd !== 'prepaid' && cmd !== 'pasca') {
    return res.status(400).json({ error: 'ValidationError', message: 'cmd must be "prepaid" or "pasca"' });
  }
  const requestedRole = req.query.role;
  if (requestedRole && !['owner', 'bronze', 'silver', 'gold', 'reseller'].includes(requestedRole)) {
    return res.status(400).json({ error: 'ValidationError', message: 'role must be one of owner/bronze/silver/gold/reseller' });
  }
  const callerRole = req.user.role;
  const effectiveRole = requestedRole || callerRole;
  try {
    const products = pricelist.readFromCache({
      cmd,
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      status: req.query.status === undefined ? undefined : req.query.status === 'true',
      role: effectiveRole,
    });
    return res.json({
      products,
      role: callerRole,
      last_updated: pricelist.lastUpdated() ? new Date(pricelist.lastUpdated()).toISOString() : null,
      source: 'cache',
    });
  } catch (error) { handleError(error, res, next); }
});

// ─── Owner-only routes ─────────────────────────────────────────────

router.get('/saldo', ownerOnly, async (req, res, next) => {
  try {
    const data = await client().cekSaldo();
    res.json(data);
  } catch (error) { handleError(error, res, next); }
});

// POST /api/digiflazz/harga/refresh  { cmd?: prepaid|pasca }
// Owner-triggered upstream sync. Rate limited by Digiflazz (5 min), we default to prepaid.
router.post('/harga/refresh', ownerOnly, async (req, res, next) => {
  const cmd = req.body?.cmd || 'prepaid';
  if (cmd !== 'prepaid' && cmd !== 'pasca') {
    return res.status(400).json({ error: 'ValidationError', message: 'cmd must be "prepaid" or "pasca"' });
  }
  try {
    const count = await pricelist.fetchAndStore(cmd);
    return res.json({
      synced: true,
      cmd,
      count,
      last_updated: pricelist.lastUpdated() ? new Date(pricelist.lastUpdated()).toISOString() : null,
    });
  } catch (error) { handleError(error, res, next); }
});

// POST /api/digiflazz/deposit  { amount, bank, owner_name }
router.post('/deposit', ownerOnly, async (req, res, next) => {
  const { amount, bank, owner_name } = req.body || {};
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'ValidationError', message: 'amount must be a positive integer' });
  }
  if (!bank || typeof bank !== 'string') {
    return res.status(400).json({ error: 'ValidationError', message: 'bank is required' });
  }
  if (!owner_name || typeof owner_name !== 'string') {
    return res.status(400).json({ error: 'ValidationError', message: 'owner_name is required' });
  }
  try {
    const data = await client().deposit(amount, bank, owner_name);
    res.json(data);
  } catch (error) { handleError(error, res, next); }
});

// POST /api/digiflazz/transaksi  { sku, customer_no, ref_id, commands?, testing? }
router.post('/transaksi', ownerOnly, async (req, res, next) => {
  const { sku, customer_no, ref_id, commands, testing } = req.body || {};
  if (!sku || typeof sku !== 'string') {
    return res.status(400).json({ error: 'ValidationError', message: 'sku is required' });
  }
  if (!customer_no || typeof customer_no !== 'string') {
    return res.status(400).json({ error: 'ValidationError', message: 'customer_no is required' });
  }
  if (!ref_id || typeof ref_id !== 'string') {
    return res.status(400).json({ error: 'ValidationError', message: 'ref_id is required' });
  }
  const validCommands = ['inq-pasca', 'pay-pasca', 'status-pasca'];
  if (commands && !validCommands.includes(commands)) {
    return res.status(400).json({ error: 'ValidationError', message: 'commands must be one of: inq-pasca, pay-pasca, status-pasca' });
  }
  try {
    const data = await client().transaksi(sku, customer_no, ref_id, commands || null, testing || null);
    res.json(data);
  } catch (error) { handleError(error, res, next); }
});

module.exports = router;
