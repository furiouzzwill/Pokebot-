'use strict';

/**
 * Exercises the dashboard server end to end: a fake dashboard client and a
 * fake extension client on the real WebSocket hub, driving real state.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Point state at a scratch file so a test run can't touch a real watchlist.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pokebot-test-'));
process.env.POKEBOT_PORT = '0';

const stateModule = require.resolve('../app/state');
const configDir = path.resolve(__dirname, '..', 'config');
const realState = path.join(configDir, 'app-state.json');
const backup = fs.existsSync(realState) ? fs.readFileSync(realState) : null;

let WebSocket;
let server;
let port;

test.before(async () => {
  ({ WebSocket } = require('ws'));
  if (fs.existsSync(realState)) fs.unlinkSync(realState);
  delete require.cache[stateModule];
  ({ server } = require('../app/server'));
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  port = server.address().port;
});

test.after(() => {
  server.close();
  if (backup) fs.writeFileSync(realState, backup);
  else if (fs.existsSync(realState)) fs.unlinkSync(realState);
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Connect a client and collect messages, with a helper to await one. */
function client(role) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const received = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    received.push(message);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].match(message)) {
        waiters[i].resolve(message);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    ws,
    received,
    ready: new Promise((resolve) => ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role }));
      resolve();
    })),
    send: (message) => ws.send(JSON.stringify(message)),
    next: (match, timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        const found = received.find(match);
        if (found) return resolve(found);
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
      }),
    close: () => ws.close(),
  };
}

test('dashboard receives state on connect', async () => {
  const dash = client('dashboard');
  await dash.ready;
  const state = await dash.next((m) => m.type === 'state');
  assert.ok(Array.isArray(state.watchlist));
  assert.equal(typeof state.settings.armed, 'boolean');
  dash.close();
});

test('adding a product pushes it to the extension as a watch instruction', async () => {
  const dash = client('dashboard');
  const ext = client('extension');
  await Promise.all([dash.ready, ext.ready]);

  dash.send({
    type: 'addItem',
    url: 'https://www.target.com/p/pokemon-etb/-/A-93954435',
    name: 'Prismatic ETB',
  });

  const sync = await ext.next((m) => m.type === 'sync' && m.watchlist.length > 0);
  assert.equal(sync.watchlist[0].name, 'Prismatic ETB');
  assert.equal(sync.watchlist[0].site, 'target');
  assert.ok(sync.watchlist[0].id);

  dash.close();
  ext.close();
});

test('a URL from an unsupported site is rejected with an error', async () => {
  const dash = client('dashboard');
  await dash.ready;
  dash.send({ type: 'addItem', url: 'https://www.bestbuy.com/site/thing/12345.p' });
  const error = await dash.next((m) => m.type === 'error');
  assert.match(error.message, /No adapter/);
  dash.close();
});

test('a duplicate URL is rejected', async () => {
  const dash = client('dashboard');
  await dash.ready;
  const url = 'https://www.walmart.com/ip/pokemon-bundle/1122334455';
  dash.send({ type: 'addItem', url });
  await dash.next((m) => m.type === 'state' && m.watchlist.some((i) => i.url === url));
  dash.send({ type: 'addItem', url });
  const error = await dash.next((m) => m.type === 'error');
  assert.match(error.message, /already on the watchlist/);
  dash.close();
});

test('extension events land in history and reach the dashboard', async () => {
  const dash = client('dashboard');
  const ext = client('extension');
  await Promise.all([dash.ready, ext.ready]);

  const url = 'https://www.target.com/p/pokemon-etb/-/A-93954435';
  ext.send({ type: 'event', kind: 'carted', detail: 'Clicked Add to cart at $24.99', url, site: 'target' });

  const event = await dash.next((m) => m.type === 'event' && m.entry.kind === 'carted');
  assert.match(event.entry.detail, /24\.99/);
  // Matched back to the watchlist item added earlier, so the UI can label it.
  assert.equal(event.entry.name, 'Prismatic ETB');

  dash.close();
  ext.close();
});

test('placeOrder cannot be enabled without autoCheckout', async () => {
  const dash = client('dashboard');
  await dash.ready;
  dash.send({ type: 'setSettings', settings: { placeOrder: true, autoCheckout: false } });
  const state = await dash.next(
    (m) => m.type === 'state' && m.settings.placeOrder === false,
  );
  assert.equal(state.settings.placeOrder, false);
  dash.close();
});

test('settings changes are pushed down to the extension', async () => {
  const dash = client('dashboard');
  const ext = client('extension');
  await Promise.all([dash.ready, ext.ready]);

  dash.send({ type: 'setSettings', settings: { autoCheckout: true, placeOrder: true, maxOrderTotal: 90 } });
  const sync = await ext.next((m) => m.type === 'sync' && m.settings.maxOrderTotal === 90);
  assert.equal(sync.settings.placeOrder, true);

  dash.close();
  ext.close();
});

test('disabled items are not sent to the extension', async () => {
  const dash = client('dashboard');
  const ext = client('extension');
  await Promise.all([dash.ready, ext.ready]);

  const state = await dash.next((m) => m.type === 'state' && m.watchlist.length > 0);
  const target = state.watchlist[0];

  dash.send({ type: 'toggleItem', id: target.id, enabled: false });
  const sync = await ext.next(
    (m) => m.type === 'sync' && !m.watchlist.some((i) => i.id === target.id),
  );
  assert.ok(!sync.watchlist.some((i) => i.id === target.id));

  dash.close();
  ext.close();
});

test('removing an item drops it from the watchlist', async () => {
  const dash = client('dashboard');
  await dash.ready;
  const state = await dash.next((m) => m.type === 'state' && m.watchlist.length > 0);
  const victim = state.watchlist[0];

  dash.send({ type: 'removeItem', id: victim.id });
  const after = await dash.next(
    (m) => m.type === 'state' && !m.watchlist.some((i) => i.id === victim.id),
  );
  assert.ok(!after.watchlist.some((i) => i.id === victim.id));
  dash.close();
});

test('serves the dashboard page', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<title>Pokebot<\/title>/);
});

test('refuses to serve files outside the public directory', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/../state.js`);
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
});
