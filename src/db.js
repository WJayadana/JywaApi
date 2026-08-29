const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { dbPath } = require('./config');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  phone         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'bronze'
                CHECK (role IN ('owner','bronze','silver','gold','reseller')),
  balance       INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended','banned')),
  api_key       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mutations (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('deposit','pembelian','refund')),
  direction      TEXT NOT NULL CHECK (direction IN ('+','-')),
  amount         INTEGER NOT NULL CHECK (amount > 0),
  balance_before INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL,
  note           TEXT,
  ref_id         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_mutations_user ON mutations(user_id);
CREATE INDEX IF NOT EXISTS idx_mutations_created ON mutations(created_at);

CREATE TABLE IF NOT EXISTS transactions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ref_id         TEXT NOT NULL,
  sku            TEXT NOT NULL,
  customer_no    TEXT NOT NULL,
  harga          INTEGER NOT NULL,
  harga_modal    INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','success','failed','refunded')),
  sn             TEXT,
  provider_rc    TEXT,
  provider_msg   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
`);

module.exports = db;
