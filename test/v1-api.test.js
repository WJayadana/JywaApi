const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcrypt');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jywa-v1-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-jwt-tests-123456';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.DIGIFLAZZ_USERNAME = 'digiuser';
process.env.DIGIFLAZZ_API_KEY = 'digikey';
process.env.DIGIFLAZZ_WEBHOOK_SECRET = 'hooksecret';
process.env.DIGIFLAZZ_CACHE_PATH = path.join(tempDir, 'products.json');

// Seed price cache: one product, modal 10000
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
      {
        buyer_sku_code: 'off1',
        product_name: 'Produk Nonaktif',
        category: 'Data',
        brand: 'XL',
        price: 5000,
        buyer_product_status: false,
        seller_product_status: false,
      },
    ],
  },
  pasca: { last_updated: null, products: [] },
}));

const app = require('../src/app');
const db = require('../src/db');
const config = require('../src/config');

let server;
let baseUrl;
let mockDigi;
let digiResponder; // per-test override
let mockRequests = [];

function request(route, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  return fetch(`${baseUrl}${route}`, { ...options, headers }).then(async (response) => ({
    status: response.status,
    body: await response.json().catch(() => null),
  }));
}

function keyAuth(apiKey) {
  return { authorization: ['Bearer', apiKey].join(' ') };
}

