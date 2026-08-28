const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = ':memory:';

const Digiflazz = require('../src/providers/digiflazz');
const config = require('../src/config');

test('Digiflazz provider - daftarHarga includes prepaid command and deposit uses bank field', async () => {
  const requests = [];
  const mockServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { ok: true } }));
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const { port } = mockServer.address();
  const originalEndpoint = config.digiflazz.endpoint;
  config.digiflazz.endpoint = `http://127.0.0.1:${port}`;

  try {
    const digi = new Digiflazz('user', 'key');
    await digi.daftarHarga();
    await digi.deposit(100000, 'BCA', 'Jayadana');

    assert.equal(requests[0].path, '/price-list');
    assert.equal(requests[0].body.cmd, 'prepaid');
    assert.equal(requests[1].path, '/deposit');
    assert.equal(requests[1].body.bank, 'BCA');
    assert.equal(Object.hasOwn(requests[1].body, 'Bank'), false);
  } finally {
    config.digiflazz.endpoint = originalEndpoint;
    await new Promise((resolve) => mockServer.close(resolve));
  }
});

test('Digiflazz provider - constructor validates required fields', () => {
  assert.throws(() => new Digiflazz(), /username.*required/i);
  assert.throws(() => new Digiflazz('user'), /apiKey.*required/i);
});

test('Digiflazz provider - generates correct MD5 signature for cekSaldo', async () => {
  const mockServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    const expectedSign = crypto
      .createHash('md5')
      .update('testuser' + 'testkey' + 'depo')
      .digest('hex');

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        deposit: 500000,
        sign: body.sign,
      },
    }));
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const { port } = mockServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const originalEndpoint = config.digiflazz.endpoint;
  config.digiflazz.endpoint = baseUrl;

  try {
    const digi = new Digiflazz('testuser', 'testkey');
    const result = await digi.cekSaldo();

    assert.equal(result.deposit, 500000);
    assert.equal(result.sign, crypto.createHash('md5').update('testuser' + 'testkey' + 'depo').digest('hex'));
  } finally {
    config.digiflazz.endpoint = originalEndpoint;
    await new Promise((resolve) => mockServer.close(resolve));
  }
});

test('Digiflazz provider - transaksi sends correct fields and sign', async () => {
  let capturedBody = null;
  const mockServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    capturedBody = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { status: 'Sukses', rc: '00' } }));
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const { port } = mockServer.address();

  const originalEndpoint = config.digiflazz.endpoint;
  config.digiflazz.endpoint = `http://127.0.0.1:${port}`;

  try {
    const digi = new Digiflazz('myuser', 'mykey');
    await digi.transaksi('SKU123', '08123456789', 'ref123');

    assert.equal(capturedBody.username, 'myuser');
    assert.equal(capturedBody.buyer_sku_code, 'SKU123');
    assert.equal(capturedBody.customer_no, '08123456789');
    assert.equal(capturedBody.ref_id, 'ref123');
    assert.equal(capturedBody.sign, crypto.createHash('md5').update('myuser' + 'mykey' + 'ref123').digest('hex'));
  } finally {
    config.digiflazz.endpoint = originalEndpoint;
    await new Promise((resolve) => mockServer.close(resolve));
  }
});

test('Digiflazz provider - webhook validates HMAC signature correctly', () => {
  const digi = new Digiflazz('user', 'key', 'webhook-secret');
  const payload = { data: { ref_id: '123', status: 'Sukses' } };
  const body = JSON.stringify(payload);

  const validSignature = 'sha1=' + crypto
    .createHmac('sha1', 'webhook-secret')
    .update(body)
    .digest('hex');

  const invalidSignature = 'sha1=invalid';

  const validReq = {
    headers: {
      'x-hub-signature': validSignature,
      'x-digiflazz-event': 'create',
    },
    body: payload,
  };

  const invalidReq = {
    headers: {
      'x-hub-signature': invalidSignature,
    },
    body: payload,
  };

  assert.equal(digi.verifyWebhookSignature(validReq), true);
  assert.equal(digi.verifyWebhookSignature(invalidReq), false);
});

test('Digiflazz provider - handles API errors gracefully (no TypeError on missing data)', async () => {
  const mockServer = http.createServer(async (_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const { port } = mockServer.address();

  const originalEndpoint = config.digiflazz.endpoint;
  config.digiflazz.endpoint = `http://127.0.0.1:${port}`;

  try {
    const digi = new Digiflazz('user', 'key');
    await assert.rejects(
      () => digi.cekSaldo(),
      (err) => {
        // Should throw DigiflazzError, not TypeError
        assert.equal(err.name, 'DigiflazzError');
        assert.match(err.message, /API error|failed/i);
        return true;
      }
    );
  } finally {
    config.digiflazz.endpoint = originalEndpoint;
    await new Promise((resolve) => mockServer.close(resolve));
  }
});

test('Digiflazz provider - network error throws DigiflazzError', async () => {
  const originalEndpoint = config.digiflazz.endpoint;
  config.digiflazz.endpoint = 'http://127.0.0.1:1'; // unreachable

  try {
    const digi = new Digiflazz('user', 'key');
    await assert.rejects(
      () => digi.cekSaldo(),
      (err) => {
        assert.equal(err.name, 'DigiflazzError');
        return true;
      }
    );
  } finally {
    config.digiflazz.endpoint = originalEndpoint;
  }
});
