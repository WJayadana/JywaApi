const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcrypt');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jywa-stats-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-stats-tests-123456';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.DIGIFLAZZ_CACHE_PATH = path.join(tempDir, 'products.json');
fs.mkdirSync(path.dirname(process.env.DIGIFLAZZ_CACHE_PATH), { recursive: true });
fs.writeFileSync(process.env.DIGIFLAZZ_CACHE_PATH, JSON.stringify({
  prepaid: { last_updated: Date.now(), products: [] },
  pasca: { last_updated: null, products: [] },
}));

const app = require('../src/app');
const db = require('../src/db');

let server;
let baseUrl;

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

function seedUser({ id, username, role = 'reseller', balance = 0, apiKey }) {
  db.prepare(
    `INSERT INTO users (id, username, email, phone, password_hash, role, balance, status, api_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
  ).run(id, username, `${username}@example.com`, '08123456789', bcrypt.hashSync('password-123', 4), role, balance, apiKey);
}

function seedTransaction({ id, userId, refId, sku, harga, hargaModal, status, createdAt }) {
  db.prepare(
    `INSERT INTO transactions
      (id, user_id, ref_id, sku, customer_no, harga, harga_modal, status, provider_rc, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '00', ?, ?)`
  ).run(id, userId, refId, sku, '081299900001', harga, hargaModal, status, createdAt, createdAt);
}

test.before(async () => {
  seedUser({ id: 'owner-id', username: 'ownerstats', role: 'owner', apiKey: 'owner-stats-key' });
  seedUser({ id: 'reseller-id', username: 'resellerstats', role: 'reseller', balance: 100000, apiKey: 'reseller-stats-key' });

  seedTransaction({ id: 'trx-1', userId: 'reseller-id', refId: 'ref-1', sku: 'sku-a', harga: 1050, hargaModal: 1000, status: 'success', createdAt: '2026-08-01 10:00:00' });
  seedTransaction({ id: 'trx-2', userId: 'reseller-id', refId: 'ref-2', sku: 'sku-a', harga: 1050, hargaModal: 1000, status: 'success', createdAt: '2026-08-02 10:00:00' });
  seedTransaction({ id: 'trx-3', userId: 'reseller-id', refId: 'ref-3', sku: 'sku-b', harga: 2050, hargaModal: 2000, status: 'success', createdAt: '2026-08-03 10:00:00' });
  seedTransaction({ id: 'trx-4', userId: 'reseller-id', refId: 'ref-4', sku: 'sku-a', harga: 1050, hargaModal: 1000, status: 'failed', createdAt: '2026-08-04 10:00:00' });
  seedTransaction({ id: 'trx-5', userId: 'reseller-id', refId: 'ref-5', sku: 'sku-b', harga: 2050, hargaModal: 2000, status: 'pending', createdAt: '2026-08-05 10:00:00' });
  seedTransaction({ id: 'trx-6', userId: 'owner-id', refId: 'owner-ref', sku: 'sku-owner', harga: 999, hargaModal: 900, status: 'success', createdAt: '2026-08-06 10:00:00' });

  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('stats overview exposes only successful sales and calculates revenue, cost, and profit', async () => {
  let response = await request('/api/v1/stats', { headers: auth('reseller-stats-key') });
  assert.equal(response.status, 403, 'reseller cannot access global stats');

  response = await request('/api/v1/stats', { headers: auth('owner-stats-key') });
  assert.equal(response.status, 200);
  assert.equal(response.body.total_transactions, 6);
  assert.equal(response.body.successful_transactions, 4, 'only successful transactions count as sales');
  assert.equal(response.body.failed_transactions, 1);
  assert.equal(response.body.pending_transactions, 1);
  assert.equal(response.body.total_sales, 5149, 'successful sale prices: 1050 + 1050 + 2050 + 999');
  assert.equal(response.body.total_cost, 4900, 'successful modal costs only');
  assert.equal(response.body.total_profit, 249, 'profit = sum(harga - harga_modal) for success only');
});

test('stats supports date range and product aggregation', async () => {
  const response = await request('/api/v1/stats?from=2026-08-01&to=2026-08-03', {
    headers: auth('owner-stats-key'),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.total_transactions, 3);
  assert.equal(response.body.successful_transactions, 3);
  assert.equal(response.body.total_sales, 4150);
  assert.equal(response.body.total_cost, 4000);
  assert.equal(response.body.total_profit, 150);
  assert.deepEqual(response.body.top_products, [
    { sku: 'sku-a', sold: 2, revenue: 2100, cost: 2000, profit: 100 },
    { sku: 'sku-b', sold: 1, revenue: 2050, cost: 2000, profit: 50 },
  ]);
});

test('stats rejects invalid date range and remains owner-only on legacy route', async () => {
  let response = await request('/api/v1/stats?from=not-a-date', { headers: auth('owner-stats-key') });
  assert.equal(response.status, 400);

  const jwt = require('jsonwebtoken');
  const config = require('../src/config');
  const resellerJwt = jwt.sign({ sub: 'reseller-id' }, config.jwtSecret, { expiresIn: '1h' });
  const ownerJwt = jwt.sign({ sub: 'owner-id' }, config.jwtSecret, { expiresIn: '1h' });

  response = await request('/api/stats', { headers: auth(resellerJwt) });
  assert.equal(response.status, 403, 'legacy stats route rejects non-owner JWT');

  response = await request('/api/stats', { headers: auth(ownerJwt) });
  assert.equal(response.status, 200);
  assert.equal(response.body.total_profit, 249);
});
