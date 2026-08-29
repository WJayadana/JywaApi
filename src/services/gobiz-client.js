/**
 * Client for api.jywa.app (GoBiz Payment Gateway).
 * Creates QRIS payment invoices and handles webhook verification.
 */

const crypto = require('node:crypto');

const BASE_URL = process.env.GOBIZ_API_URL || 'https://api.jywa.app';
const API_KEY = process.env.GOBIZ_API_KEY;
const WEBHOOK_SECRET = process.env.GOBIZ_WEBHOOK_SECRET || '';

/**
 * Create a QRIS payment invoice.
 * @param {{ amount: number, order_id: string, callback_url?: string, expires_in?: number, metadata?: object }} opts
 * @returns {Promise<{ ok: boolean, data?: object, error?: string }>}
 */
async function createPayment(opts) {
  if (!API_KEY) throw new Error('GOBIZ_API_KEY is not configured');

  const { amount, order_id, callback_url, expires_in, metadata } = opts;

  const res = await fetch(`${BASE_URL}/v1/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify({
      amount,
      order_id,
      ...(callback_url && { callback_url }),
      ...(expires_in && { expires_in }),
      ...(metadata && { metadata }),
    }),
  });

  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

/**
 * Get payment status by ID.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function getPayment(id) {
  if (!API_KEY) throw new Error('GOBIZ_API_KEY is not configured');

  const res = await fetch(`${BASE_URL}/v1/payments/${encodeURIComponent(id)}`, {
    headers: { 'X-API-Key': API_KEY },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.data ?? null;
}

/**
 * Cancel a pending payment.
 * @param {string} id
 * @returns {Promise<{ ok: boolean, data?: object }>}
 */
async function cancelPayment(id) {
  if (!API_KEY) throw new Error('GOBIZ_API_KEY is not configured');

  const res = await fetch(`${BASE_URL}/v1/payments/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

/**
 * Verify HMAC-SHA256 signature from GoBiz webhook.
 * Header: X-Signature (raw hex, no prefix).
 * @param {string|Buffer} rawBody
 * @param {string} signature  — value of X-Signature header
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET || !signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (_) {
    return false;
  }
}

module.exports = { createPayment, getPayment, cancelPayment, verifyWebhookSignature };
