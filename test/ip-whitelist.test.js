const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcrypt');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jywa-ipwl-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-ip-whitelist-tests-1234';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.DIGIFLAZZ_CACHE_PATH = path.join(tempDir, 'products.json');
fs.mkdirSync(path.dirname(process.env.DIGIFLAZZ_CACHE_PATH), { recursive: true });
fs.writeFileSync(process.env.DIGIFLAZZ_CACHE_PATH, JSON.stringify({
  prepaid: { last_updated: Date.now(), products: [] },
  pasca: { last_updated: null, products: [] },
}));

const { ipMatches, validateIpList } = require('../src/services/ip-whitelist');
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

test.before(async () => {
  db.prepare(
    `INSERT INTO users (id, username, email, phone, password_hash, role, balance, status, api_key)
     VALUES ('wl-user', 'wluser', 'wl@example.com', '08123450022', ?, 'reseller', 10000, 'active', 'wl-api-key')`
  ).run(bcrypt.hashSync('password-123', 4));

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

test('ipMatches handles exact IPv4, CIDR ranges, IPv6, and mapped addresses', () => {
  assert.equal(ipMatches('1.2.3.4', ['1.2.3.4']), true);
  assert.equal(ipMatches('1.2.3.5', ['1.2.3.4']), false);
  assert.equal(ipMatches('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(ipMatches('11.1.2.3', ['10.0.0.0/8']), false);
  assert.equal(ipMatches('192.168.1.200', ['192.168.1.0/24']), true);
  assert.equal(ipMatches('192.168.2.1', ['192.168.1.0/24']), false);
  // IPv4-mapped IPv6 (Node often reports ::ffff:a.b.c.d)
  assert.equal(ipMatches('::ffff:1.2.3.4', ['1.2.3.4']), true);
  // IPv6 exact
  assert.equal(ipMatches('2001:db8::1', ['2001:db8::1']), true);
  assert.equal(ipMatches('2001:db8::2', ['2001:db8::1']), false);
  // Multiple entries: any match wins
  assert.equal(ipMatches('5.6.7.8', ['1.2.3.4', '5.6.7.8']), true);
  // Empty/undefined whitelist = allow all
  assert.equal(ipMatches('9.9.9.9', []), true);
  assert.equal(ipMatches('9.9.9.9', null), true);
});

test('validateIpList rejects malformed entries and enforces limits', () => {
  assert.equal(validateIpList(['1.2.3.4', '10.0.0.0/8']).ok, true);
  assert.equal(validateIpList('not-an-array').ok, false);
  assert.equal(validateIpList(['999.999.1.1']).ok, false);
  assert.equal(validateIpList(['10.0.0.0/99']).ok, false);
  assert.equal(validateIpList(['abc']).ok, false);
  assert.equal(validateIpList(Array.from({ length: 21 }, (_, i) => `1.2.3.${i}`)).ok, false, 'max 20 entries');
  assert.equal(validateIpList([]).ok, true, 'empty list allowed (clears whitelist)');
});

test('v1 API enforces the whitelist and manage endpoints are self-service', async () => {
  // Login for JWT (manage endpoints)
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'wluser', password: 'password-123' }),
  });
  assert.equal(login.status, 200);
  const token = login.body.token;

  // Default: no whitelist — API key works from anywhere
  let response = await request('/api/v1/profile', { headers: auth('wl-api-key') });
  assert.equal(response.status, 200, 'no whitelist = allow all');

  // Read whitelist (empty)
  response = await request('/api/users/me/api-key/ips', { headers: auth(token) });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.ips, []);

  // Set whitelist to an IP that is NOT the test client (client is 127.0.0.1)
  response = await request('/api/users/me/api-key/ips', {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify({ ips: ['203.0.113.99'] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.ips, ['203.0.113.99']);

  // v1 request now rejected (test client comes from 127.0.0.1)
  response = await request('/api/v1/profile', { headers: auth('wl-api-key') });
  assert.equal(response.status, 403, 'non-whitelisted IP = 403');

  // Rejection logged in auth_logs
  const rejected = db.prepare(
    "SELECT COUNT(*) AS count FROM auth_logs WHERE user_id = 'wl-user' AND event = 'api_ip_rejected'"
  ).get().count;
  assert.ok(rejected >= 1, 'api_ip_rejected recorded');

  // Whitelist the loopback → allowed again
  response = await request('/api/users/me/api-key/ips', {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify({ ips: ['127.0.0.1', '203.0.113.99'] }),
  });
  assert.equal(response.status, 200);
  response = await request('/api/v1/profile', { headers: auth('wl-api-key') });
  assert.equal(response.status, 200, 'whitelisted IP allowed');

  // Clear whitelist → allow all again
  response = await request('/api/users/me/api-key/ips', {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify({ ips: [] }),
  });
  assert.equal(response.status, 200);
  response = await request('/api/v1/profile', { headers: auth('wl-api-key') });
  assert.equal(response.status, 200);

  // Validation errors
  response = await request('/api/users/me/api-key/ips', {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify({ ips: ['bogus-ip'] }),
  });
  assert.equal(response.status, 400);

  response = await request('/api/users/me/api-key/ips', {
    method: 'PUT',
    headers: auth(token),
    body: JSON.stringify({ ips: 'not-array' }),
  });
  assert.equal(response.status, 400);

  // Manage endpoints require JWT (API key cannot manage its own whitelist)
  response = await request('/api/users/me/api-key/ips', { headers: auth('wl-api-key') });
  assert.equal(response.status, 401, 'API key is not a JWT');
});
