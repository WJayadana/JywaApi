const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jywa-pricing-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-jwt-tests-123456';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.DIGIFLAZZ_USERNAME = 'digiuser';
process.env.DIGIFLAZZ_API_KEY = 'digikey';
process.env.DIGIFLAZZ_WEBHOOK_SECRET = 'hooksecret';
process.env.DIGIFLAZZ_CACHE_PATH = path.join(tempDir, 'products.json');

// Seed the cache with one product at price 10000 (so percents are easy to verify)
const cacheFile = process.env.DIGIFLAZZ_CACHE_PATH;
fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
fs.writeFileSync(cacheFile, JSON.stringify({
  prepaid: {
    last_updated: 1700000000000,
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

const pricelist = require('../src/services/pricelist');

test('readFromCache: includes harga_modal plus a per-role harga map', () => {
  const products = pricelist.readFromCache({ cmd: 'prepaid' });
  assert.equal(products.length, 1);
  const p = products[0];
  assert.equal(p.harga_modal, 10000, 'harga_modal = raw Digiflazz price');
  assert.ok(p.harga && typeof p.harga === 'object', 'products include per-role harga map');
  assert.equal(p.harga.owner, 10000, 'owner = no markup');
  assert.equal(p.harga.bronze, 10300, 'bronze = +3 percent');
  assert.equal(p.harga.silver, 10200, 'silver = +2 percent');
  assert.equal(p.harga.gold, 10100, 'gold = +1 percent');
  assert.equal(p.harga.reseller, 10050, 'reseller = +50 flat');
});

test('markup rounds UP to whole rupiah on odd modal prices', () => {
  // 10333 * 1.03 = 10642.99 → ceil = 10643
  const { computeHarga } = pricelist;
  const harga = computeHarga(10333);
  assert.equal(harga.owner, 10333);
  assert.equal(harga.bronze, 10643);
  assert.equal(harga.silver, 10540);  // 10333 * 1.02 = 10539.66 → 10540
  assert.equal(harga.gold, 10437);    // 10333 * 1.01 = 10436.33 → 10437
  assert.equal(harga.reseller, 10383);
});

test('readFromCache with role filter returns only that role price as harga', () => {
  const products = pricelist.readFromCache({ cmd: 'prepaid', role: 'bronze' });
  const p = products[0];
  assert.equal(p.harga, 10300, 'harga collapses to a single number for that role');
  assert.equal(p.harga_modal, undefined, 'harga_modal hidden for non-owner roles');
});

test('readFromCache role owner keeps harga_modal visible', () => {
  const products = pricelist.readFromCache({ cmd: 'prepaid', role: 'owner' });
  const p = products[0];
  assert.equal(p.harga, 10000);
  assert.equal(p.harga_modal, 10000, 'owner still sees harga_modal');
});
