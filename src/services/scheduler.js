/**
 * Auto-refresh Digiflazz price list on a fixed interval (default 10 minutes).
 *
 * Round-robin: each tick only fetches ONE cmd (prepaid, then pasca, then prepaid...).
 * This avoids hitting Digiflazz's ~5-minute rate limit by never making two
 * price-list calls back-to-back.
 *
 * If a fetch fails (rate limit, network, rc error), the existing JSON cache
 * is preserved by pricelist.fetchAndStore — it only overwrites on success.
 *
 * Skipped in test environment or when Digiflazz credentials are not configured.
 */

const config = require('../config');
const pricelist = require('./pricelist');
const { pruneOldLogs } = require('./auth-log');
const { pollPendingDeposits } = require('../scheduler/deposit-poller');

let timer = null;
let pruneTimer = null;
let depositTimer = null;
let running = false;
let nextCmd = 'prepaid'; // round-robin state

async function tick() {
  if (running) return;
  if (!config.digiflazz.username || !config.digiflazz.apiKey) return;

  running = true;
  const cmd = nextCmd;
  try {
    const count = await pricelist.fetchAndStore(cmd);
    console.log(`[pricelist] synced ${cmd}: ${count} products`);
  } catch (err) {
    // Cache stays intact — just log and move on
    console.error(`[pricelist] sync ${cmd} failed: ${err.message}`);
  }
  // Flip for next tick
  nextCmd = nextCmd === 'prepaid' ? 'pasca' : 'prepaid';
  running = false;
}

function start() {
  if (timer) return;
  if (process.env.NODE_ENV === 'test') return;
  if (!config.digiflazz.username || !config.digiflazz.apiKey) return;

  const intervalMs = config.digiflazz.refreshIntervalMs;
  console.log(`[pricelist] auto-refresh enabled (every ${intervalMs / 1000}s, round-robin prepaid↔pasca)`);

  // Fire once immediately, then on interval
  tick();
  timer = setInterval(tick, intervalMs);

  // Deposit QRIS status poller (every 15s — api.jywa.app polls GoBiz)
  const depositPollMs = 15_000;
  depositTimer = setInterval(() => { pollPendingDeposits(); }, depositPollMs);
  if (depositTimer.unref) depositTimer.unref();
  console.log(`[deposit-poller] enabled (every ${depositPollMs / 1000}s)`);

  // Daily auth-log retention (90 days)
  pruneTimer = setInterval(() => {
    try {
      const removed = pruneOldLogs(90);
      if (removed > 0) console.log(`[auth-log] pruned ${removed} old entries`);
    } catch (error) {
      console.error(`[auth-log] prune failed: ${error.message}`);
    }
  }, 24 * 60 * 60 * 1000);

  // Don't keep the process alive solely for this timer
  if (timer.unref) timer.unref();
  if (pruneTimer.unref) pruneTimer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  if (depositTimer) { clearInterval(depositTimer); depositTimer = null; }
}

module.exports = { start, stop, tick };
