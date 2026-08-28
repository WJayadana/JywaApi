const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');

const db = require('../src/db');
const { bcryptRounds } = require('../src/config');

const username = (process.env.OWNER_USERNAME || '').trim().toLowerCase();
const email = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
const phone = (process.env.OWNER_PHONE || '').trim();
const password = process.env.OWNER_PASSWORD || '';

if (!username || !email || !phone || !password) {
  throw new Error('OWNER_USERNAME, OWNER_EMAIL, OWNER_PHONE, and OWNER_PASSWORD are required');
}
if (password.length < 8) throw new Error('OWNER_PASSWORD must be at least 8 characters');

const existing = db.prepare('SELECT id, username, email FROM users WHERE username = ? OR email = ?')
  .get(username, email);
if (existing) {
  throw new Error(`user already exists (${existing.username || existing.email}); refusing to overwrite`);
}

const passwordHash = bcrypt.hashSync(password, bcryptRounds);
const id = randomUUID();
db.prepare(
  `INSERT INTO users (id, username, email, phone, password_hash, role)
   VALUES (?, ?, ?, ?, ?, 'owner')`
).run(id, username, email, phone, passwordHash);

console.log(`Owner created: ${username} (${id})`);
