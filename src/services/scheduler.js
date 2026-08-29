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

let timer = null;
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

  // Don't keep the process alive solely for this timer
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick };
