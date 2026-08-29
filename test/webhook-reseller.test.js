const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcrypt');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jywa-whreseller-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-webhook-tests-123456';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.DIGIFLAZZ_USERNAME = 'digiuser';
process.env.DIGIFLAZZ_API_KEY = 'digikey';
process.env.DIGIFLAZZ_WEBHOOK_SECRET = 'hooksecret';
process.env.DIGIFLAZZ_CACHE_PATH = path.join(tempDir, 'products.json');
// Fast retries for tests
process.env.RESELLER_WEBHOOK_RETRY_DELAYS_MS = '10,20';
process.env.RESELLER_WEBHOOK_TIMEOUT_MS = '2000';

fs.mkdirSync(path.dirname(process.env.DIGIFLAZZ_CACHE_PATH), { recursive: true });
fs.writeFileSync(process.env.DIGIFLAZZ_CACHE_PATH, JSON.stringify({
  prepaid: {
    last_updated: Date.now(),
    products: [
      {
        buyer_sku_code: 'xld25',
        product_name: 'XL Data 25K',
        category: 'Data',
        brand: 'XL',
        price: 10000,
        buyer_product_status: true,
        seller_product_status: true,
      },
    ],
  },
  pasca: { last_updated: null, products: [] },
}));

const app = require('../src/app');
const db = require('../src/db');
const config = require('../src/config');
const webhookReseller = require('../src/services/webhook-reseller');

let server;
let baseUrl;
let mockDigi;
let receiver;
let receiverPort;
let received = [];
let receiverStatus = 200;

function request(route, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${route}`, { ...options, headers }).then(async (response) => ({
    status: response.status,
    body: await response.json().catch(() => null),
  }));
}

function auth(token) {
  return { authorization: ['Bearer', token].join(' ') };
}

function waitFor(predicate, timeoutMs = 3000, stepMs = 25) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor timed out'));
      }
    }, stepMs);
  });
}

test.before(async () => {
  // Mock Digiflazz upstream: transactions succeed
  mockDigi = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { ref_id: body.ref_id, status: 'Sukses', rc: '00', sn: 'SN777' } }));
  });
  await new Promise((resolve) => mockDigi.listen(0, '127.0.0.1', resolve));
  config.digiflazz.endpoint = `http://127.0.0.1:${mockDigi.address().port}`;

  // Mock reseller receiver: capture raw body + headers for signature check
  receiver = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      url: req.url,
      headers: req.headers,
      raw: Buffer.concat(chunks),
    });
    res.writeHead(receiverStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: receiverStatus === 200 }));
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverPort = receiver.address().port;

  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await new Promise((resolve) => mockDigi.close(resolve));
  await new Promise((resolve) => receiver.close(resolve));
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('reseller webhook: manage endpoint, signed delivery on transaction, retry, and audit', async (t) => {
  // ── Setup user ──
  let response = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'whreseller', email: 'wh@example.com', phone: '08123450099', password: 'password-123' }),
  });
  assert.equal(response.status, 201);
  const jwtToken = response.body.token;
  const userId = response.body.user.id;
  db.prepare("UPDATE users SET role = 'reseller', balance = 100000 WHERE id = ?").run(userId);

  response = await request('/api/users/me/api-key', {
    method: 'POST',
    headers: auth(jwtToken),
  });
  const apiKey = response.body.api_key;

  // ── Manage: set webhook URL (http allowed only for loopback in test) ──
  const webhookUrl = `http://127.0.0.1:${receiverPort}/hooks/jywa`;
  response = await request('/api/users/me/webhook', {
    method: 'PUT',
    headers: auth(jwtToken),
    body: JSON.stringify({ url: webhookUrl }),
  });
  assert.equal(response.status, 200);
  const webhookSecret = response.body.webhook_secret;
  assert.ok(webhookSecret.startsWith('whsec_'), 'secret uses whsec_ prefix');
  assert.equal(response.body.url, webhookUrl);

  // GET shows URL but never the secret again
  response = await request('/api/users/me/webhook', { headers: auth(jwtToken) });
  assert.equal(response.status, 200);
  assert.equal(response.body.url, webhookUrl);
  assert.equal(response.body.webhook_secret, undefined, 'secret shown only once');

  // ── Test ping ──
  received = [];
  response = await request('/api/users/me/webhook/test', {
    method: 'POST',
    headers: auth(jwtToken),
  });
  assert.equal(response.status, 200);
  await waitFor(() => received.length >= 1);
  const ping = received[0];
  const pingPayload = JSON.parse(ping.raw.toString());
  assert.equal(pingPayload.event, 'ping');
  // Signature check: sha256 HMAC over raw body
  const pingExpected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(ping.raw).digest('hex');
  assert.equal(ping.headers['x-jywa-signature'], pingExpected, 'ping signature valid');
  assert.equal(ping.headers['x-jywa-event'], 'ping');

  // ── Successful transaction triggers transaction.update delivery ──
  received = [];
  response = await request('/api/v1/transactions', {
    method: 'POST',
    headers: { authorization: ['Bearer', apiKey].join(' '), 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'xld25', customer_no: '081299900001', ref_id: 'wh-trx-001' }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.status, 'success');

  await waitFor(() => received.length >= 1);
  const delivery = received[0];
  const payload = JSON.parse(delivery.raw.toString());
  assert.equal(payload.event, 'transaction.update');
  assert.equal(payload.data.ref_id, 'wh-trx-001');
  assert.equal(payload.data.status, 'success');
  assert.equal(payload.data.sn, 'SN777');
  assert.equal(payload.data.harga, 10050, 'reseller price');
  assert.ok(payload.timestamp, 'timestamp present');
  const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(delivery.raw).digest('hex');
  assert.equal(delivery.headers['x-jywa-signature'], expected, 'delivery signature valid');
  assert.equal(delivery.headers['x-jywa-event'], 'transaction.update');

  // Delivery audit row recorded
  await waitFor(() => db.prepare(
    "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE user_id = ? AND event = 'transaction.update' AND status = 'delivered'"
  ).get(userId).count >= 1);

  // ── Failing receiver: transaction still succeeds, delivery marked failed after retries ──
  receiverStatus = 500;
  received = [];
  response = await request('/api/v1/transactions', {
    method: 'POST',
    headers: { authorization: ['Bearer', apiKey].join(' '), 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'xld25', customer_no: '081299900002', ref_id: 'wh-trx-002' }),
  });
  assert.equal(response.status, 201, 'transaction unaffected by webhook failure');

  // initial attempt + 2 retries = 3 requests
  await waitFor(() => received.length >= 3, 5000);
  await waitFor(() => db.prepare(
    "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE user_id = ? AND status = 'failed'"
  ).get(userId).count >= 1, 5000);
  receiverStatus = 200;

  // ── Validation: non-http(s), oversized, wrong type ──
  response = await request('/api/users/me/webhook', {
    method: 'PUT',
    headers: auth(jwtToken),
    body: JSON.stringify({ url: 'ftp://example.com/hook' }),
  });
  assert.equal(response.status, 400);

  response = await request('/api/users/me/webhook', {
    method: 'PUT',
    headers: auth(jwtToken),
    body: JSON.stringify({ url: 'https://' + 'a'.repeat(500) + '.example.com/hook' }),
  });
  assert.equal(response.status, 400);

  // ── Delete webhook: no more deliveries ──
  response = await request('/api/users/me/webhook', {
    method: 'DELETE',
    headers: auth(jwtToken),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.deleted, true);

  received = [];
  response = await request('/api/v1/transactions', {
    method: 'POST',
    headers: { authorization: ['Bearer', apiKey].join(' '), 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'xld25', customer_no: '081299900003', ref_id: 'wh-trx-003' }),
  });
  assert.equal(response.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(received.length, 0, 'no delivery after webhook deleted');
});

test('webhook URL must be https in production mode', () => {
  const { validateWebhookUrl } = webhookReseller;
  assert.equal(validateWebhookUrl('https://reseller.example.com/hook').ok, true);
  assert.equal(validateWebhookUrl('http://reseller.example.com/hook').ok, false, 'plain http rejected for public hosts');
  assert.equal(validateWebhookUrl('http://127.0.0.1:8080/hook').ok, true, 'loopback http allowed for development');
  assert.equal(validateWebhookUrl('ftp://example.com').ok, false);
  assert.equal(validateWebhookUrl('not-a-url').ok, false);
  assert.equal(validateWebhookUrl('https://' + 'a'.repeat(500) + '.com').ok, false, 'max 500 chars');
});
