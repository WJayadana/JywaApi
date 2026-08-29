const fs = require('node:fs');
const path = require('node:path');

const Digiflazz = require('../providers/digiflazz');
const { DigiflazzError } = require('../providers/digiflazz');
const config = require('../config');

/**
 * Price list cache backed by a JSON file (atomic write).
 *
 * Digiflazz rate-limits price-list strongly (≈5 minutes), so we never hit
 * upstream from the read path. The scheduler (or a manual refresh) pulls
 * upstream and writes the result to a JSON file on disk. Reads serve from
 * that file directly.
 *
 * File layout:
 * {
 *   "prepaid": { "last_updated": <epoch ms>, "products": [...] },
 *   "pasca":   { "last_updated": <epoch ms>, "products": [...] }
 * }
 */

const DEFAULT_CACHE_PATH = path.join(__dirname, '..', '..', 'data', 'products.json');

function cachePath() {
  return config.digiflazz.cachePath || process.env.DIGIFLAZZ_CACHE_PATH || DEFAULT_CACHE_PATH;
}

function emptyStore() {
  return { prepaid: { last_updated: null, products: [] }, pasca: { last_updated: null, products: [] } };
}

function readStore() {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      prepaid: parsed.prepaid || { last_updated: null, products: [] },
      pasca: parsed.pasca || { last_updated: null, products: [] },
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  const file = cachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file); // atomic
}

/**
 * Panggil Digiflazz daftar harga, lalu simpan ke JSON cache.
 * Jika upstream mengembalikan error (rc != 00 / non-array), cache lama DIPERTAHANKAN.
 * @param {string} cmd - 'prepaid' | 'pasca'
 * @returns {Promise<number>} jumlah produk baru
 */
async function fetchAndStore(cmd = 'prepaid') {
  const digi = new Digiflazz(config.digiflazz.username, config.digiflazz.apiKey);
  const raw = await digi.daftarHarga(cmd);

  // Digiflazz wraps errors as { rc, message } instead of throwing (HTTP 200).
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.rc && raw.rc !== '00') {
    throw new DigiflazzError(`Digiflazz price-list error (rc=${raw.rc}): ${raw.message || 'unknown'}`, {
      code: 'DIGIFLAZZ_RC',
      data: raw,
    });
  }

  const items = Array.isArray(raw) ? raw : [];
  const store = readStore();
  store[cmd] = { last_updated: Date.now(), products: items };
  writeStore(store);
  return items.length;
}

/**
 * Baca produk dari JSON cache. Tidak pernah menyentuh upstream.
 * @param {object} [filters] - { cmd, category, search, status }
 * @returns {Array<object>}
 */
function readFromCache(filters = {}) {
  const store = readStore();
  const cmd = filters.cmd && ['prepaid', 'pasca'].includes(filters.cmd) ? filters.cmd : 'prepaid';
  let products = (store[cmd] && store[cmd].products) || [];

  if (filters.category) {
    products = products.filter((p) => (p.category || '').toLowerCase() === String(filters.category).toLowerCase());
  }
  if (filters.search) {
    const q = String(filters.search).toLowerCase();
    products = products.filter((p) =>
      [p.product_name, p.buyer_sku_code, p.category, p.brand]
        .some((field) => String(field || '').toLowerCase().includes(q))
    );
  }
  if (filters.status !== undefined) {
    const wanted = !!filters.status;
    products = products.filter(
      (p) => p.buyer_product_status === wanted && p.seller_product_status === wanted
    );
  }

  // Sort stable by price asc, then name
  products = [...products].sort((a, b) => {
    const pa = Number(a.price) || 0;
    const pb = Number(b.price) || 0;
    if (pa !== pb) return pa - pb;
    return String(a.product_name || '').localeCompare(String(b.product_name || ''));
  });

  return products;
}

/**
 * Timestamp (epoch ms) terakhir kali setiap cmd berhasil disinkronkan.
 * @param {string} [cmd] - 'prepaid' | 'pasca'
 * @returns {number|null}
 */
function lastUpdated(cmd = 'prepaid') {
  const store = readStore();
  return store[cmd] && store[cmd].last_updated ? store[cmd].last_updated : null;
}

module.exports = { fetchAndStore, readFromCache, lastUpdated };
