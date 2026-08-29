const crypto = require('node:crypto');
const db = require('../db');

const MAX_URL_LENGTH = 500;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRY_DELAYS_MS = [5000, 30000, 120000]; // 3 retries: 5s, 30s, 2m

const timeoutMs = Number(process.env.RESELLER_WEBHOOK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
const retryDelays = (process.env.RESELLER_WEBHOOK_RETRY_DELAYS_MS || '')
  .split(',')
  .filter(Boolean)
  .map(Number)
  .filter((value) => Number.isFinite(value) && value >= 0);
const delays = retryDelays.length ? retryDelays : DEFAULT_RETRY_DELAYS_MS;

function isLoopback(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

function validateWebhookUrl(value) {
  if (typeof value !== 'string') return { ok: false, error: 'url is required' };
  const url = value.trim();
  if (!url) return { ok: false, error: 'url is required' };
  if (url.length > MAX_URL_LENGTH) return { ok: false, error: `url must be at most ${MAX_URL_LENGTH} characters` };
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: 'url is invalid' }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'url must start with https:// or http://' };
  }
  // In production (non-test), http:// is only allowed for loopback (dev).
  if (parsed.protocol === 'http:' && !isLoopback(url)) {
    return { ok: false, error: 'url must use https:// for non-local hosts' };
  }
  return { ok: true, url };
}

function generateSecret() {
  return 'whsec_' + crypto.randomBytes(16).toString('hex');
}

function signPayload(secret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function recordDelivery(userId, event, payload, attempt, status, statusCode) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO webhook_deliveries (id, user_id, event, payload, attempt, status, status_code)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, event, JSON.stringify(payload), attempt, status, statusCode ?? null);
  return id;
}

function markDelivery(id, status, statusCode) {
  db.prepare(
    "UPDATE webhook_deliveries SET status = ?, status_code = ?, delivered_at = datetime('now') WHERE id = ?"
  ).run(status, statusCode ?? null, id);
}

async function sendOnce(url, secret, event, payload) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = signPayload(secret, rawBody);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-jywa-event': event,
        'x-jywa-signature': signature,
      },
      body: rawBody,
      signal: controller.signal,
    });
    return { ok: response.ok, statusCode: response.status };
  } catch (error) {
    return { ok: false, statusCode: null, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispatch a webhook event to the user's configured endpoint.
 * Fire-and-forget: never throws, never blocks the caller.
 * Retries up to `delays.length` times on non-2xx or network failure.
 */
function dispatch(userId, event, data) {
  const row = db.prepare('SELECT webhook_url, webhook_secret FROM users WHERE id = ?').get(userId);
  if (!row || !row.webhook_url || !row.webhook_secret) return;

  const payload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  // Attempt 0 (immediate) + scheduled retries
  (async () => {
    let lastResult = { ok: false, statusCode: null };
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      const deliveryId = recordDelivery(userId, event, payload, attempt + 1, 'pending', lastResult.statusCode);
      lastResult = await sendOnce(row.webhook_url, row.webhook_secret, event, payload);
      if (lastResult.ok) {
        markDelivery(deliveryId, 'delivered', lastResult.statusCode);
        return;
      }
      markDelivery(deliveryId, 'failed', lastResult.statusCode);
      if (attempt < delays.length) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  })().catch((error) => {
    console.error(`[webhook-reseller] dispatch error for user ${userId}: ${error.message}`);
  });
}

module.exports = { dispatch, validateWebhookUrl, generateSecret, signPayload, isLoopback };
