/**
 * Polls api.jywa.app for pending deposit statuses.
 * Runs every 15s via scheduler.js.
 */

const db = require('../db');
const gobiz = require('../services/gobiz-client');
const crypto = require('node:crypto');

async function pollPendingDeposits() {
  const pending = db.prepare(`
    SELECT id, gobiz_payment_id, user_id, amount, expected_amount
    FROM deposits WHERE status = 'pending'
  `).all();

  if (!pending.length) return;

  for (const dep of pending) {
    try {
      const payment = await gobiz.getPayment(dep.gobiz_payment_id);
      if (!payment) continue;

      const { status, paid_at } = payment;
      if (status === 'paid') {
        creditDeposit(dep, paid_at);
      } else if (status === 'expired' || status === 'cancelled') {
        db.prepare('UPDATE deposits SET status = ? WHERE id = ?').run(status, dep.id);
      }
    } catch (err) {
      console.error(`[deposit-poller] error for ${dep.gobiz_payment_id}: ${err.message}`);
    }
  }
}

function creditDeposit(deposit, paidAt) {
  const runTx = db.transaction(() => {
    const user = db.prepare('SELECT id, balance FROM users WHERE id = ?').get(deposit.user_id);
    if (!user) return;
    const bb = user.balance || 0;
    db.prepare("UPDATE deposits SET status = 'paid', paid_at = ? WHERE id = ?").run(paidAt, deposit.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(deposit.amount, deposit.user_id);
    db.prepare(`INSERT INTO mutations (id, user_id, type, direction, amount, balance_before, balance_after, note) VALUES (?,?,?,?,?,?,?,?)`).run(
      crypto.randomUUID(), deposit.user_id, 'deposit', '+', deposit.amount, bb, bb + deposit.amount,
      `QRIS Deposit ${deposit.expected_amount} → credited (gobiz: ${deposit.gobiz_payment_id})`
    );
    db.prepare("UPDATE deposits SET status = 'credited', credited_at = datetime('now') WHERE id = ?").run(deposit.id);
  });
  runTx();
  console.log(`[deposit-poller] credited deposit ${deposit.id}: +${deposit.amount} to user ${deposit.user_id}`);
}

module.exports = { pollPendingDeposits };
