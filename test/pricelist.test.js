const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jywa-pricelist-json-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.DIGIFLAZZ_USERNAME = 'user';
process.env.DIGIFLAZZ_API_KEY = 'key';
process.env.DIGIFLAZZ_CACHE_PATH = path.join(tempDir, 'products.json');

const config = require('../src/config');

// Mock Digiflazz price-list endpoint
let mockServer;
let mockCallCount = 0;

test.before(async () => {
  mockServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    mockCallCount++;

    const expectedSign = crypto.createHash('md5').update('user' + 'key' + 'pricelist').digest('hex');
    if (body.sign !== expectedSign) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { rc: '41', message: 'Invalid signature' } }));
      return;
    }

    const products = [
      { buyer_sku_code: 'xld25', product_name: 'XL Data 25K', category: 'Data', price: 25000, buyer_product_status: true, seller_product_status: true },
      { buyer_sku_code: 'tsel10', product_name: 'Telkomsel 10K', category: 'Pulsa', price: 10500, buyer_product_status: true, seller_product_status: true },
      { buyer_sku_code: 'plnpasca', product_name: 'PLN Pascabayar', category: 'Pascabayar', price: 0, buyer_product_status: true, seller_product_status: true },
    ];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: products }));
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  config.digiflazz.endpoint = `http://127.0.0.1:${mockServer.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => mockServer.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('JSON cache: fetchAndStore writes upstream to JSON, readFromCache serves with filters without re-hitting upstream', async () => {
  const { fetchAndStore, readFromCache } = require('../src/services/pricelist');

  await fetchAndStore('prepaid');
  assert.equal(mockCallCount, 1);

  // Read with no filter — no new upstream call
  const products = readFromCache({ cmd: 'prepaid' });
  assert.equal(products.length, 3);
  assert.equal(mockCallCount, 1);

  // Filters
  assert.equal(readFromCache({ cmd: 'prepaid', category: 'Data' }).length, 1);
  assert.equal(readFromCache({ cmd: 'prepaid', search: 'Telkomsel' })[0].product_name, 'Telkomsel 10K');
  assert.equal(readFromCache({ cmd: 'prepaid', status: true }).length, 3);
  assert.equal(readFromCache({ cmd: 'prepaid', search: 'pln' })[0].buyer_sku_code, 'plnpasca');

  // Re-fetch does not duplicate (JSON overwrites the cmd bucket)
  await fetchAndStore('prepaid');
  assert.equal(readFromCache({ cmd: 'prepaid' }).length, 3);

  // JSON file exists and is the source of truth (no DB products table filled)
  assert.ok(fs.existsSync(process.env.DIGIFLAZZ_CACHE_PATH));
});

test('JSON cache: rc error preserves existing cache (does not wipe)', async () => {
  const { fetchAndStore, readFromCache } = require('../src/services/pricelist');

  // First successful fetch (3 products)
  await fetchAndStore('prepaid');
  assert.equal(readFromCache({ cmd: 'prepaid' }).length, 3);

  // Now produce an rc error from upstream
  const originalEndpoint = config.digiflazz.endpoint;
  const errorServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { rc: '83', message: 'limit slot' } }));
  });
  await new Promise((resolve) => errorServer.listen(0, '127.0.0.1', resolve));
  config.digiflazz.endpoint = `http://127.0.0.1:${errorServer.address().port}`;

  try {
    await assert.rejects(() => fetchAndStore('prepaid'), (err) => err.name === 'DigiflazzError');
    // Cache remains intact with old 3 products
    assert.equal(readFromCache({ cmd: 'prepaid' }).length, 3);
  } finally {
    config.digiflazz.endpoint = originalEndpoint;
    await new Promise((resolve) => errorServer.close(resolve));
  }
});
