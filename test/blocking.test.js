'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { resolveSite } = require('../src/sites');
const { BLOCKED, UNKNOWN, IN_STOCK, detectBotChallenge } = require('../src/sites/common');

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const WALMART_URL = 'https://www.walmart.com/ip/Pokemon-TCG-Elite-Trainer-Box/1234567890';
const TARGET_URL = 'https://www.target.com/p/igloo-cooler/-/A-1003554613';

function parse(fixtureName, rawUrl) {
  const { adapter, url } = resolveSite(rawUrl);
  return adapter.parse(fixture(fixtureName), url);
}

test("walmart's PerimeterX page is reported as blocked, not as stock", () => {
  const result = parse('walmart-bot-challenge.html', WALMART_URL);
  assert.equal(result.status, BLOCKED);
  assert.equal(result.method, 'bot-challenge');
});

test("target's captcha 403 body is recognised as a challenge", () => {
  const body = '{"captchaRelativeURL":"/captcha?trackingId=abc","captchaAbsoluteURL":"https://redsky.target.com/captcha"}';
  assert.ok(detectBotChallenge(body));
});

test('a real product page is not mistaken for a challenge', () => {
  assert.equal(detectBotChallenge(fixture('walmart-in-stock.html')), null);
  assert.equal(detectBotChallenge(fixture('target-in-stock.html')), null);
  assert.equal(detectBotChallenge(''), null);
});

test('a server-rendered disabled add-to-cart button is never read as in stock', () => {
  // Regression test for a real false positive: every Target PDP ships a
  // disabled "Add to cart" button and fills in stock after hydration, so the
  // old body-text match reported IN STOCK for every product on the site.
  const result = parse('target-client-rendered.html', TARGET_URL);
  assert.notEqual(result.status, IN_STOCK);
  assert.equal(result.status, UNKNOWN);
});

test('an enabled add-to-cart button still reads as in stock', () => {
  const { adapter, url } = resolveSite(TARGET_URL);
  const html = '<html><body><h1>Thing</h1><button type="button">Add to cart</button></body></html>';
  assert.equal(adapter.parse(html, url).status, IN_STOCK);
});

test('aria-disabled is honoured as well as the disabled attribute', () => {
  const { adapter, url } = resolveSite(TARGET_URL);
  const html = '<html><body><button aria-disabled="true">Add to cart</button></body></html>';
  assert.equal(adapter.parse(html, url).status, UNKNOWN);
});
