const express = require('express');
const { randomUUID } = require('node:crypto');

const db = require('../db');
const { applyBalance } = require('../balance');
const { apiKeyAuth } = require('../middleware/api-key');
const pricelist = require('../services/pricelist');
const Digiflazz = require('../providers/digiflazz');
const { DigiflazzError } = require('../providers/digiflazz');
const config = require('../config');

const router = express.Router();

function client() {
  return new Digiflazz(
    config.digiflazz.username,
    config.digiflazz.apiKey,
    config.digiflazz.webhookSecret
  );
}

function publicTransaction(row) {
  if (!row) return null;
  return {
    id: row.id,
    ref_id: row.ref_id,
    sku: row.sku,
    customer_no: row.customer_no,
    harga: row.harga,
    status: row.status,
    ...(row.sn ? { sn: row.sn } : {}),
    ...(row.provider_rc ? { provider_rc: row.provider_rc } : {}),
    ...(row.provider_msg ? { message: row.provider_msg } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getTransaction(userId, refId) {
  return db.prepare(
    `SELECT id, user_id, ref_id, sku, customer_no, harga, status, sn,
            provider_rc, provider_msg, created_at, updated_at
       FROM transactions WHERE user_id = ? AND ref_id = ?`
  ).get(userId, refId);
}

function findProduct(sku, role) {
  const products = pricelist.readFromCache({ cmd: 'prepaid', status: true });
  const product = products.find((item) => item.buyer_sku_code === sku);
  if (!product) return null;
  const harga = Number(product.harga[role]) || 0;
  return { sku: product.buyer_sku_code, harga, harga_modal: Number(product.harga_modal) || 0 };
}

function providerResult(data) {
  const payload = data && data.data && typeof data.data === 'object' ? data.data : data;
  return payload && typeof payload === 'object' ? payload : {};
}

function providerCode(data) {
  const payload = providerResult(data);
  return payload.rc === undefined || payload.rc === null ? null : String(payload.rc);
}

function providerStatus(data) {
  const payload = providerResult(data);
  return String(payload.status || '').toLowerCase();
}

function providerSuccess(data) {
  const rc = providerCode(data);
  const status = providerStatus(data);
  return rc === '00' || status === 'sukses' || status === 'success';
}

function providerSerial(data) {
  const payload = providerResult(data);
  return payload.sn || payload.serial_number || null;
}

function providerMessage(data) {
  const payload = providerResult(data);
  return payload.message || payload.msg || null;
}

function updateTransaction(id, fields) {
  const assignments = Object.keys(fields).map((key) => `${key} = ?`);
  db.prepare(
    `UPDATE transactions SET ${assignments.join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).run(...Object.values(fields), id);
}

router.use(apiKeyAuth);

// GET /api/v1/profile
router.get('/profile', (req, res) => {
  const user = db.prepare(
    'SELECT username, email, phone, role, balance, status, created_at, updated_at FROM users WHERE id = ?'
  ).get(req.user.id);
  res.json(user);
});

// GET /api/v1/products?search=&category=&status=true
// Always returns the caller's own role price as a single number.
router.get('/products', (req, res) => {
  const products = pricelist.readFromCache({
    cmd: req.query.cmd === 'pasca' ? 'pasca' : 'prepaid',
    role: req.user.role,
    category: typeof req.query.category === 'string' ? req.query.category : undefined,
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
    // Public API only exposes products enabled for both buyer and seller.
    status: req.query.status === undefined ? true : req.query.status === 'true',
  }).map(({ price: _price, harga_modal: _modal, ...product }) => product);

  res.json({
    products,
    role: req.user.role,
    source: 'cache',
    last_updated: pricelist.lastUpdated(req.query.cmd === 'pasca' ? 'pasca' : 'prepaid')
      ? new Date(pricelist.lastUpdated(req.query.cmd === 'pasca' ? 'pasca' : 'prepaid')).toISOString()
      : null,
  });
});

// POST /api/v1/transactions
router.post('/transactions', async (req, res, next) => {
  const { sku, customer_no: customerNo, ref_id: refId } = req.body || {};
  if (!sku || typeof sku !== 'string') {
    return res.status(400).json({ error: 'ValidationError', message: 'sku is required' });
  }
  if (!customerNo || typeof customerNo !== 'string') {
    return res.status(400).json({ error: 'ValidationError', message: 'customer_no is required' });
  }
  if (!refId || typeof refId !== 'string') {
    return res.status(400).json({ error: 'ValidationError', message: 'ref_id is required' });
  }
  if (refId.length > 100) {
    return res.status(400).json({ error: 'ValidationError', message: 'ref_id must be at most 100 characters' });
  }

  // Idempotency is scoped per user. Same ref_id always returns prior result.
  const existing = getTransaction(req.user.id, refId);
  if (existing) {
    return res.status(200).json(publicTransaction(existing));
  }

  const product = findProduct(sku, req.user.role);
  if (!product) {
    return res.status(404).json({ error: 'NotFound', message: 'product not found or inactive' });
  }
  const harga = product.harga;
  const hargaModal = product.harga_modal;
  if (harga <= 0) {
    return res.status(422).json({ error: 'ValidationError', message: 'product has no valid price' });
  }

  const transactionId = randomUUID();
  try {
    // Atomic: debit + pembelian mutation + pending transaction in one SQLite transaction.
    db.transaction(() => {
      const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
      if (!fresh || fresh.balance < harga) {
        const error = new Error('insufficient balance');
        error.code = 'INSUFFICIENT_BALANCE';
        throw error;
      }
      applyBalance(req.user.id, {
        type: 'pembelian',
        direction: '-',
        amount: harga,
        note: `Pembelian ${sku}`,
        refId,
      });
      db.prepare(
        `INSERT INTO transactions
         (id, user_id, ref_id, sku, customer_no, harga, harga_modal, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
      ).run(transactionId, req.user.id, refId, sku, customerNo, harga, hargaModal);
    })();
  } catch (error) {
    if (error.code === 'INSUFFICIENT_BALANCE') {
      return res.status(402).json({ error: 'PaymentRequired', message: 'insufficient balance' });
    }
    // A concurrent same-ref request can win the unique constraint; return its result.
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(200).json(publicTransaction(getTransaction(req.user.id, refId)));
    }
    return next(error);
  }

  try {
    const upstream = await client().transaksi(sku, customerNo, refId);
    const payload = providerResult(upstream);
    const success = providerSuccess(upstream);
    const rc = providerCode(upstream);
    const message = providerMessage(upstream);
    const serial = providerSerial(upstream);

    if (success) {
      updateTransaction(transactionId, {
        status: 'success',
        sn: serial,
        provider_rc: rc,
        provider_msg: message,
      });
      return res.status(201).json(publicTransaction(getTransaction(req.user.id, refId)));
    }

    // Upstream declined: refund the exact debit and mark transaction failed.
    db.transaction(() => {
      applyBalance(req.user.id, {
        type: 'refund',
        direction: '+',
        amount: harga,
        note: `Refund transaksi ${refId}`,
        refId,
      });
      updateTransaction(transactionId, {
        status: 'failed',
        provider_rc: rc,
        provider_msg: message || 'transaction failed',
      });
    })();
    return res.status(502).json(publicTransaction(getTransaction(req.user.id, refId)));
  } catch (error) {
    // A transport/provider exception is also refunded; the transaction remains auditable.
    try {
      db.transaction(() => {
        applyBalance(req.user.id, {
          type: 'refund',
          direction: '+',
          amount: harga,
          note: `Refund transaksi ${refId}`,
          refId,
        });
        updateTransaction(transactionId, {
          status: 'failed',
          provider_msg: error.message || 'provider request failed',
        });
      })();
    } catch (refundError) {
      return next(refundError);
    }
    if (error instanceof DigiflazzError) {
      return res.status(502).json(publicTransaction(getTransaction(req.user.id, refId)));
    }
    return next(error);
  }
});

// GET /api/v1/transactions
router.get('/transactions', (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '20', 10) || 20));
  const offset = (page - 1) * limit;
  const total = db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?').get(req.user.id).count;
  const rows = db.prepare(
    `SELECT id, user_id, ref_id, sku, customer_no, harga, status, sn,
            provider_rc, provider_msg, created_at, updated_at
       FROM transactions WHERE user_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
  ).all(req.user.id, limit, offset);
  res.json({ page, limit, total, pages: Math.ceil(total / limit), transactions: rows.map(publicTransaction) });
});

// GET /api/v1/transactions/:ref_id
router.get('/transactions/:ref_id', (req, res) => {
  const row = getTransaction(req.user.id, req.params.ref_id);
  if (!row) return res.status(404).json({ error: 'NotFound', message: 'transaction not found' });
  res.json(publicTransaction(row));
});

module.exports = router;
