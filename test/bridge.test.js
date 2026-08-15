'use strict';

/**
 * Drives extension/bridge.js against a fake chrome + WebSocket.
 *
 * The bug these pin: connect() awaits storage before opening the socket, and
 * the keepalive alarm calls it every 30s. A second call landing inside that
 * await window opened a duplicate socket and reassigned `socket`, so the first
 * connection's 'open' handler sent `hello` on a socket that was still
 * CONNECTING. That throws, the server never promotes the client to role
 * 'extension' (app/server.js), and the watchlist sync -- broadcast to that role
 * only -- never arrives. No tabs open, and the dashboard shows no extension.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const BRIDGE = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'bridge.js'),
  'utf8',
);

/** Mirrors the real WebSocket's refusal to send before it is OPEN. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    this.handlers = new Map();
    FakeSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  fire(type, event) {
    for (const fn of this.handlers.get(type) || []) fn(event);
  }

  send(data) {
    if (this.readyState !== FakeSocket.OPEN) {
      throw new Error(
        "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
      );
    }
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }
}

/**
 * Loads bridge.js with a storage.local.get we can hold open, so a second
 * connect() can be driven into the await window deliberately.
 */
function loadBridge() {
  FakeSocket.instances = [];
  const alarmListeners = [];
  let releaseStorage;
  const storageGate = new Promise((resolve) => {
    releaseStorage = resolve;
  });

  const tabs = { created: [], removed: [], nextId: 1, live: new Set() };

  const chrome = {
    storage: {
      local: { get: () => storageGate.then(() => ({})) },
      sync: { set: async () => {} },
    },
    tabs: {
      create: async ({ url }) => {
        const id = tabs.nextId++;
        tabs.created.push({ id, url });
        tabs.live.add(id);
        return { id };
      },
      get: async (id) => {
        if (!tabs.live.has(id)) throw new Error('no such tab');
        return { id };
      },
      remove: async (id) => {
        tabs.removed.push(id);
        tabs.live.delete(id);
      },
      onRemoved: { addListener() {} },
    },
    alarms: {
      create() {},
      onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
    },
    runtime: {
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
    },
  };

  const context = vm.createContext({
    chrome,
    WebSocket: FakeSocket,
    console: { log() {} },
    setTimeout() {}, // Reconnect scheduling is not under test.
    JSON,
    Promise,
    Map,
    Error,
    encodeURIComponent,
  });

  vm.runInContext(BRIDGE, context);

  return {
    tabs,
    releaseStorage,
    fireAlarm: () => {
      for (const fn of alarmListeners) fn({ name: 'pokebot-keepalive' });
    },
  };
}

test('the keepalive alarm does not open a second socket mid-connect', async () => {
  const { releaseStorage, fireAlarm } = loadBridge();

  // bridge.js calls connect() on load; it is now parked on storage. The alarm
  // firing here is exactly the 30s tick that used to race it.
  fireAlarm();
  fireAlarm();

  releaseStorage();
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(
    FakeSocket.instances.length,
    1,
    'connect() opened a duplicate socket during its storage await',
  );
});

test('hello is sent, on a socket that is actually open', async () => {
  const { releaseStorage, fireAlarm } = loadBridge();
  fireAlarm();
  releaseStorage();
  await new Promise((resolve) => setImmediate(resolve));

  const socket = FakeSocket.instances[0];
  socket.readyState = FakeSocket.OPEN;
  socket.fire('open');

  assert.deepStrictEqual(JSON.parse(socket.sent[0]), {
    type: 'hello',
    role: 'extension',
  });
});

test("a stale connection's open handler never sends on the current socket", async () => {
  const { releaseStorage, fireAlarm } = loadBridge();
  releaseStorage();
  await new Promise((resolve) => setImmediate(resolve));

  const stale = FakeSocket.instances[0];
  // The first connection drops; the reconnect opens a replacement.
  stale.fire('close');
  fireAlarm();
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(FakeSocket.instances.length, 2, 'expected a reconnect');
  const current = FakeSocket.instances[1];

  // A late 'open' from the dead connection must not touch the new socket,
  // which is still CONNECTING and would throw.
  stale.readyState = FakeSocket.OPEN;
  assert.doesNotThrow(() => stale.fire('open'));

  assert.strictEqual(current.sent.length, 0, 'stale handler wrote to the live socket');
  assert.strictEqual(stale.sent.length, 1);
});

test('drop-window search tabs are opened, kept, and closed with the window', async () => {
  const { tabs, releaseStorage } = loadBridge();
  releaseStorage();
  await new Promise((resolve) => setImmediate(resolve));

  const socket = FakeSocket.instances[0];
  socket.readyState = FakeSocket.OPEN;

  const url = 'https://www.walmart.com/browse/pokemon?sort=new';
  const sync = (searchTabs) => socket.fire('message', {
    data: JSON.stringify({ type: 'sync', watchlist: [], searchTabs }),
  });

  // Window opens.
  sync([url]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(tabs.created.map((t) => t.url), [url]);

  // A re-sync while it is still open must not stack up duplicate tabs.
  sync([url]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(tabs.created.length, 1, 'opened the same search tab twice');

  // Window closes: the dashboard sends an empty list and the tab goes away.
  sync([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(tabs.removed, [tabs.created[0].id]);
});

test('a sync with no searchTabs key leaves watchlist tabs alone', async () => {
  const { tabs, releaseStorage } = loadBridge();
  releaseStorage();
  await new Promise((resolve) => setImmediate(resolve));

  const socket = FakeSocket.instances[0];
  socket.readyState = FakeSocket.OPEN;
  socket.fire('message', {
    data: JSON.stringify({
      type: 'sync',
      watchlist: [{ id: 'a', url: 'https://www.target.com/p/x/-/A-1', name: 'x' }],
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(tabs.created.length, 1, 'the watchlist tab should still open');
  assert.deepStrictEqual(tabs.removed, [], 'an absent searchTabs key must close nothing');
});
