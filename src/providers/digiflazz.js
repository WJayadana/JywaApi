const crypto = require('node:crypto');
const config = require('../config');

/**
 * DigiflazzError — raised for any upstream/API/network failure so callers
 * get a predictable error type instead of raw fetch TypeErrors.
 */
class DigiflazzError extends Error {
  constructor(message, { code = null, data = null, status = null } = {}) {
    super(message);
    this.name = 'DigiflazzError';
    if (code) this.code = code;
    if (data) this.data = data;
    if (status) this.status = status;
    Error.captureStackTrace(this, DigiflazzError);
  }
}

/**
 * Digiflazz API client (PPOB provider). Uses the native fetch (Node 18+).
 *
 * Reference: https://developer.digiflazz.com/api/buyer/
 */
class Digiflazz {
  /**
   * @param {string} username - Digiflazz API username
   * @param {string} apiKey    - Digiflazz API key
   * @param {string} [webhookSecret] - HMAC-SHA1 secret for webhook verification
   * @param {object} [options] - { endpoint, timeoutMs }
   */
  constructor(username, apiKey, webhookSecret = null, options = {}) {
    if (!username) throw new DigiflazzError('Digiflazz username is required');
    if (!apiKey) throw new DigiflazzError('Digiflazz apiKey is required');

    this._user = username;
    this._key = apiKey;
    this._webhookSecret = webhookSecret;
    this._endpoint = (options.endpoint || config.digiflazz.endpoint).replace(/\/+$/, '');
    this._timeoutMs = options.timeoutMs || config.digiflazz.timeoutMs;
  }

  _sign(text) {
    return crypto.createHash('md5').update(text).digest('hex');
  }

  async _request(uri, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);

    let response;
    try {
      response = await fetch(uri, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new DigiflazzError(`Digiflazz network error: ${error.message}`, { code: 'NETWORK' });
    }
    clearTimeout(timer);

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new DigiflazzError('Digiflazz returned non-JSON response', {
        code: 'BAD_RESPONSE',
        status: response.status,
      });
    }

    if (!response.ok) {
      throw new DigiflazzError(
        `Digiflazz API error (HTTP ${response.status})`,
        { code: 'HTTP_ERROR', data: payload, status: response.status }
      );
    }

    // Digiflazz wraps successful responses in { data: ... }. Return data directly.
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return payload.data;
    }
    return payload;
  }

  /** Cek saldo deposit. Secrets: md5(username + apiKey + 'depo'). */
  async cekSaldo() {
    return this._request(`${this._endpoint}/cek-saldo`, {
      cmd: 'deposit',
      username: this._user,
      sign: this._sign(`${this._user}${this._key}depo`),
    });
  }

  /**
   * Daftar harga. Secrets: md5(username + apiKey + 'pricelist').
   * @param {string} [cmd] - 'prepaid' (default) or 'pasca'
   */
  async daftarHarga(cmd = 'prepaid') {
    const body = {
      cmd,
      username: this._user,
      sign: this._sign(`${this._user}${this._key}pricelist`),
    };
    return this._request(`${this._endpoint}/price-list`, body);
  }

  /**
   * Tiket deposit. Secrets: md5(username + apiKey + 'deposit').
   * @param {number} amount - nominal deposit
   * @param {string} bank - BCA/MANDIRI/BRI/BNI (or Flip/ShopeePay)
   * @param {string} name - nama pemilik rekening
   */
  async deposit(amount, bank, name) {
    return this._request(`${this._endpoint}/deposit`, {
      username: this._user,
      amount,
      bank,
      owner_name: name,
      sign: this._sign(`${this._user}${this._key}deposit`),
    });
  }

  /**
   * Transaksi (topup / pascabayar). Secrets: md5(username + apiKey + refId).
   * @param {string} sku       - buyer_sku_code
   * @param {string} customer  - customer_no
   * @param {string} refId     - ref_id unik
   * @param {string} [commands] - 'inq-pasca' | 'pay-pasca' | 'status-pasca' | undefined (prepaid)
   * @param {string} [testing]  - 'true'/'false' untuk development
   */
  async transaksi(sku, customer, refId, commands = null, testing = null) {
    const body = {
      username: this._user,
      buyer_sku_code: sku,
      customer_no: customer,
      ref_id: refId,
      sign: this._sign(`${this._user}${this._key}${refId}`),
    };
    if (commands) body.commands = commands;
    if (testing) body.testing = testing;
    return this._request(`${this._endpoint}/transaction`, body);
  }

  /**
   * Verify a Digiflazz webhook HMAC-SHA1 signature.
   * Digiflazz sends `X-Hub-Signature: sha1=<hex>` computed over the raw body.
   * @param {object} reqLike - { headers, rawBody }
   * @returns {boolean}
   */
  verifyWebhookSignature(reqLike) {
    if (!this._webhookSecret) return false;
    const header = reqLike.headers['x-hub-signature'];
    if (!header || typeof header !== 'string') return false;

    const expected = 'sha1=' + crypto
      .createHmac('sha1', this._webhookSecret)
      .update(reqLike.rawBody || JSON.stringify(reqLike.body))
      .digest('hex');

    const received = header.trim();
    if (received.length !== expected.length) return false;

    // constant-time comparison
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}

module.exports = Digiflazz;
module.exports.DigiflazzError = DigiflazzError;
