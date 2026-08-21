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

// Each test file gets its own state file. node --test runs files in parallel
// processes, and they used to share config/app-state.json -- so one file's
// setRules() silently rewrote another file's fixtures. That passed locally on
// timing and failed in CI.
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'pokebot-state-'));
process.env.POKEBOT_STATE_FILE = path.join(TMP_STATE, 'app-state.json');
process.env.POKEBOT_PORT = '0';

const stateModule = require.resolve('../app/state');

let WebSocket;
let server;
let port;

let dashboard;

test.before(async () => {
  ({ WebSocket } = require('ws'));
  delete require.cache[stateModule];
  const { createDashboard } = require('../app/server');
  dashboard = createDashboard({ port: 0 });
  server = dashboard.server;
  port = await dashboard.listen();
});

test.after(async () => {
  await dashboard.close();
  fs.rmSync(TMP_STATE, { recursive: true, force: true });
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

/** Force a closed->open transition so the per-window auto-add budget resets. */
function resetWindowBudget() {
  dashboard.watchDropWindow();
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

// --- Per-retailer drop windows -----------------------------------------------
//
// Walmart restocks Wednesday at 9pm; Target's good drops are 3am pre-orders on
// another day. One global schedule cannot express both, so each retailer keeps
// its own profile and they must not reach into each other.

/** A profile whose window is open all day, for tests that need one live. */
const ALWAYS_OPEN = {
  dropScheduleEnabled: true,
  dropTime: '00:00',
  dropLeadMinutes: 0,
  dropTrailMinutes: 24 * 60,
  dropDays: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
};

test('each retailer gets its own profile in the sync', async () => {
  const extension = client('extension');
  const dash = client('dashboard');
  await Promise.all([extension.ready, dash.ready]);

  dash.send({
    type: 'setSiteSettings',
    site: 'walmart',
    settings: { ...ALWAYS_OPEN, dropSearchSeconds: 10, maxPrice: 75 },
  });
  dash.send({
    type: 'setSiteSettings',
    site: 'target',
    settings: {
      dropScheduleEnabled: true,
      dropTime: '03:00',
      dropDays: ['tuesday'],
      dropLeadMinutes: 0,
      dropTrailMinutes: 0,
      maxPrice: 120,
      allowPreorders: true,
    },
  });

  const sync = await extension.next(
    (m) => m.type === 'sync' && m.sites?.walmart?.maxPrice === 75 && m.sites?.target?.maxPrice === 120,
  );

  assert.strictEqual(sync.sites.walmart.dropActive, true, 'walmart window should be open');
  assert.strictEqual(sync.sites.target.allowPreorders, true);
  assert.strictEqual(
    sync.sites.walmart.allowPreorders, false,
    'a Target setting must not leak into the Walmart profile',
  );

  // Target's one-minute window can only be open for a minute a day; treat an
  // unlucky collision as the flake it would be.
  const nowET = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  if (!/Tuesday 03:00/.test(nowET)) {
    assert.strictEqual(sync.sites.target.dropActive, false);
  }

  extension.ws.close();
  dash.ws.close();
});

test("a retailer's search tabs open only in its own window, on its own host", async () => {
  const extension = client('extension');
  const dash = client('dashboard');
  await Promise.all([extension.ready, dash.ready]);

  dash.send({
    type: 'setSiteSettings',
    site: 'walmart',
    settings: {
      ...ALWAYS_OPEN,
      searchUrls: [
        'https://www.walmart.com/browse/pokemon?sort=new',
        'https://www.target.com/s?searchTerm=pokemon',  // wrong host for this profile
        'https://evil.example.com/steal',
        'http://www.walmart.com/browse/x',              // not https
      ],
    },
  });
  dash.send({
    type: 'setSiteSettings',
    site: 'target',
    settings: {
      dropScheduleEnabled: false,
      searchUrls: ['https://www.target.com/s?searchTerm=pokemon'],
    },
  });

  const open = await extension.next(
    (m) => m.type === 'sync' && (m.searchTabs || []).length > 0,
  );
  assert.deepStrictEqual(
    open.searchTabs,
    ['https://www.walmart.com/browse/pokemon?sort=new'],
    'only https URLs on the profile\'s own retailer may become tabs',
  );

  dash.send({ type: 'setSiteSettings', site: 'walmart', settings: { dropScheduleEnabled: false } });
  const shut = await extension.next(
    (m) => m.type === 'sync' && m.sites?.walmart?.dropScheduleEnabled === false,
  );
  assert.deepStrictEqual(shut.searchTabs, [], 'a closed window retracts its tabs');

  extension.ws.close();
  dash.ws.close();
});

test('auto-add is gated by the profile of the retailer the find is on', async () => {
  const dash = client('dashboard');
  const extension = client('extension');
  await Promise.all([dash.ready, extension.ready]);

  dash.send({ type: 'setRules', rules: { keywords: ['booster'], excludeKeywords: ['sock'] } });
  // Walmart's window is open and adds; Target's is shut and must not.
  dash.send({
    type: 'setSiteSettings',
    site: 'walmart',
    settings: { ...ALWAYS_OPEN, autoAddDuringDrop: true, maxAutoAddsPerWindow: 5 },
  });
  dash.send({
    type: 'setSiteSettings',
    site: 'target',
    settings: { dropScheduleEnabled: false, autoAddDuringDrop: true },
  });
  dash.send({
    type: 'setSettings',
    settings: { autoAddDiscoveries: false, discoveryEnabled: true },
  });
  await extension.next((m) => m.type === 'sync' && m.sites?.walmart?.maxAutoAddsPerWindow === 5);
  resetWindowBudget();

  extension.send({
    type: 'event',
    kind: 'discovered',
    site: 'walmart',
    products: [{
      url: 'https://www.walmart.com/ip/wm-booster/800000001',
      id: '800000001', site: 'walmart', title: 'Pokemon Booster Bundle',
    }],
  });
  extension.send({
    type: 'event',
    kind: 'discovered',
    site: 'target',
    products: [{
      url: 'https://www.target.com/p/tgt-booster/-/A-800000002',
      id: '800000002', site: 'target', title: 'Pokemon Booster Bundle',
    }],
  });

  const state = await dash.next(
    (m) => m.type === 'state' && m.watchlist.some((i) => i.url.includes('800000001')),
  );
  assert.ok(
    !state.watchlist.some((i) => i.url.includes('800000002')),
    "Target's window is shut, so its find must stay in review",
  );

  dash.ws.close();
  extension.ws.close();
});

test('the auto-add budget is per retailer', async () => {
  const dash = client('dashboard');
  const extension = client('extension');
  await Promise.all([dash.ready, extension.ready]);

  dash.send({ type: 'setRules', rules: { keywords: ['booster'], excludeKeywords: [] } });
  dash.send({ type: 'setSiteSettings', site: 'walmart', settings: { dropScheduleEnabled: false } });
  await dash.next((m) => m.type === 'state' && m.sites.walmart.dropScheduleEnabled === false);
  resetWindowBudget();

  dash.send({
    type: 'setSiteSettings',
    site: 'walmart',
    settings: { ...ALWAYS_OPEN, autoAddDuringDrop: true, maxAutoAddsPerWindow: 2 },
  });
  await extension.next((m) => m.type === 'sync' && m.sites?.walmart?.maxAutoAddsPerWindow === 2);

  // Clear anything earlier tests left behind, then open the window cleanly.
  const dirty = await dash.next((m) => m.type === 'state');
  for (const item of dirty.watchlist) dash.send({ type: 'removeItem', id: item.id });
  for (const found of dirty.discoveries || []) {
    dash.send({ type: 'dismissDiscovery', key: found.key });
  }
  const clean = await dash.next(
    (m) => m.type === 'state'
      && m.watchlist.length === 0
      && !(m.discoveries || []).some((d) => !d.dismissed),
  );
  const before = clean.watchlist.length;
  resetWindowBudget();

  extension.send({
    type: 'event',
    kind: 'discovered',
    site: 'walmart',
    products: [1, 2, 3, 4, 5].map((n) => ({
      url: `https://www.walmart.com/ip/zubatty-${n}/80100000${n}`,
      id: `80100000${n}`, site: 'walmart', title: `Zubatty Booster Pack ${n}`,
    })),
  });

  const state = await dash.next(
    (m) => m.type === 'state'
      && (m.history || []).some((e) => /Reached \d+ auto-add.*walmart.*Zubatty/.test(e.detail || '')),
  );

  const added = state.watchlist.length - before;
  assert.ok(added > 0, 'the budget should have let something through');
  assert.ok(added <= 2, `budget is 2 but ${added} items reached the watchlist`);
  assert.ok(
    (state.discoveries || []).some((d) => !d.dismissed && /Zubatty/.test(d.title || '')),
    'blocked finds must stay in the review queue',
  );

  dash.ws.close();
  extension.ws.close();
});

test('an unknown retailer is rejected rather than silently ignored', async () => {
  const dash = client('dashboard');
  await dash.ready;
  dash.send({ type: 'setSiteSettings', site: 'bestbuy', settings: { maxPrice: 10 } });
  const error = await dash.next((m) => m.type === 'error');
  assert.match(error.message, /Unknown retailer/);
  dash.close();
});
