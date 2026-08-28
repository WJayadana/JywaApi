const express = require('express');

const { authenticate, requireRole } = require('../middleware/auth');
const Digiflazz = require('../providers/digiflazz');
const { DigiflazzError } = require('../providers/digiflazz');
const config = require('../config');

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

// ─── Owner-only routes ──────────────────────────────────────────────
router.use(authenticate, ownerOnly);

// GET /api/digiflazz/saldo
router.get('/saldo', async (req, res, next) => {
  try {
    const data = await client().cekSaldo();
    res.json(data);
  } catch (error) { handleError(error, res, next); }
});

// GET /api/digiflazz/harga?cmd=prepaid|pasca
router.get('/harga', async (req, res, next) => {
  const cmd = req.query.cmd || 'prepaid';
  if (cmd !== 'prepaid' && cmd !== 'pasca') {
    return res.status(400).json({ error: 'ValidationError', message: 'cmd must be "prepaid" or "pasca"' });
  }
  try {
    const data = await client().daftarHarga(cmd);
    res.json({ products: Array.isArray(data) ? data : [data] });
  } catch (error) { handleError(error, res, next); }
});

// POST /api/digiflazz/deposit  { amount, bank, owner_name }
router.post('/deposit', async (req, res, next) => {
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
router.post('/transaksi', async (req, res, next) => {
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
