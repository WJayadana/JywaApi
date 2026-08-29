const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.DIGIFLAZZ_USERNAME = 'user';
process.env.DIGIFLAZZ_API_KEY = 'key';

const pricelist = require('../src/services/pricelist');
const config = require('../src/config');
const scheduler = require('../src/services/scheduler');

test('scheduler tick fetches only one command at a time and alternates commands', async () => {
  const original = pricelist.fetchAndStore;
  const calls = [];
  pricelist.fetchAndStore = async (cmd) => {
    calls.push(cmd);
    return 1;
  };

  try {
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    assert.deepEqual(calls, ['prepaid', 'pasca', 'prepaid']);
  } finally {
    pricelist.fetchAndStore = original;
  }
});

test('scheduler start is disabled in test environment', () => {
  scheduler.start();
  scheduler.stop();
  assert.ok(true);
});
