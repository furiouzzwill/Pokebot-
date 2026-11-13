'use strict';

/**
 * Phone alerts -> watchlist. A link (or a whole SMS) POSTed to /api/link
 * lands on the watchlist so the extension opens and carts it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { resolveAlertLink } = require('../src/discovery/inbound');

const ETB = 'https://www.target.com/p/pokemon-tcg-elite-trainer-box/-/A-93954435';

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return {
      status: route.status,
      ok: route.status >= 200 && route.status < 300,
      headers: { get: (name) => (name.toLowerCase() === 'location' ? route.location || null : null) },
      text: async () => route.body || '',
    };
  };
  return { impl, calls };
}

test('a retailer link in an SMS body is used directly, nothing fetched', async () => {
  const { impl, calls } = fakeFetch({});
  const found = await resolveAlertLink(`RESTOCK: Pokemon ETB at Target! ${ETB}?afid=xyz. Reply STOP`, { fetchImpl: impl });
  assert.equal(found.site, 'target');
  assert.ok(found.url.startsWith(ETB));
  assert.equal(calls.length, 0);
});

test('a tracking redirect is followed up to, but not into, the retailer', async () => {
  const { impl, calls } = fakeFetch({
    'https://alerts.example/r/abc': { status: 302, location: 'https://go.example/x' },
    'https://go.example/x': { status: 301, location: ETB },
  });
  const found = await resolveAlertLink('In stock https://alerts.example/r/abc', { fetchImpl: impl });
  assert.equal(found.url, ETB);
  assert.ok(!calls.includes(ETB), 'the retailer page itself must never be fetched');
});

test('a tracker page that redirects in JavaScript is read for the destination', async () => {
  const { impl } = fakeFetch({
    'https://alerts.example/r/js': {
      status: 200,
      body: '<script>window.location="https:\\/\\/www.walmart.com\\/ip\\/Pokemon-ETB\\/1234567890"</script>',
    },
  });
  const found = await resolveAlertLink('https://alerts.example/r/js', { fetchImpl: impl });
  assert.equal(found.site, 'walmart');
  assert.equal(found.url, 'https://www.walmart.com/ip/Pokemon-ETB/1234567890');
});

test('a link to an unsupported store is refused with a reason', async () => {
  const { impl } = fakeFetch({
    'https://www.pokemoncenter.com/product/123': { status: 200, body: '<html></html>' },
  });
  const found = await resolveAlertLink('https://www.pokemoncenter.com/product/123', { fetchImpl: impl });
  assert.ok(found.error);
});

// --- endpoint ---------------------------------------------------------------

const configDir = path.resolve(__dirname, '..', 'config');
const realState = path.join(configDir, 'app-state.json');
const backup = fs.existsSync(realState) ? fs.readFileSync(realState) : null;

let dashboard;
let port;
const TOKEN = 'test-token-123';

test.before(async () => {
  if (fs.existsSync(realState)) fs.unlinkSync(realState);
  delete require.cache[require.resolve('../app/state')];
  delete require.cache[require.resolve('../app/server')];
  const { createDashboard } = require('../app/server');
  dashboard = createDashboard({ port: 0, token: TOKEN });
  port = await dashboard.listen();
});

test.after(async () => {
  await dashboard.close();
  if (backup) fs.writeFileSync(realState, backup);
  else if (fs.existsSync(realState)) fs.unlinkSync(realState);
});

const post = (body, token = TOKEN, contentType = 'application/json') =>
  fetch(`http://127.0.0.1:${port}/api/link${token ? `?token=${token}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });

test('the endpoint refuses requests without the token, even on loopback', async () => {
  const res = await post(JSON.stringify({ url: ETB }), '');
  assert.equal(res.status, 401);
  const wrong = await post(JSON.stringify({ url: ETB }), 'nope-nope-nope');
  assert.equal(wrong.status, 401);
});

test('an alert link goes straight onto the watchlist, enabled and cleaned', async () => {
  const res = await post(JSON.stringify({ text: `Pokemon ETB restock ${ETB}?clkid=1` }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.url, ETB);
  assert.equal(body.alreadyWatched, false);

  const { getState } = require('../app/state');
  const item = getState().watchlist.find((i) => i.url === ETB);
  assert.ok(item && item.enabled);
});

test('the same alert twice does not duplicate the item', async () => {
  const res = await post(ETB, TOKEN, 'text/plain');
  const body = await res.json();
  assert.equal(body.alreadyWatched, true);
  const { getState } = require('../app/state');
  assert.equal(getState().watchlist.filter((i) => i.url === ETB).length, 1);
});

test('an alert without a usable link is rejected', async () => {
  const res = await post(JSON.stringify({ text: 'Charizard UPC back in stock, check the app' }));
  assert.equal(res.status, 422);
});

test('phone-alerts mode will not start without a token', () => {
  const { createDashboard } = require('../app/server');
  assert.throws(() => createDashboard({ port: 0, phoneAlerts: true }), /token/);
});
