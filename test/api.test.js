const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcrypt');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jywa-api-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-jwt-tests-123456';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tempDir, 'test.db');

const app = require('../src/app');
const db = require('../src/db');

let server;
let baseUrl;

function request(route, options = {}) {
  return fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  }).then(async (response) => ({
    status: response.status,
    body: await response.json(),
  }));
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

test.before(async () => {
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('auth, profile, owner controls, and balance mutations work end-to-end', async () => {
  let response = await request('/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');

  response = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'Jayadana', email: 'jay@example.com', phone: '08123456789', password: 'password-123' }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.user.role, 'bronze');
  assert.equal(response.body.user.balance, 0);
  assert.ok(response.body.token);
  assert.equal(Object.hasOwn(response.body.user, 'password_hash'), false);
  const userToken = response.body.token;
  const userId = response.body.user.id;

  response = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'jayadana', email: 'other@example.com', phone: '08123456780', password: 'password-123' }),
  });
  assert.equal(response.status, 409);

  response = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'jayadana', password: 'password-123' }),
  });
  assert.equal(response.status, 200);
  assert.ok(response.body.token);

  response = await request('/api/users/me', { headers: auth(userToken) });
  assert.equal(response.status, 200);
  assert.equal(response.body.user.id, userId);
  assert.equal(response.body.user.email, 'jay@example.com');

  response = await request('/api/users', { headers: auth(userToken) });
  assert.equal(response.status, 403);

  const ownerPassword = 'owner-password-123';
  const ownerId = 'owner-test-id';
  db.prepare(
    `INSERT INTO users (id, username, email, phone, password_hash, role)
     VALUES (?, ?, ?, ?, ?, 'owner')`
  ).run(ownerId, 'owner', 'owner@example.com', '08111111111', await bcrypt.hash(ownerPassword, 4));

  response = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'owner', password: ownerPassword }),
  });
  assert.equal(response.status, 200);
  const ownerToken = response.body.token;

  response = await request(`/api/users/${userId}/balance`, {
    method: 'POST',
    headers: auth(ownerToken),
    body: JSON.stringify({ type: 'deposit', direction: '+', amount: 100000, note: 'saldo awal' }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.user.balance, 100000);
  assert.equal(response.body.mutation.balance_after, 100000);

  response = await request('/api/users/me/mutations', { headers: auth(userToken) });
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.mutations[0].type, 'deposit');

  response = await request(`/api/users/${userId}/balance`, {
    method: 'POST',
    headers: auth(ownerToken),
    body: JSON.stringify({ type: 'pembelian', direction: '-', amount: 25000, ref_id: 'trx-1' }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.user.balance, 75000);

  response = await request(`/api/users/${userId}`, {
    method: 'PUT',
    headers: auth(ownerToken),
    body: JSON.stringify({ role: 'silver' }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.user.role, 'silver');

  response = await request(`/api/users/${userId}`, {
    method: 'DELETE',
    headers: auth(ownerToken),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.user.status, 'banned');

  response = await request('/api/users/me', { headers: auth(userToken) });
  assert.equal(response.status, 403);
});
