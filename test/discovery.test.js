'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  parseFeed,
  extractProductUrls,
  matchKeywords,
  fetchSubreddit,
} = require('../src/discovery/reddit');

const FEED = fs.readFileSync(path.join(__dirname, 'fixtures', 'reddit-feed.xml'), 'utf8');

test('parses a real subreddit feed', () => {
  const entries = parseFeed(FEED);
  assert.ok(entries.length > 0, 'expected entries from the captured feed');
  const first = entries[0];
  assert.match(first.id, /^t3_/, 'reddit post ids dedupe reliably');
  assert.ok(first.title.length > 0);
  assert.match(first.permalink, /^https:\/\/www\.reddit\.com\/r\//);
});

test('decodes HTML entities in titles', () => {
  // The captured feed has &quot; in a title; a raw title would break matching.
  const entries = parseFeed(FEED);
  assert.ok(!entries.some((e) => e.title.includes('&quot;')));
});

test('keyword filter keeps only matching posts', () => {
  const all = parseFeed(FEED);
  const none = parseFeed(FEED, { keywords: ['definitelynotpresentxyz'] });
  assert.equal(none.length, 0);

  const some = parseFeed(FEED, { keywords: ['pikachu'] });
  assert.ok(some.length > 0 && some.length <= all.length);
  assert.ok(some.every((e) => e.matched.length > 0));
});

test('keyword matching is case-insensitive and reports what matched', () => {
  assert.deepEqual(matchKeywords('TARGET DROP TONIGHT', ['target', 'walmart']), ['target']);
  assert.deepEqual(matchKeywords('nothing here', ['target']), []);
  // Blank keywords must not match everything.
  assert.deepEqual(matchKeywords('anything', ['', '   ']), []);
});

test('pulls retailer product links out of a post body', () => {
  const body =
    'Live now! https://www.target.com/p/pokemon-etb/-/A-93954435 and ' +
    'https://www.walmart.com/ip/Pokemon-Bundle/1234567890 go go go';
  const found = extractProductUrls(body);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.site).sort(), ['target', 'walmart']);
});

test('ignores non-product and unsupported links', () => {
  const body =
    'see https://www.target.com/c/trading-cards and https://www.bestbuy.com/site/x.p ' +
    'and https://example.com/thing';
  assert.deepEqual(extractProductUrls(body), []);
});

test('strips trailing prose punctuation from a URL', () => {
  const found = extractProductUrls('grab it (https://www.target.com/p/x/-/A-93954435).');
  assert.equal(found.length, 1);
  assert.ok(!found[0].url.endsWith(')'), 'trailing bracket must not survive');
  assert.ok(!found[0].url.endsWith('.'));
});

test('the same link twice yields one candidate', () => {
  const url = 'https://www.walmart.com/ip/Pokemon/1234567890';
  assert.equal(extractProductUrls(`${url} ${url}`).length, 1);
});

test('a rate limit is reported, not thrown', async () => {
  const result = await fetchSubreddit('pkmntcgdeals', {
    fetchImpl: async () => ({ status: 429, ok: false }),
  });
  assert.equal(result.rateLimited, true);
  assert.deepEqual(result.entries, []);
});

test('a transport failure is reported, not thrown', async () => {
  const result = await fetchSubreddit('pkmntcgdeals', {
    fetchImpl: async () => { throw new Error('socket hang up'); },
  });
  assert.match(result.error, /socket hang up/);
  assert.deepEqual(result.entries, []);
});

test('a successful fetch is parsed with the caller keywords', async () => {
  const result = await fetchSubreddit('PokeInvesting', {
    keywords: ['pikachu'],
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => FEED }),
  });
  assert.ok(result.entries.length > 0);
  assert.ok(result.entries.every((e) => e.matched.includes('pikachu')));
});

test('sends a descriptive user agent', async () => {
  let seen = null;
  await fetchSubreddit('x', {
    fetchImpl: async (url, opts) => {
      seen = opts.headers['User-Agent'];
      return { status: 200, ok: true, text: async () => FEED };
    },
  });
  assert.match(seen, /pokebot/);
});
