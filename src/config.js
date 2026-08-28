require('dotenv').config();
const path = require('path');

const ROOT = path.join(__dirname, '..');

const config = {
  port: Number(process.env.PORT) || 3000,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'jywa.db'),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS) || 12,
  allowedRoles: ['owner', 'bronze', 'silver', 'gold', 'reseller'],
  statuses: ['active', 'suspended', 'banned'],
  mutationTypes: ['deposit', 'pembelian', 'refund'],
  mutationDirections: ['+', '-'],
  digiflazz: {
    endpoint: process.env.DIGIFLAZZ_ENDPOINT || 'https://api.digiflazz.com/v1',
    username: process.env.DIGIFLAZZ_USERNAME || '',
    apiKey: process.env.DIGIFLAZZ_API_KEY || '',
    webhookSecret: process.env.DIGIFLAZZ_WEBHOOK_SECRET || '',
    timeoutMs: Number(process.env.DIGIFLAZZ_TIMEOUT_MS) || 30000,
  },
};

if (!config.jwtSecret) {
  throw new Error('JWT_SECRET is not set. Copy .env.example to .env and set a strong secret.');
}

module.exports = config;
