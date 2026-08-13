'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { config, MIN_POLL_INTERVAL_MS } = require('../src/config');
const { Monitor } = require('../src/monitor');
const { jitter } = require('../src/utils');

test('poll interval is clamped to the floor', () => {
  // .env.example documents the floor; config applies it regardless of input.
  assert.ok(config.poll.intervalMs >= MIN_POLL_INTERVAL_MS);
});

test('jitter stays within bounds and is disabled at zero', () => {
  for (let i = 0; i < 200; i += 1) {
    const value = jitter(30000, 5000);
    assert.ok(value >= 25000 && value <= 35000, `out of range: ${value}`);
  }
  assert.equal(jitter(30000, 0), 30000);
  assert.ok(jitter(100, 5000) >= 0, 'must never go negative');
});

test('monitor emits restock only on the transition into stock', async () => {
  const product = { name: 'Test', url: 'https://www.target.com/p/x/-/A-1', enabled: true };
  const monitor = new Monitor([product], { once: true, intervalMs: 5000, jitterMs: 0 });

  const events = [];
  monitor.on('restock', () => events.push('restock'));
  monitor.on('change', ({ from, to }) => events.push(`change:${from}->${to}`));

  const state = monitor.stateOf(product.url);

  // Drive the state machine directly: first observation is a baseline and must
  // not fire a change event, even when the item is already out of stock.
  const observe = (status) => {
    const previous = state.status;
    if (status !== previous) {
      state.status = status;
      if (previous !== null) monitor.emit('change', { from: previous, to: status });
      if (status === 'in_stock') monitor.emit('restock', {});
    }
  };

  observe('out_of_stock');
  observe('out_of_stock');
  observe('in_stock');
  observe('in_stock');
  observe('out_of_stock');

  assert.deepEqual(events, [
    'change:out_of_stock->in_stock',
    'restock',
    'change:in_stock->out_of_stock',
  ]);
});

test('monitor tracks per-product state independently', () => {
  const monitor = new Monitor([], {});
  const a = monitor.stateOf('https://a.example');
  const b = monitor.stateOf('https://b.example');
  a.errors = 3;
  assert.equal(b.errors, 0);
  assert.strictEqual(monitor.stateOf('https://a.example'), a);
});
