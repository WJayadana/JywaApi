/**
 * Transaction auto-retry (status checker) for pending Digiflazz transactions.
 *
 * Digiflazz docs: a Pending transaction can be re-checked by re-sending the
 * SAME ref_id via /transaction — it is idempotent upstream and will never
 * create a duplicate purchase. We exploit that as a status poll.
 *
 * Safety rules:
 * - Only transactions with status 'pending' are ever checked.
 * - Success → mark success + sn (money already debited — nothing to do).
 * - Gagal   → mark failed + refund EXACTLY once (guarded by idempotent
 *             UPDATE ... WHERE status = 'pending').
 * - Still pending after RETRY_MAX_CHECKS → leave as pending (unknown outcome;
 *   never auto-refund an unknown — owner resolves manually).
 *
 * Config (env):
 *   RETRY_MAX_CHECKS      max re-checks per transaction (default 5)
 *   RETRY_CHECK_DELAY_MS  delay between checks (default 60000 = 1 min)
 */

const db = require('../db');
const config = require('../config');
const { applyBalance } = require('../balance');
const Digiflazz = require('../providers/digiflazz');
const { dispatch } = require('./webhook-reseller');

const MAX_CHECKS = Number(process.env.RETRY_MAX_CHECKS) || 5;
const CHECK_DELAY_MS = Number(process.env.RETRY_CHECK_DELAY_MS) || 60_000;

// In-memory guard: refIds currently being watched (avoid double watchers)
const watching = new Set();

function client() {
  return new Digiflazz(
    config.digiflazz.username,
    config.digiflazz.apiKey,
    config.digiflazz.webhookSecret
  );
}

function providerResult(data) {
  const payload = data && data.data && typeof data.data === 'object' ? data.data : data;
  return payload && typeof payload === 'object' ? payload : {};
}

function normalizeStatus(data) {
  const p = providerResult(data);
  const status = String(p.status || '').toLowerCase();
  const rc = p.rc === undefined || p.rc === null ? null : String(p.rc);
  if (rc === '00' || status === 'sukses' || status === 'success') return 'success';
  if (status === 'gagal' || status === 'failed') return 'failed';
  return 'pending';
}

function publicTransaction(row) {
  if (!row) return null;
  return {
    id: row.id,
    ref_id: row.ref_id,
    sku: row.sku,
    customer_no: row.customer_no,
    harga: row.harga,
    status: row.status,
    ...(row.sn ? { sn: row.sn } : {}),
    ...(row.provider_rc ? { provider_rc: row.provider_rc } : {}),
    ...(row.provider_msg ? { message: row.provider_msg } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Resolve a pending transaction based on a provider response.
 * Idempotent: both branches gate on status='pending' so a concurrent
 * webhook/poller can never double-apply.
 * @returns {'success'|'failed'|'pending'} the resolved status
 */
function resolveTransaction(txnId, upstream) {
  const p = providerResult(upstream);
  const outcome = normalizeStatus(upstream);
  const rc = p.rc === undefined || p.rc === null ? null : String(p.rc);
  const msg = p.message || p.msg || null;
  const sn = p.sn || p.serial_number || null;

  if (outcome === 'success') {
    const updated = db.prepare(
      `UPDATE transactions SET status = 'success', sn = ?, provider_rc = ?, provider_msg = ?,
              updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'`
    ).run(sn, rc, msg, txnId);
    if (updated.changes > 0) {
      const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
      dispatch(txn.user_id, 'transaction.update', publicTransaction(txn));
    }
    return 'success';
  }

  if (outcome === 'failed') {
    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
    if (!txn) return 'failed';
    // Idempotent lock: flip pending → failed first; only the winner refunds.
    const updated = db.prepare(
      `UPDATE transactions SET status = 'failed', provider_rc = ?, provider_msg = ?,
              updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'`
    ).run(rc, msg || 'transaction failed', txnId);
    if (updated.changes > 0) {
      db.transaction(() => {
        applyBalance(txn.user_id, {
          type: 'refund',
          direction: '+',
          amount: txn.harga,
          note: `Refund transaksi ${txn.ref_id}`,
          refId: txn.ref_id,
        });
      })();
      const fresh = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
      dispatch(txn.user_id, 'transaction.update', publicTransaction(fresh));
    }
    return 'failed';
  }

  return 'pending';
}

/**
 * Watch a pending transaction: re-check Digiflazz every CHECK_DELAY_MS with
 * the same ref_id (idempotent per Digiflazz docs) until it resolves or
 * MAX_CHECKS is exhausted. Fire-and-forget.
 */
function watchPendingTransaction(txnId) {
  if (watching.has(txnId)) return;
  watching.add(txnId);

  (async () => {
    try {
      for (let attempt = 1; attempt <= MAX_CHECKS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, CHECK_DELAY_MS));

        const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
        if (!txn || txn.status !== 'pending') return; // resolved elsewhere

        let upstream;
        try {
          // Same ref_id → Digiflazz treats this as a status check, never a new purchase.
          upstream = await client().transaksi(txn.sku, txn.customer_no, txn.ref_id);
        } catch (error) {
          // Network/provider hiccup — keep the watcher alive for the next attempt.
          console.error(`[txn-retry] check ${attempt}/${MAX_CHECKS} failed for ${txn.ref_id}: ${error.message}`);
          continue;
        }

        const outcome = resolveTransaction(txnId, upstream);
        if (outcome !== 'pending') {
          console.log(`[txn-retry] ${txn.ref_id} resolved: ${outcome} (check ${attempt}/${MAX_CHECKS})`);
          return;
        }
      }
      const txn = db.prepare('SELECT ref_id FROM transactions WHERE id = ?').get(txnId);
      console.warn(`[txn-retry] ${txn ? txn.ref_id : txnId} still pending after ${MAX_CHECKS} checks — left for manual resolution`);
    } finally {
      watching.delete(txnId);
    }
  })().catch((error) => {
    watching.delete(txnId);
    console.error(`[txn-retry] watcher crashed for ${txnId}: ${error.message}`);
  });
}

/**
 * On boot: resume watching any transaction stuck in 'pending' (e.g. process
 * restarted while a watcher was running).
 */
function resumePendingWatchers() {
  if (process.env.NODE_ENV === 'test') return;
  const rows = db.prepare("SELECT id FROM transactions WHERE status = 'pending'").all();
  for (const row of rows) watchPendingTransaction(row.id);
  if (rows.length) console.log(`[txn-retry] resumed ${rows.length} pending watcher(s)`);
}

module.exports = { watchPendingTransaction, resumePendingWatchers, resolveTransaction };
