const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcrypt');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jywa-digi-route-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-jwt-tests-123456';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.DIGIFLAZZ_USERNAME = 'digiuser';
process.env.DIGIFLAZZ_API_KEY = 'digikey';
process.env.DIGIFLAZZ_WEBHOOK_SECRET = 'hooksecret';

const app = require('../src/app');
const db = require('../src/db');
const config = require('../src/config');

let server;
let baseUrl;
let mockDigi;
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

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

test.before(async () => {
  // Mock Digiflazz upstream
  mockDigi = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    mockRequests.push({ path: req.url, body });

    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/cek-saldo') {
      res.end(JSON.stringify({ data: { deposit: 1000000 } }));
    } else if (req.url === '/price-list') {
      res.end(JSON.stringify({ data: [{ buyer_sku_code: 'xld25', price: 25000 }] }));
    } else if (req.url === '/deposit') {
      res.end(JSON.stringify({ data: { rc: '00', amount: 100007, bank: 'BCA' } }));
    } else if (req.url === '/transaction') {
      res.end(JSON.stringify({ data: { ref_id: body.ref_id, status: 'Sukses', rc: '00' } }));
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

test('digiflazz routes: owner-only access, saldo/harga/deposit/transaksi proxied, webhook verified', async () => {
  // Seed owner + bronze user
  const ownerId = 'owner-digi-test';
  db.prepare(
    `INSERT INTO users (id, username, email, phone, password_hash, role)
     VALUES (?, ?, ?, ?, ?, 'owner')`
  ).run(ownerId, 'digiowner', 'digiowner@example.com', '08111111111', await bcrypt.hash('owner-pass-123', 4));

  let response = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'digiowner', password: 'owner-pass-123' }),
  });
  assert.equal(response.status, 200);
  const ownerToken = response.body.token;

  response = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'digibronze', email: 'digibronze@example.com', phone: '08123456789', password: 'password-123' }),
  });
  assert.equal(response.status, 201);
  const bronzeToken = response.body.token;

  // Unauthenticated → 401
  response = await request('/api/digiflazz/saldo');
  assert.equal(response.status, 401);

  // Bronze → 403
  response = await request('/api/digiflazz/saldo', { headers: auth(bronzeToken) });
  assert.equal(response.status, 403);

  // Owner → 200 with saldo data
  response = await request('/api/digiflazz/saldo', { headers: auth(ownerToken) });
  assert.equal(response.status, 200);
  assert.equal(response.body.deposit, 1000000);

  // Price list (prepaid default)
  response = await request('/api/digiflazz/harga', { headers: auth(ownerToken) });
  assert.equal(response.status, 200);
  assert.equal(response.body.products[0].buyer_sku_code, 'xld25');

  // Price list pasca
  response = await request('/api/digiflazz/harga?cmd=pasca', { headers: auth(ownerToken) });
  assert.equal(response.status, 200);
  const pascaReq = mockRequests.find((r) => r.path === '/price-list' && r.body.cmd === 'pasca');
  assert.ok(pascaReq, 'pasca cmd should be forwarded');

  // Invalid cmd → 400
  response = await request('/api/digiflazz/harga?cmd=nonsense', { headers: auth(ownerToken) });
  assert.equal(response.status, 400);

  // Deposit ticket
  response = await request('/api/digiflazz/deposit', {
    method: 'POST',
    headers: auth(ownerToken),
    body: JSON.stringify({ amount: 100000, bank: 'BCA', owner_name: 'Jayadana' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.rc, '00');

  // Deposit missing fields → 400
  response = await request('/api/digiflazz/deposit', {
    method: 'POST',
    headers: auth(ownerToken),
    body: JSON.stringify({ amount: 100000 }),
  });
  assert.equal(response.status, 400);

  // Transaksi
  response = await request('/api/digiflazz/transaksi', {
    method: 'POST',
    headers: auth(ownerToken),
    body: JSON.stringify({ sku: 'xld25', customer_no: '08123456789', ref_id: 'trx-digi-1' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'Sukses');
  assert.equal(response.body.ref_id, 'trx-digi-1');

  // Transaksi missing fields → 400
  response = await request('/api/digiflazz/transaksi', {
    method: 'POST',
    headers: auth(ownerToken),
    body: JSON.stringify({ sku: 'xld25' }),
  });
  assert.equal(response.status, 400);

  // Webhook with valid signature → 200
  const hookPayload = JSON.stringify({ data: { ref_id: 'trx-digi-1', status: 'Sukses', rc: '00' } });
  const validSig = 'sha1=' + crypto.createHmac('sha1', 'hooksecret').update(hookPayload).digest('hex');
  let hookRes = await fetch(`${baseUrl}/api/digiflazz/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature': validSig,
      'x-digiflazz-event': 'update',
    },
    body: hookPayload,
  });
  assert.equal(hookRes.status, 200);

  // Webhook with invalid signature → 401
  hookRes = await fetch(`${baseUrl}/api/digiflazz/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature': 'sha1=deadbeef',
      'x-digiflazz-event': 'update',
    },
    body: hookPayload,
  });
  assert.equal(hookRes.status, 401);
});
