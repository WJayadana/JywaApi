/**
 * POST /api/deposits       — buat QRIS deposit invoice
 * GET  /api/deposits       — list own deposits
 * GET  /api/deposits/:id   — detail satu deposit
 * POST /api/deposits/:id/cancel — batalkan invoice pending
 */

const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const gobiz = require('../services/gobiz-client');

const router = express.Router();

const BASE_URL = process.env.JYWA_BASE_URL || null; // set dynamically per-request
const GOBIZ_WEBHOOK_CALLBACK_URL = process.env.GOBIZ_WEBHOOK_CALLBACK_URL || '';

// ─── POST /api/deposits ────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const { amount } = req.body || {};

    // Validasi
    if (!amount || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 1000) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'amount harus number ≥ 1000',
      });
    }
    if (amount > 10_000_000) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'amount maksimal Rp 10.000.000 per transaksi',
      });
    }

    const user = req.user;
    const depositId = crypto.randomUUID();
    const orderId = `DP-${Date.now()}-${user.id.slice(0, 8)}`;

    // Buat invoice di GoBiz
    let gobizResult;
    try {
      gobizResult = await gobiz.createPayment({
        amount,
        order_id: orderId,
        callback_url: GOBIZ_WEBHOOK_CALLBACK_URL,
        expires_in: 900,
        metadata: { deposit_id: depositId, user_id: user.id },
      });
      console.log('[/api/deposits] gobizResult:', JSON.stringify(gobizResult));
    } catch (fetchErr) {
      console.error('[/api/deposits] GoBiz fetch error:', fetchErr);
      return res.status(502).json({
        error: 'UpstreamError',
        message: 'gagal membuat invoice QRIS',
      });
    }

    if (!gobizResult.ok || !gobizResult.data?.id) {
      return res.status(502).json({
        error: 'UpstreamError',
        message: gobizResult.data?.error?.message || 'gagal membuat invoice QRIS',
      });
    }

    const gData = gobizResult.data;
    const gobizId = gData.id;
    const qrisString = gData.qris_string || '';
    const expectedAmount = gData.expected_amount || amount;

    // Simpan ke DB
    db.prepare(`
      INSERT INTO deposits (id, user_id, amount, expected_amount, gobiz_payment_id, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(depositId, user.id, amount, expectedAmount, gobizId);

    res.status(201).json({
      deposit_id: depositId,
      gobiz_payment_id: gobizId,
      amount,
      expected_amount: expectedAmount,
      qris_string: qrisString,
      // QRIS image bisa di-generate client-side dari qris_string
      status: 'pending',
      expires_in: 900,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/api/deposits]', err);
    res.status(500).json({ error: 'InternalServerError', message: 'internal server error' });
  }
});

// ─── GET /api/deposits ─────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const user = req.user;
    const offset = (Math.max(1, Number(page)) - 1) * Math.min(100, Math.max(1, Number(limit)));

    let where = 'user_id = ?';
    const params = [user.id];

    if (status) {
      where += ' AND status = ?';
      params.push(status);
    }

    const rows = db.prepare(`
      SELECT id, amount, expected_amount, gobiz_payment_id, status,
             paid_at, credited_at, created_at
      FROM deposits
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), offset);

    const { total } = db.prepare(`
      SELECT COUNT(*) as total FROM deposits WHERE ${where}
    `).get(...params);

    res.json({
      deposits: rows.map(r => ({
        ...r,
        amount: r.amount,
        expected_amount: r.expected_amount,
        is_owner: user.role === 'owner',
      })),
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (err) {
    console.error('[/api/deposits GET]', err);
    res.status(500).json({ error: 'InternalServerError', message: 'internal server error' });
  }
});

// ─── GET /api/deposits/:id ─────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const row = db.prepare(`
      SELECT id, user_id, amount, expected_amount, gobiz_payment_id, status,
             paid_at, credited_at, created_at
      FROM deposits WHERE id = ?
    `).get(req.params.id);

    if (!row) return res.status(404).json({ error: 'NotFound', message: 'deposit tidak ditemukan' });

    const user = req.user;
    if (row.user_id !== user.id && user.role !== 'owner') {
      return res.status(403).json({ error: 'Forbidden', message: 'akses ditolak' });
    }

    // Kalau owner, bisa fetch status real dari GoBiz
    if (user.role === 'owner' && row.status === 'pending') {
      let gobizData = null;
      try {
        gobizData = await gobiz.getPayment(row.gobiz_payment_id);
      } catch (_) { /* ignore */ }
      if (gobizData?.qris_string) {
        row.qris_string = gobizData.qris_string;
      }
    }

    res.json(row);
  } catch (err) {
    console.error('[/api/deposits/:id]', err);
    res.status(500).json({ error: 'InternalServerError', message: 'internal server error' });
  }
});

// ─── POST /api/deposits/:id/cancel ─────────────────────────────
router.post('/:id/cancel', authenticate, async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM deposits WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NotFound', message: 'deposit tidak ditemukan' });

    if (row.user_id !== req.user.id && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Forbidden', message: 'akses ditolak' });
    }
    if (row.status !== 'pending') {
      return res.status(409).json({ error: 'Conflict', message: `tidak bisa dibatalkan — status: ${row.status}` });
    }

    // Batalkan di GoBiz
    try {
      await gobiz.cancelPayment(row.gobiz_payment_id);
    } catch (_) { /* cancel tetap lanjut meskipun gagal */ }

    db.prepare(`UPDATE deposits SET status = 'cancelled' WHERE id = ?`).run(row.id);
    res.json({ id: row.id, status: 'cancelled' });
  } catch (err) {
    console.error('[/api/deposits/:id/cancel]', err);
    res.status(500).json({ error: 'InternalServerError', message: 'internal server error' });
  }
});

module.exports = router;
