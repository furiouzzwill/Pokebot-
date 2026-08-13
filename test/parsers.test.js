'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { resolveSite } = require('../src/sites');
const { IN_STOCK, OUT_OF_STOCK, UNKNOWN } = require('../src/sites/common');

const FIXTURES = path.join(__dirname, 'fixtures');

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** Run a fixture through the real adapter selection + parse path. */
function parse(fixtureName, rawUrl) {
  const { adapter, url } = resolveSite(rawUrl);
  return adapter.parse(fixture(fixtureName), url);
}

const WALMART_URL = 'https://www.walmart.com/ip/Pokemon-TCG-Elite-Trainer-Box/1234567890';
const TARGET_URL = 'https://www.target.com/p/pokemon-booster-bundle/-/A-12345678';

test('walmart: __NEXT_DATA__ in stock', () => {
  const result = parse('walmart-in-stock.html', WALMART_URL);
  assert.equal(result.status, IN_STOCK);
  assert.equal(result.method, 'next-data');
  assert.equal(result.site, 'walmart');
  assert.equal(result.id, '1234567890');
  assert.match(result.title, /Elite Trainer Box/);
  assert.equal(result.price, 49.99);
});

test('walmart: __NEXT_DATA__ out of stock beats the recommendation carousel', () => {
  const result = parse('walmart-out-of-stock.html', WALMART_URL);
  assert.equal(result.status, OUT_OF_STOCK);
  assert.equal(result.method, 'next-data');
});

test('walmart: falls back to JSON-LD when __NEXT_DATA__ is absent', () => {
  const result = parse('walmart-jsonld-only.html', WALMART_URL);
  assert.equal(result.status, IN_STOCK);
  assert.equal(result.method, 'json-ld');
  assert.equal(result.price, 26.94);
});

test('walmart: DOM heuristic prefers the out-of-stock signal over "Add to cart"', () => {
  const result = parse('walmart-dom-only.html', WALMART_URL);
  assert.equal(result.status, OUT_OF_STOCK);
  assert.equal(result.method, 'dom-heuristic');
});

test('target: inline state in stock', () => {
  const result = parse('target-in-stock.html', TARGET_URL);
  assert.equal(result.status, IN_STOCK);
  assert.equal(result.method, 'inline-state');
  assert.equal(result.site, 'target');
  assert.equal(result.id, '12345678');
  assert.match(result.title, /Booster Bundle/);
});

test('target: inline state out of stock', () => {
  const result = parse('target-out-of-stock.html', TARGET_URL);
  assert.equal(result.status, OUT_OF_STOCK);
  assert.equal(result.method, 'inline-state');
});

test('target: reads a Product node nested in an @graph', () => {
  const result = parse('target-jsonld-only.html', TARGET_URL);
  assert.equal(result.status, OUT_OF_STOCK);
  assert.equal(result.method, 'json-ld');
});

test('unknown rather than a false positive when the page has no signal', () => {
  const { adapter, url } = resolveSite(WALMART_URL);
  const result = adapter.parse('<html><head><title>Robot check</title></head><body></body></html>', url);
  assert.equal(result.status, UNKNOWN);
  assert.equal(result.method, 'none');
});

test('site resolution', () => {
  assert.equal(resolveSite(WALMART_URL).adapter.key, 'walmart');
  assert.equal(resolveSite(TARGET_URL).adapter.key, 'target');
  assert.equal(resolveSite('https://walmart.com/ip/x/1').adapter.key, 'walmart');
  assert.throws(() => resolveSite('https://www.bestbuy.com/site/x'), /No adapter/);
  assert.throws(() => resolveSite('not-a-url'), /Not a valid URL/);
  // A lookalike host must not match the real one.
  assert.throws(() => resolveSite('https://walmart.com.evil.example/ip/x/1'), /No adapter/);
});
