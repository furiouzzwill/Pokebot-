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

let dashboard;

test.before(async () => {
  ({ WebSocket } = require('ws'));
  if (fs.existsSync(realState)) fs.unlinkSync(realState);
  delete require.cache[stateModule];
  const { createDashboard } = require('../app/server');
  dashboard = createDashboard({ port: 0 });
  server = dashboard.server;
  port = await dashboard.listen();
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

// --- Scheduled drop windows --------------------------------------------------

test('the extension is told whether a drop window is open', async () => {
  const extension = client('extension');
  await extension.ready;

  // A schedule that is always open: every weekday, and a trail long enough to
  // cover the whole day whatever time the suite happens to run.
  const dashboard = client('dashboard');
  await dashboard.ready;
  dashboard.send({
    type: 'setRules',
    rules: { dropDays: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] },
  });
  dashboard.send({
    type: 'setSettings',
    settings: {
      dropScheduleEnabled: true,
      dropTime: '00:00',
      dropLeadMinutes: 0,
      dropTrailMinutes: 24 * 60,
      dropSearchSeconds: 10,
    },
  });

  const sync = await extension.next(
    (m) => m.type === 'sync' && m.settings?.dropActive === true,
  );
  assert.strictEqual(sync.settings.dropSearchSeconds, 10);

  extension.ws.close();
  dashboard.ws.close();
});

test('a schedule that is not due leaves the window shut', async () => {
  const extension = client('extension');
  await extension.ready;
  const dashboard = client('dashboard');
  await dashboard.ready;

  // A one-minute window at a fixed time cannot be open for more than a minute
  // a day, so treat an unlucky collision as the flake it would be.
  dashboard.send({ type: 'setRules', rules: { dropDays: ['wednesday'] } });
  dashboard.send({
    type: 'setSettings',
    settings: {
      dropScheduleEnabled: true,
      dropTime: '03:17',
      dropTimeZone: 'America/New_York',
      dropLeadMinutes: 0,
      dropTrailMinutes: 0,
    },
  });

  // Match on the new schedule landing, not merely on any sync: the first one
  // arrives on hello and still carries whatever the previous test configured.
  const sync = await extension.next(
    (m) => m.type === 'sync' && m.settings?.dropTime === '03:17',
  );
  const nowET = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  if (!/Wednesday 03:17/.test(nowET)) {
    assert.strictEqual(sync.settings.dropActive, false);
  }

  extension.ws.close();
  dashboard.ws.close();
});

test('auto-add during a drop does nothing while the window is shut', async () => {
  const dashboard = client('dashboard');
  await dashboard.ready;

  dashboard.send({
    type: 'setSettings',
    settings: {
      dropScheduleEnabled: false,
      autoAddDuringDrop: true,
      autoAddDiscoveries: false,
    },
  });
  await dashboard.next((m) => m.type === 'state' && m.settings.autoAddDuringDrop === true);

  const before = (await dashboard.next((m) => m.type === 'state')).watchlist.length;

  // Ingest a find the way the search watcher would.
  const extension = client('extension');
  await extension.ready;
  extension.send({
    type: 'event',
    kind: 'discovered',
    site: 'walmart',
    url: 'https://www.walmart.com/search?q=pokemon',
    products: [{
      url: 'https://www.walmart.com/ip/pokemon-etb/999888777',
      id: '999888777',
      site: 'walmart',
      title: 'Pokemon Elite Trainer Box',
    }],
  });

  const state = await dashboard.next(
    (m) => m.type === 'state' && (m.discoveries || []).some((d) => d.url?.includes('999888777')),
  );
  assert.strictEqual(
    state.watchlist.length, before,
    'a closed window must not auto-add, even with autoAddDuringDrop on',
  );

  extension.ws.close();
  dashboard.ws.close();
});

test('search tabs are sent only while the window is open, and only for retailers', async () => {
  const extension = client('extension');
  await extension.ready;
  const dashboard = client('dashboard');
  await dashboard.ready;

  dashboard.send({
    type: 'setRules',
    rules: {
      dropDays: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
      searchUrls: [
        'https://www.walmart.com/browse/pokemon?sort=new',
        'https://evil.example.com/steal',   // wrong host
        'http://www.walmart.com/browse/x',  // not https
        'not a url at all',
      ],
    },
  });
  dashboard.send({
    type: 'setSettings',
    settings: {
      dropScheduleEnabled: true,
      dropTime: '00:00',
      dropLeadMinutes: 0,
      dropTrailMinutes: 24 * 60,
      openSearchDuringDrop: true,
    },
  });

  const open = await extension.next((m) => m.type === 'sync' && m.settings?.dropActive === true);
  assert.deepStrictEqual(
    open.searchTabs,
    ['https://www.walmart.com/browse/pokemon?sort=new'],
    'only an https retailer URL may become a tab in your logged-in browser',
  );

  // Closing the window must retract them, so the tabs get closed again.
  dashboard.send({ type: 'setSettings', settings: { dropScheduleEnabled: false } });
  const shut = await extension.next(
    (m) => m.type === 'sync' && m.settings?.dropScheduleEnabled === false,
  );
  assert.deepStrictEqual(shut.searchTabs, []);

  extension.ws.close();
  dashboard.ws.close();
});

test('an unknown set is auto-added during a window, and merch is rejected', async () => {
  const dashboard = client('dashboard');
  const extension = client('extension');
  await Promise.all([dashboard.ready, extension.ready]);

  dashboard.send({
    type: 'setRules',
    rules: {
      dropDays: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
      keywords: ['booster bundle', 'elite trainer box'],
      excludeKeywords: ['sock', 'plush'],
    },
  });
  dashboard.send({
    type: 'setSettings',
    settings: {
      dropScheduleEnabled: true,
      dropTime: '00:00',
      dropLeadMinutes: 0,
      dropTrailMinutes: 24 * 60,
      autoAddDuringDrop: true,
      autoAddDiscoveries: false,
      discoveryEnabled: true,
    },
  });
  await extension.next((m) => m.type === 'sync' && m.settings?.dropActive === true);

  // A set name nothing in the config has ever seen, next to merchandise.
  extension.send({
    type: 'event',
    kind: 'discovered',
    site: 'walmart',
    url: 'https://www.walmart.com/browse/pokemon',
    products: [
      {
        url: 'https://www.walmart.com/ip/unknown-set-bundle/700000001',
        id: '700000001',
        site: 'walmart',
        title: 'Pokemon TCG: Utterly Unheard Of Set Booster Bundle (6 Packs)',
      },
      {
        url: 'https://www.walmart.com/ip/pikachu-socks/700000002',
        id: '700000002',
        site: 'walmart',
        title: 'Pokemon Pikachu Crew Socks Booster Bundle 2-Pack',
      },
    ],
  });

  // The unknown set reaches the watchlist with no human step.
  const state = await dashboard.next(
    (m) => m.type === 'state' && m.watchlist.some((i) => i.url.includes('700000001')),
  );
  assert.ok(
    !state.watchlist.some((i) => i.url.includes('700000002')),
    'socks matched a keyword and must have been excluded before auto-add',
  );

  // And the extension is told to open a tab for it, which is what carts.
  const sync = await extension.next(
    (m) => m.type === 'sync' && m.watchlist.some((i) => i.url.includes('700000001')),
  );
  assert.ok(sync.watchlist.some((i) => i.url.includes('700000001')));

  dashboard.ws.close();
  extension.ws.close();
});
