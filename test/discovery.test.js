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

// --- Exclusions --------------------------------------------------------------
//
// The set that drops on a given Wednesday isn't knowable ahead of time, so the
// keyword list matches on product type and is deliberately loose. Exclusions
// are what stop that looseness auto-buying merchandise.

const { firstExclusion } = require('../src/discovery/reddit');

test('firstExclusion names the word that rejected the title', () => {
  assert.strictEqual(
    firstExclusion('Pokemon Pikachu Crew Socks 2-Pack', ['sock', 'plush']),
    'sock',
  );
  assert.strictEqual(firstExclusion('Pokemon TCG Booster Bundle', ['sock', 'plush']), null);
});

test('exclusions are case-insensitive and ignore blank entries', () => {
  assert.strictEqual(firstExclusion('POKEMON PLUSH Toy', ['', '  ', 'PLUSH']), 'plush');
  assert.strictEqual(firstExclusion('anything', []), null);
  assert.strictEqual(firstExclusion(undefined, ['sock']), null);
});

test('a product-type keyword list catches an unknown set, and exclusions keep merch out', () => {
  // Read the shipped defaults rather than a copy, so this fails if the lists
  // drift. The set names below are invented on purpose: nothing in the config
  // knows them, which is exactly the situation on a Wednesday night.
  const { DEFAULT_RULES } = require('../app/state');
  const keywords = DEFAULT_RULES.keywords;
  const excludes = DEFAULT_RULES.excludeKeywords;

  const wanted = [
    'Pokemon TCG: Mega Evolution Ascended Heroes Booster Bundle (6 Packs)',
    'Pokémon TCG Scarlet & Violet—Obsidian Flames Elite Trainer Box',
    'Pokemon Trading Card Game Twilight Masquerade Booster Box',
    'Pokemon TCG Some Unheard Of Set Premium Collection',
  ];
  for (const title of wanted) {
    assert.ok(matchKeywords(title, keywords).length > 0, `should match: ${title}`);
    assert.strictEqual(firstExclusion(title, excludes), null, `should not exclude: ${title}`);
  }

  const junk = [
    'Pokemon Pikachu Youth Crew Socks',
    'Pokemon Charizard Plush Toy 8 inch',
    'Pokemon Card Sleeves 65 Count',
    'Pokemon Kids Backpack and Lunch Bag Set',
    'Pokemon Charizard PSA 10 Graded Single Card',
  ];
  for (const title of junk) {
    assert.ok(firstExclusion(title, excludes) !== null, `should be excluded: ${title}`);
  }
});
