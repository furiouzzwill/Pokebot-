'use strict';

/**
 * Discovery end to end: a fake extension reports products scraped off a search
 * page, and the dashboard sees them as candidates it can promote or dismiss.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { WebSocket } = require('ws');

// Each test file gets its own state file. node --test runs files in parallel
// processes, and they used to share config/app-state.json -- so one file's
// setRules() silently rewrote another file's fixtures. That passed locally on
// timing and failed in CI.
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'pokebot-state-'));
process.env.POKEBOT_STATE_FILE = path.join(TMP_STATE, 'app-state.json');

let dashboard;
let port;

test.before(async () => {
  delete require.cache[require.resolve('../app/state')];
  delete require.cache[require.resolve('../app/server')];
  const { createDashboard } = require('../app/server');
  dashboard = createDashboard({ port: 0 });
  port = await dashboard.listen();
});

test.after(async () => {
  await dashboard.close();
  fs.rmSync(TMP_STATE, { recursive: true, force: true });
});

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
    ready: new Promise((resolve) => ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role }));
      resolve();
    })),
    send: (m) => ws.send(JSON.stringify(m)),
    next: (match, timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        const found = received.find(match);
        if (found) return resolve(found);
        waiters.push({ match, resolve });
        setTimeout(() => reject(new Error('timed out')), timeoutMs);
      }),
    close: () => ws.close(),
  };
}

const ETB = 'https://www.target.com/p/pokemon-elite-trainer-box/-/A-93954435';
const SOCKS = 'https://www.target.com/p/mens-crew-socks/-/A-55555555';

test('search-page products matching a keyword become candidates', async () => {
  const dash = client('dashboard');
  const ext = client('extension');
  await Promise.all([dash.ready, ext.ready]);

  ext.send({
    type: 'event',
    kind: 'discovered',
    site: 'target',
    products: [
      { url: ETB, id: '93954435', site: 'target', title: 'Pokemon TCG Elite Trainer Box' },
      { url: SOCKS, id: '55555555', site: 'target', title: 'Mens Crew Socks 6pk' },
    ],
  });

  const state = await dash.next(
    (m) => m.type === 'state' && (m.discoveries || []).some((d) => d.url === ETB),
  );

  // The socks share the page but not the keywords, and must not be offered.
  assert.ok(!state.discoveries.some((d) => d.url === SOCKS), 'non-matching product must be filtered');
  const found = state.discoveries.find((d) => d.url === ETB);
  assert.equal(found.kind, 'product');
  assert.equal(found.source, 'search page');
  assert.ok(found.matched.includes('pokemon'));

  dash.close();
  ext.close();
});

test('a candidate is not added to the watchlist on its own', async () => {
  const dash = client('dashboard');
  await dash.ready;
  const state = await dash.next((m) => m.type === 'state');
  assert.ok(!state.watchlist.some((i) => i.url === ETB), 'discovery must not auto-arm by default');
  dash.close();
});

test('accepting a candidate moves it onto the watchlist', async () => {
  const dash = client('dashboard');
  const ext = client('extension');
  await Promise.all([dash.ready, ext.ready]);

  dash.send({ type: 'acceptDiscovery', key: ETB });

  const state = await dash.next(
    (m) => m.type === 'state' && m.watchlist.some((i) => i.url === ETB),
  );
  assert.ok(state.watchlist.find((i) => i.url === ETB).enabled);
  // And it leaves the pending queue.
  assert.ok(!state.discoveries.some((d) => d.url === ETB && !d.dismissed));

  // The extension is told to start watching it.
  const sync = await ext.next((m) => m.type === 'sync' && m.watchlist.some((i) => i.url === ETB));
  assert.ok(sync);

  dash.close();
  ext.close();
});

test('the same product reported again is not offered twice', async () => {
  const dash = client('dashboard');
  const ext = client('extension');
  await Promise.all([dash.ready, ext.ready]);

  ext.send({
    type: 'event',
    kind: 'discovered',
    site: 'target',
    products: [{ url: ETB, id: '93954435', site: 'target', title: 'Pokemon TCG Elite Trainer Box' }],
  });
  await new Promise((r) => setTimeout(r, 250));

  const state = await dash.next((m) => m.type === 'state');
  const open = (state.discoveries || []).filter((d) => d.url === ETB && !d.dismissed);
  assert.equal(open.length, 0, 'already-watched product must not reappear');

  dash.close();
  ext.close();
});

test('dismissing a candidate clears it from the queue', async () => {
  const dash = client('dashboard');
  const ext = client('extension');
  await Promise.all([dash.ready, ext.ready]);

  const bundle = 'https://www.walmart.com/ip/Pokemon-Booster-Bundle/7778889990';
  ext.send({
    type: 'event',
    kind: 'discovered',
    site: 'walmart',
    products: [{ url: bundle, id: '7778889990', site: 'walmart', title: 'Pokemon Booster Bundle' }],
  });
  await dash.next((m) => m.type === 'state' && (m.discoveries || []).some((d) => d.url === bundle));

  dash.send({ type: 'dismissDiscovery', key: bundle });
  const after = await dash.next(
    (m) => m.type === 'state' && !(m.discoveries || []).some((d) => d.url === bundle && !d.dismissed),
  );
  assert.ok(after);

  dash.close();
  ext.close();
});

test('keywords are editable from the dashboard', async () => {
  const dash = client('dashboard');
  await dash.ready;
  dash.send({ type: 'setRules', rules: { keywords: ['prismatic', ' '], subreddits: ['pkmntcgdeals'] } });
  const state = await dash.next(
    (m) => m.type === 'state' && m.rules && m.rules.keywords.includes('prismatic'),
  );
  // Blank entries would match every product on the page.
  assert.deepEqual(state.rules.keywords, ['prismatic']);
  dash.close();
});