test.before(async () => {
  mockDigi = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    mockRequests.push({ path: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (digiResponder) {
      res.end(JSON.stringify(digiResponder(req.url, body)));
      return;
    }
    if (req.url === '/transaction') {
      res.end(JSON.stringify({ data: { ref_id: body.ref_id, status: 'Sukses', rc: '00', sn: 'SN12345' } }));
    } else {
      res.end(JSON.stringify({ data: {} }));
    }
  });
  await new Promise((resolve) => mockDigi.listen(0, '127.0.0.1', resolve));
  config.digiflazz.endpoint = `http://127.0.0.1:${mockDigi.address().port}`;

  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await new Promise((resolve) => mockDigi.close(resolve));
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('API v1: api-key generation, profile, products, transactions with idempotency', async () => {
  // ── Setup: register a user via JWT flow, then generate an API key ──
  let response = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'resellersatu', email: 'r1@example.com', phone: '08123450001', password: 'password-123' }),
  });
  assert.equal(response.status, 201);
  const jwtToken = response.body.token;
  const userId = response.body.user.id;

  // Upgrade to reseller + top up balance 50000 directly in DB
  db.prepare("UPDATE users SET role = 'reseller', balance = 50000 WHERE id = ?").run(userId);

  // Generate API key via JWT-protected endpoint
  response = await request('/api/users/me/api-key', {
    method: 'POST',
    headers: { authorization: ['Bearer', jwtToken].join(' ') },
  });
  assert.equal(response.status, 200);
  const apiKey = response.body.api_key;
  assert.ok(apiKey.startsWith('jywa_live_'), 'API key uses jywa_live_ prefix');

  // Regenerating replaces the key
  response = await request('/api/users/me/api-key', {
    method: 'POST',
    headers: { authorization: ['Bearer', jwtToken].join(' ') },
  });
  assert.equal(response.status, 200);
  const apiKey2 = response.body.api_key;
  assert.notEqual(apiKey2, apiKey, 'regenerate produces a new key');

  // ── Auth behaviors ──
  response = await request('/api/v1/profile');
  assert.equal(response.status, 401, 'missing key = 401');

  response = await request('/api/v1/profile', { headers: keyAuth('jywa_live_wrong') });
  assert.equal(response.status, 401, 'wrong key = 401');

  response = await request('/api/v1/profile', { headers: keyAuth(apiKey) });
  assert.equal(response.status, 401, 'old key after regenerate = 401');

  // ── Profile ──
  response = await request('/api/v1/profile', { headers: keyAuth(apiKey2) });
  assert.equal(response.status, 200);
  assert.equal(response.body.username, 'resellersatu');
  assert.equal(response.body.role, 'reseller');
  assert.equal(response.body.balance, 50000);
  assert.equal(response.body.api_key, undefined, 'api_key never echoed in profile');
  assert.equal(response.body.password_hash, undefined);

  // ── Products: single-number harga for caller role only ──
  response = await request('/api/v1/products', { headers: keyAuth(apiKey2) });
  assert.equal(response.status, 200);
  const active = response.body.products.find((p) => p.buyer_sku_code === 'xld25');
  assert.ok(active, 'active product listed');
  assert.equal(active.harga, 10050, 'reseller price = modal + 50 flat');
  assert.equal(active.harga_modal, undefined, 'no harga_modal leak');
  assert.equal(active.price, undefined, 'no raw Digiflazz price leak');
  assert.equal(typeof active.harga, 'number', 'harga is a single number, not a map');
  assert.ok(!response.body.products.find((p) => p.buyer_sku_code === 'off1'), 'inactive products hidden');

  // ── Transactions: happy path ──
  response = await request('/api/v1/transactions', {
    method: 'POST',
    headers: keyAuth(apiKey2),
    body: JSON.stringify({ sku: 'xld25', customer_no: '081299900001', ref_id: 'trx-r1-001' }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.ref_id, 'trx-r1-001');
  assert.equal(response.body.status, 'success');
  assert.equal(response.body.harga, 10050);
  assert.equal(response.body.sn, 'SN12345', 'serial number passed through');

  // Balance deducted: 50000 - 10050 = 39950
  response = await request('/api/v1/profile', { headers: keyAuth(apiKey2) });
  assert.equal(response.body.balance, 39950);

  // ── Idempotency: same ref_id returns the SAME transaction, no double charge ──
  response = await request('/api/v1/transactions', {
    method: 'POST',
    headers: keyAuth(apiKey2),
    body: JSON.stringify({ sku: 'xld25', customer_no: '081299900001', ref_id: 'trx-r1-001' }),
  });
  assert.equal(response.status, 200, 'duplicate ref_id returns 200 (not 201)');
  assert.equal(response.body.ref_id, 'trx-r1-001');
  response = await request('/api/v1/profile', { headers: keyAuth(apiKey2) });
  assert.equal(response.body.balance, 39950, 'no double charge');

  // ── Insufficient balance ──
  db.prepare('UPDATE users SET balance = 100 WHERE id = ?').run(userId);
  response = await request('/api/v1/transactions', {
    method: 'POST',
    headers: keyAuth(apiKey2),
    body: JSON.stringify({ sku: 'xld25', customer_no: '081299900002', ref_id: 'trx-r1-002' }),
  });
  assert.equal(response.status, 402, 'insufficient balance = 402');
  db.prepare('UPDATE users SET balance = 50000 WHERE id = ?').run(userId);

  // ── Unknown SKU ──
  response = await request('/api/v1/transactions', {
    method: 'POST',
    headers: keyAuth(apiKey2),
    body: JSON.stringify({ sku: 'nope', customer_no: '081299900003', ref_id: 'trx-r1-003' }),
  });
  assert.equal(response.status, 404, 'unknown sku = 404');

  // ── Digiflazz failure → automatic refund ──
  digiResponder = () => ({ data: { rc: '99', status: 'Gagal', message: 'nomor salah' } });
  response = await request('/api/v1/transactions', {
    method: 'POST',
    headers: keyAuth(apiKey2),
    body: JSON.stringify({ sku: 'xld25', customer_no: '081299900004', ref_id: 'trx-r1-004' }),
  });
  digiResponder = null;
  assert.equal(response.status, 502, 'failed upstream returns 502');
  assert.equal(response.body.status, 'failed');
  response = await request('/api/v1/profile', { headers: keyAuth(apiKey2) });
  assert.equal(response.body.balance, 50000, 'refunded automatically after failure');

  // ── History ──
  response = await request('/api/v1/transactions', { headers: keyAuth(apiKey2) });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.transactions));
  assert.ok(response.body.transactions.length >= 2, 'history includes success + failed trx');

  // ── Status lookup by ref_id ──
  response = await request('/api/v1/transactions/trx-r1-001', { headers: keyAuth(apiKey2) });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'success');

  response = await request('/api/v1/transactions/unknown-ref', { headers: keyAuth(apiKey2) });
  assert.equal(response.status, 404);
});
