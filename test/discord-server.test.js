'use strict';

/**
 * Discord in and out, through the real dashboard.
 *
 * Outbound uses a local HTTP server standing in for the webhook, so the posted
 * payload is inspected exactly as Discord would receive it. Inbound drives
 * pollDiscord() against a stubbed API.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { WebSocket } = require('ws');

const configDir = path.resolve(__dirname, '..', 'config');
const realState = path.join(configDir, 'app-state.json');
const backup = fs.existsSync(realState) ? fs.readFileSync(realState) : null;

let dashboard;
let port;
let hook;
let hookPort;
const posted = [];

test.before(async () => {
  // Stand-in for Discord's webhook endpoint.
  hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { posted.push(JSON.parse(body)); } catch { /* ignore */ }
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  hookPort = hook.address().port;

  process.env.DISCORD_WEBHOOK_URL = `http://127.0.0.1:${hookPort}/webhook`;
  process.env.DISCORD_MENTION = '@here';

  if (fs.existsSync(realState)) fs.unlinkSync(realState);
  delete require.cache[require.resolve('../app/state')];
  delete require.cache[require.resolve('../app/server')];
  const { createDashboard } = require('../app/server');
  dashboard = createDashboard({ port: 0 });
  port = await dashboard.listen();
});

test.after(async () => {
  await dashboard.close();
  await new Promise((resolve) => hook.close(resolve));
  delete process.env.DISCORD_WEBHOOK_URL;
  delete process.env.DISCORD_MENTION;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_CHANNEL_IDS;
  if (backup) fs.writeFileSync(realState, backup);
  else if (fs.existsSync(realState)) fs.unlinkSync(realState);
});

function client(role) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  return {
    ready: new Promise((resolve) => ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role }));
      resolve();
    })),
    send: (m) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
  };
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

test('a cart event is posted to the webhook', async () => {
  posted.length = 0;
  const ext = client('extension');
  await ext.ready;

  ext.send({
    type: 'event',
    kind: 'carted',
    detail: 'Clicked Add to cart at $49.99',
    url: 'https://www.target.com/p/pokemon-etb/-/A-93954435',
    site: 'target',
  });

  await settle();
  assert.equal(posted.length, 1, 'expected exactly one webhook post');
  const embed = posted[0].embeds[0];
  assert.match(embed.title, /Added to cart/);
  assert.match(embed.description, /49\.99/);
  assert.equal(embed.url, 'https://www.target.com/p/pokemon-etb/-/A-93954435');
  ext.close();
});

test('urgent events ping the channel, routine ones do not', async () => {
  posted.length = 0;
  const ext = client('extension');
  await ext.ready;

  ext.send({ type: 'event', kind: 'in-stock', detail: 'live at $49.99', site: 'target' });
  await settle();
  assert.equal(posted[0].content, '@here', 'in-stock should ping');

  posted.length = 0;
  ext.send({ type: 'event', kind: 'ready-to-submit', detail: 'total $54.31', site: 'target' });
  await settle();
  assert.equal(posted[0].content, undefined, 'ready-to-submit should not ping');
  ext.close();
});

test('routine chatter is not posted at all', async () => {
  posted.length = 0;
  const ext = client('extension');
  await ext.ready;
  // 'watching' fires constantly; mirroring it would drown the channel.
  ext.send({ type: 'event', kind: 'watching', detail: 'target watching', site: 'target' });
  await settle();
  assert.equal(posted.length, 0);
  ext.close();
});

test('alerts stop when the setting is off', async () => {
  const dash = client('dashboard');
  const ext = client('extension');
  await Promise.all([dash.ready, ext.ready]);

  dash.send({ type: 'setSettings', settings: { discordAlerts: false } });
  await settle(250);

  posted.length = 0;
  ext.send({ type: 'event', kind: 'carted', detail: 'x', site: 'target' });
  await settle();
  assert.equal(posted.length, 0);

  dash.send({ type: 'setSettings', settings: { discordAlerts: true } });
  await settle(250);
  dash.close();
  ext.close();
});

test('a webhook failure does not break event handling', async () => {
  const ext = client('extension');
  await ext.ready;
  process.env.DISCORD_WEBHOOK_URL = 'http://127.0.0.1:1/nope'; // refused

  ext.send({
    type: 'event', kind: 'carted', detail: 'should still be recorded',
    url: 'https://www.walmart.com/ip/x/1234567890', site: 'walmart',
  });
  await settle(600);

  // The event still landed in history despite the alert failing.
  const state = require('../app/state');
  assert.ok(state.getState().history.some((h) => h.detail === 'should still be recorded'));

  process.env.DISCORD_WEBHOOK_URL = `http://127.0.0.1:${hookPort}/webhook`;
  ext.close();
});

test('links posted in a watched channel become candidates', async () => {
  process.env.DISCORD_BOT_TOKEN = 'test-token';
  process.env.DISCORD_CHANNEL_IDS = '4242';

  const messages = [
    {
      id: '1200000000000000010',
      content: 'LIVE https://www.target.com/p/prismatic-etb/-/A-97771111',
      author: { username: 'dave', bot: false },
      embeds: [],
    },
    {
      id: '1200000000000000011',
      content: 'anyone got a link',
      author: { username: 'sam', bot: false },
      embeds: [],
    },
  ];

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('discord.com/api')) {
      return { status: 200, ok: true, json: async () => messages };
    }
    return realFetch(url);
  };

  try {
    await dashboard.pollDiscord();
  } finally {
    globalThis.fetch = realFetch;
  }

  const state = require('../app/state');
  const found = state.getState().discoveries.find((d) => d.url?.includes('A-97771111'));
  assert.ok(found, 'the posted product link should become a candidate');
  assert.equal(found.kind, 'product');
  assert.match(found.source, /discord · dave/);

  // The chatter message has no link and no keyword, so it is not a candidate.
  assert.ok(!state.getState().discoveries.some((d) => d.title === 'anyone got a link'));
});
