const { randomUUID } = require('crypto');
const db = require('./db');

/**
 * Atomically apply a balance change and record an audit mutation.
 * direction '+' = credit, '-' = debit. Debits are rejected if they would
 * push the balance below zero.
 *
 * Throws Error('insufficient balance') / Error('user not found').
 * Returns { balance_before, balance_after }.
 */
function applyBalance(userId, { type, direction, amount, note, refId }) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('amount must be a positive integer');
  }
  if (direction !== '+' && direction !== '-') {
    throw new Error("direction must be '+' or '-'");
  }
  return db.transaction(() => {
    const row = db
      .prepare('SELECT balance FROM users WHERE id = ?')
      .get(userId);
    if (!row) throw new Error('user not found');

    const delta = direction === '+' ? amount : -amount;
    const after = row.balance + delta;
    if (after < 0) throw new Error('insufficient balance');

    db.prepare(
      "UPDATE users SET balance = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(after, userId);

    db.prepare(
      `INSERT INTO mutations
       (id, user_id, type, direction, amount, balance_before, balance_after, note, ref_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      userId,
      type,
      direction,
      amount,
      row.balance,
      after,
      note || null,
      refId || null
    );

    return { balance_before: row.balance, balance_after: after };
  })();
}

module.exports = { applyBalance };
