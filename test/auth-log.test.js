const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jywa-activity-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-activity-tests-123456';
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

test.before(async () => {
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

test('auth activity logs successful and failed logins, plus api key changes', async () => {
  const register = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'user-agent': 'activity-test-suite', 'x-forwarded-for': '203.0.113.10' },
    body: JSON.stringify({
      username: 'activityuser',
      email: 'activity@example.com',
      phone: '08123450011',
      password: 'password-123',
    }),
  });
  assert.equal(register.status, 201);

  const badLogin = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'user-agent': 'curl/8.5', 'x-forwarded-for': '203.0.113.20' },
    body: JSON.stringify({ identifier: 'activityuser', password: 'wrong-password' }),
  });
  assert.equal(badLogin.status, 401);

  const goodLogin = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '203.0.113.30' },
    body: JSON.stringify({ identifier: 'activityuser', password: 'password-123' }),
  });
  assert.equal(goodLogin.status, 200);
  const token = goodLogin.body.token;
  const userId = goodLogin.body.user.id;

  const generate = await request('/api/users/me/api-key', {
    method: 'POST',
    headers: { ...auth(token), 'user-agent': 'fetcher', 'x-forwarded-for': '203.0.113.40' },
  });
  assert.equal(generate.status, 200);
  assert.ok(generate.body.api_key.startsWith('jywa_live_'));

  const revoke = await request('/api/users/me/api-key', {
    method: 'DELETE',
    headers: { ...auth(token), 'user-agent': 'revoker', 'x-forwarded-for': '203.0.113.50' },
  });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.revoked, true);

  const activity = await request('/api/users/me/activity', {
    headers: auth(token),
  });
  assert.equal(activity.status, 200);
  assert.equal(activity.body.page, 1);
  assert.equal(activity.body.limit, 20);
  assert.equal(activity.body.total, 4, '4 events should be logged for the user');
  assert.equal(activity.body.logs.length, 4);

  const eventNames = activity.body.logs.map((log) => log.event);
  assert.deepEqual(eventNames, ['api_key_revoked', 'api_key_generated', 'login_success', 'login_failed']);
  assert.equal(activity.body.logs[0].ip, '203.0.113.50');
  assert.equal(activity.body.logs[0].user_agent, 'revoker');
  assert.equal(activity.body.logs[1].ip, '203.0.113.40');
  assert.equal(activity.body.logs[2].ip, '203.0.113.30');
  assert.equal(activity.body.logs[2].user_agent, 'Mozilla/5.0');
  assert.equal(activity.body.logs[3].ip, '203.0.113.20', 'failed login IP recorded');
  assert.equal(activity.body.logs[3].user_agent, 'curl/8.5');

  const rawLogs = db.prepare('SELECT event, ip, user_agent FROM auth_logs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC').all(userId);
  assert.deepEqual(rawLogs.map((row) => row.event), ['api_key_revoked', 'api_key_generated', 'login_success', 'login_failed']);

  // Failed login should be stored even though user-facing endpoint only returns owned events.
  const failedLoginCount = db.prepare("SELECT COUNT(*) AS count FROM auth_logs WHERE event = 'login_failed' AND user_id = ?").get(userId).count;
  assert.equal(failedLoginCount, 1, 'failed login is recorded');
});

test('auth activity endpoint is private and filters events', async () => {
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'user-agent': 'filter-check', 'x-forwarded-for': '203.0.113.60' },
    body: JSON.stringify({ identifier: 'activityuser', password: 'password-123' }),
  });
  assert.equal(login.status, 200);
  const token = login.body.token;

  const missing = await request('/api/users/me/activity');
  assert.equal(missing.status, 401);

  const filtered = await request('/api/users/me/activity?event=login_success', {
    headers: auth(token),
  });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.total, 2);
  assert.ok(filtered.body.logs.every((log) => log.event === 'login_success'));

  const invalidFilter = await request('/api/users/me/activity?event=bogus', {
    headers: auth(token),
  });
  assert.equal(invalidFilter.status, 400);
});
