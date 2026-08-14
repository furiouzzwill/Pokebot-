'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { postAlert, buildEmbed, isWebhookUrl } = require('../src/discord');
const { fetchMessages, parseMessages, newestId } = require('../src/discovery/discord');

// ---------------------------------------------------------------- outbound

test('builds an embed carrying the link and store', () => {
  const embed = buildEmbed({
    kind: 'carted',
    title: 'Prismatic Evolutions ETB',
    detail: 'Clicked Add to cart at $49.99',
    url: 'https://www.target.com/p/x/-/A-93954435',
    site: 'target',
  });
  assert.match(embed.title, /Added to cart/);
  assert.equal(embed.url, 'https://www.target.com/p/x/-/A-93954435');
  assert.match(embed.description, /49\.99/);
  assert.ok(embed.fields.some((f) => f.value === 'target'));
});

test('a non-http url is left out rather than breaking the embed', () => {
  const embed = buildEmbed({ kind: 'in-stock', title: 'x', url: 'javascript:alert(1)' });
  assert.equal(embed.url, undefined);
});

test('posts an alert and reports success', async () => {
  let sent = null;
  const result = await postAlert('https://discord.com/api/webhooks/1/abc', { kind: 'carted', title: 'x' }, {
    fetchImpl: async (url, opts) => {
      sent = JSON.parse(opts.body);
      return { status: 204, ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(sent.username, 'Pokebot');
  assert.equal(sent.embeds.length, 1);
});

test('does not ping the channel unless asked', async () => {
  let body = null;
  const send = (event) =>
    postAlert('https://discord.com/api/webhooks/1/abc', event, {
      fetchImpl: async (url, opts) => {
        body = JSON.parse(opts.body);
        return { status: 204, ok: true };
      },
    });

  await send({ kind: 'carted', title: 'x' });
  assert.equal(body.content, undefined, 'no mention by default');

  await send({ kind: 'carted', title: 'x', mention: '@here' });
  assert.equal(body.content, '@here');
});

test('a rate limit reports how long to wait', async () => {
  const result = await postAlert('https://discord.com/api/webhooks/1/abc', { kind: 'carted' }, {
    fetchImpl: async () => ({
      status: 429,
      ok: false,
      json: async () => ({ retry_after: 2.5 }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.retryAfterMs, 2500);
});

test('a network failure never throws', async () => {
  const result = await postAlert('https://discord.com/api/webhooks/1/abc', { kind: 'carted' }, {
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNRESET/);
});

test('missing webhook is reported, not thrown', async () => {
  const result = await postAlert('', { kind: 'carted' });
  assert.equal(result.ok, false);
});

test('recognises a real webhook url shape', () => {
  assert.ok(isWebhookUrl('https://discord.com/api/webhooks/123456/abcDEF-_123'));
  assert.ok(!isWebhookUrl('https://example.com/hook'));
  assert.ok(!isWebhookUrl(''));
});

// ----------------------------------------------------------------- inbound

const msg = (over = {}) => ({
  id: '1200000000000000001',
  content: '',
  author: { username: 'dave', bot: false },
  embeds: [],
  ...over,
});

test('a product link in a message becomes a candidate', () => {
  const found = parseMessages([
    msg({ content: 'LIVE https://www.target.com/p/pokemon-etb/-/A-93954435 go' }),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'product');
  assert.equal(found[0].site, 'target');
  assert.equal(found[0].author, 'dave');
});

test('links inside an embed are found too', () => {
  // Other alert bots post the link in embed fields, not the message body.
  const found = parseMessages([
    msg({
      author: { username: 'StockBot', bot: true },
      embeds: [{
        title: 'Pokemon ETB restock',
        fields: [{ name: 'Link', value: 'https://www.walmart.com/ip/Pokemon/1234567890' }],
      }],
    }),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].site, 'walmart');
});

test('bot posts are kept by default and excluded on request', () => {
  const messages = [msg({
    author: { username: 'StockBot', bot: true },
    content: 'https://www.target.com/p/x/-/A-93954435',
  })];
  assert.equal(parseMessages(messages).length, 1);
  assert.equal(parseMessages(messages, { ignoreBots: true }).length, 0);
});

test('a product link counts even when no keyword matches', () => {
  // Someone pasting a bare Target Pokemon URL is the signal, whatever they typed.
  const found = parseMessages(
    [msg({ content: 'https://www.target.com/p/x/-/A-93954435' })],
    { keywords: ['prismatic'] },
  );
  assert.equal(found.length, 1);
});

test('chatter with neither link nor keyword is ignored', () => {
  const found = parseMessages(
    [msg({ content: 'anyone else still waiting lol' })],
    { keywords: ['pokemon'] },
  );
  assert.equal(found.length, 0);
});

test('a keyword-only message becomes an announcement', () => {
  const found = parseMessages(
    [msg({ content: 'pokemon drop at target tonight 3am' })],
    { keywords: ['pokemon'] },
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'announcement');
  assert.match(found[0].key, /^discord:/);
});

test('the newest snowflake is found regardless of order or length', () => {
  assert.equal(newestId([{ id: '999' }, { id: '1000' }, { id: '12' }]), '1000');
  assert.equal(newestId([{ id: '1200000000000000009' }, { id: '1200000000000000010' }]),
    '1200000000000000010');
  assert.equal(newestId([]), null);
});

test('a missing token is reported, not thrown', async () => {
  const result = await fetchMessages('', '123');
  assert.match(result.error, /no bot token/);
});

test('403 explains the missing permission', async () => {
  const result = await fetchMessages('tok', '123', {
    fetchImpl: async () => ({ status: 403, ok: false }),
  });
  assert.match(result.error, /Read Message History/);
});

test('401 says the token was rejected', async () => {
  const result = await fetchMessages('tok', '123', {
    fetchImpl: async () => ({ status: 401, ok: false }),
  });
  assert.match(result.error, /token rejected/);
});

test('sends the bot authorization header and the after cursor', async () => {
  let seenUrl = null;
  let seenAuth = null;
  await fetchMessages('sekrit', '4242', {
    afterId: '1200000000000000001',
    fetchImpl: async (url, opts) => {
      seenUrl = url;
      seenAuth = opts.headers.Authorization;
      return { status: 200, ok: true, json: async () => [] };
    },
  });
  assert.match(seenUrl, /channels\/4242\/messages/);
  assert.match(seenUrl, /after=1200000000000000001/);
  assert.equal(seenAuth, 'Bot sekrit');
});

test('a rate limit is reported with its wait', async () => {
  const result = await fetchMessages('tok', '123', {
    fetchImpl: async () => ({ status: 429, ok: false, json: async () => ({ retry_after: 1.5 }) }),
  });
  assert.equal(result.rateLimited, true);
  assert.equal(result.retryAfterMs, 1500);
});
