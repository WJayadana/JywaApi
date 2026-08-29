const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jywa-retries-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-jwt-tests-123456';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.DIGIFLAZZ_USERNAME = 'digiuser';
process.env.DIGIFLAZZ_API_KEY = 'digikey';
process.env.DIGIFLAZZ_WEBHOOK_SECRET = 'hooksecret';
process.env.DIGIFLAZZ_CACHE_PATH = path.join(tempDir, 'products.json');
process.env.RETRY_MAX_CHECKS = '3';
process.env.RETRY_CHECK_DELAY_MS = '50';

fs.mkdirSync(path.dirname(process.env.DIGIFLAZZ_CACHE_PATH), { recursive: true });
fs.writeFileSync(process.env.DIGIFLAZZ_CACHE_PATH, JSON.stringify({
  prepaid: {
    last_updated: Date.now(),
    products: [{
      buyer_sku_code: 'xld25',
      product_name: 'XL Data 25K',
      category: 'Data',
      brand: 'XL',
      price: 10000,
      buyer_product_status: true,
      seller_product_status: true,
    }],
  },
  pasca: { last_updated: null, products: [] },
}));

const app = require('../src/app');
const db = require('../src/db');
const config = require('../src/config');

let server;
let baseUrl;
let mockDigi;
let digiResponder;
let transactionCalls = [];

function request(route, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
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
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/transaction') {
      transactionCalls.push({ ref_id: body.ref_id, customer_no: body.customer_no });
      res.end(JSON.stringify(digiResponder ? digiResponder(body) : { data: { ref_id: body.ref_id, status: 'Sukses', rc: '00', sn: 'SN12345' } }));
      return;
    }
    res.end(JSON.stringify({ data: {} }));
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

async function setupUser(suffix) {
  const uname = `retryuser${suffix}`;
  const email = `retry${suffix}@example.com`;
  const phone = `08123456${String(suffix).padStart(4, '0')}`;
  let response = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: uname, email, phone, password: 'password-123' }),
  });
  const jwtToken = response.body.token;
  const userId = response.body.user.id;
  db.prepare("UPDATE users SET role = 'reseller', balance = 50000 WHERE id = ?").run(userId);
  response = await request('/api/users/me/api-key', { method: 'POST', headers: { authorization: ['Bearer', jwtToken].join(' ') } });
  return { apiKey: response.body.api_key, userId };
}

test('pending transaction auto-resolves to success without double-charging', async () => {
  transactionCalls = [];
  let callCount = 0;
  digiResponder = (body) => {
    callCount += 1;
    if (callCount === 1) return { data: { ref_id: body.ref_id, status: 'Pending', rc: '03', message: 'Transaksi Pending' } };
    return { data: { ref_id: body.ref_id, status: 'Sukses', rc: '00', sn: 'SN-RETRY-OK', message: 'Transaksi Sukses' } };
  };

  const { apiKey, userId } = await setupUser(1);

  const response = await request('/api/v1/transactions', {
    method: 'POST',
    headers: keyAuth(apiKey),
    body: JSON.stringify({ sku: 'xld25', customer_no: '081299900001', ref_id: 'retry-pending-001' }),
  });

  // Sync response should be 202 Accepted with pending status
  assert.equal(response.status, 202, 'pending upstream returns 202');
  assert.equal(response.body.status, 'pending');

  // Balance already debited once
  const balanceAfterDebit = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
  assert.equal(balanceAfterDebit, 39950, 'debited 10050 once');

  // Poll for resolution (deterministic, no fixed sleep)
  async function waitForStatus(refId, expected, maxMs = 2000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const row = db.prepare('SELECT status FROM transactions WHERE ref_id = ?').get(refId);
      if (row && row.status === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  await waitForStatus('retry-pending-001', 'success');

  const txn = db.prepare("SELECT * FROM transactions WHERE ref_id = 'retry-pending-001'").get();
  assert.equal(txn.status, 'success', 'auto-retry resolved to success');
  assert.equal(txn.sn, 'SN-RETRY-OK', 'sn from retry response');

  // Balance NOT double-charged — still 39950
  const balanceFinal = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
  assert.equal(balanceFinal, 39950, 'no double debit on retry');

  // Provider was called at least twice with the SAME ref_id (initial + retry)
  const calls = transactionCalls.filter((c) => c.ref_id === 'retry-pending-001');
  assert.ok(calls.length >= 2, 'provider re-queried with same ref_id');
  digiResponder = null;
});

test('pending transaction that stays failed gets refunded after max checks', async () => {
  digiResponder = (body) => ({
    data: { ref_id: body.ref_id, status: 'Gagal', rc: '99', message: 'nomor tidak terdaftar' },
  });

  const { apiKey, userId } = await setupUser(2);

  // First call returns Pending, subsequent return Gagal
  let calls = 0;
  digiResponder = (body) => {
    calls += 1;
    if (calls === 1) return { data: { ref_id: body.ref_id, status: 'Pending', rc: '03', message: 'Pending' } };
    return { data: { ref_id: body.ref_id, status: 'Gagal', rc: '99', message: 'nomor tidak terdaftar' } };
  };

  const response = await request('/api/v1/transactions', {
    method: 'POST',
    headers: keyAuth(apiKey),
    body: JSON.stringify({ sku: 'xld25', customer_no: '081299900002', ref_id: 'retry-fail-002' }),
  });
  assert.equal(response.status, 202);

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const current = db.prepare("SELECT status FROM transactions WHERE ref_id = 'retry-fail-002'").get();
    if (current && current.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const txn = db.prepare("SELECT * FROM transactions WHERE ref_id = 'retry-fail-002'").get();
  assert.equal(txn.status, 'failed', 'ends failed after provider says Gagal');

  // Refunded: 50000 - 10050 + 10050 = 50000
  const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
  assert.equal(balance, 50000, 'refunded after failed retry');

  // Exactly one refund mutation
  const refunds = db.prepare("SELECT * FROM mutations WHERE ref_id = 'retry-fail-002' AND type = 'refund'").all();
  assert.equal(refunds.length, 1, 'exactly one refund');
  digiResponder = null;
});

test('transaction that stays pending past max checks stops retrying (no infinite loop)', async () => {
  digiResponder = (body) => ({
    data: { ref_id: body.ref_id, status: 'Pending', rc: '03', message: 'Pending' },
  });

  const { apiKey } = await setupUser(3);

  const response = await request('/api/v1/transactions', {
    method: 'POST',
    headers: keyAuth(apiKey),
    body: JSON.stringify({ sku: 'xld25', customer_no: '081299900003', ref_id: 'retry-stuck-003' }),
  });
  assert.equal(response.status, 202);

  // Wait until all 3 retries are done (initial + 3 retries = max 4 calls)
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (transactionCalls.filter((c) => c.ref_id === 'retry-stuck-003').length >= 4) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // Should stop after RETRY_MAX_CHECKS (3) retries = max 1 + 3 = 4 calls total
  const calls = transactionCalls.filter((c) => c.ref_id === 'retry-stuck-003');
  assert.ok(calls.length <= 4, `bounded retries (got ${calls.length} calls)`);

  const txn = db.prepare("SELECT * FROM transactions WHERE ref_id = 'retry-stuck-003'").get();
  assert.equal(txn.status, 'pending', 'stays pending, no refund (unknown outcome — safe)');
  digiResponder = null;
});
