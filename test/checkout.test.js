'use strict';

/**
 * Drives extension/checkout.js in real Chromium. The point of these tests is
 * the refusal paths: every one of them must end without a click on the submit
 * button. Skipped unless Playwright is installed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  // Left null; every test below skips.
}

const SKIP = chromium === null;
const EXT = path.join(__dirname, '..', 'extension');
const FIXTURES = path.join(__dirname, 'fixtures');

const configJs = SKIP ? '' : fs.readFileSync(path.join(EXT, 'config.js'), 'utf8');
const checkoutJs = SKIP ? '' : fs.readFileSync(path.join(EXT, 'checkout.js'), 'utf8');

function launchOptions() {
  const bundled = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  for (const dir of fs.existsSync(bundled) ? fs.readdirSync(bundled) : []) {
    const candidate = path.join(bundled, dir, 'chrome-linux', 'chrome');
    if (dir.startsWith('chromium-') && fs.existsSync(candidate)) {
      return { executablePath: candidate };
    }
  }
  return {};
}

const BASE = {
  armed: true, dryRun: false, autoCheckout: true, placeOrder: true,
  maxPrice: 100, maxOrderTotal: 150, maxOrderItems: 2, maxOrdersPerDay: 1,
  pollMs: 250, maxCarts: 1, reloadSeconds: 0, goToCartAfterAdd: false,
};

const CHECKOUT_URL = 'https://www.target.com/co-review';
const CART_URL = 'https://www.target.com/cart';

/**
 * @param ledger seeds chrome.storage.local so the per-day budget can be tested.
 */
async function drive({ file, url, settings, ledger = null }) {
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    const html = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
    await page.route('**/*', (route) =>
      route.request().url().startsWith(url)
        ? route.fulfill({ status: 200, contentType: 'text/html', body: html })
        : route.abort(),
    );

    await page.addInitScript(`
      window.__events = []; window.__submits = 0; window.__local = ${JSON.stringify(
        ledger ? { orderLedger: ledger } : {},
      )};
      window.chrome = {
        runtime: { sendMessage: (m) => window.__events.push(m) },
        storage: {
          sync: { get: async () => (${JSON.stringify(settings)}) },
          local: {
            get: async (k) => (window.__local[k] ? { [k]: window.__local[k] } : {}),
            set: async (obj) => Object.assign(window.__local, obj),
          },
        },
      };
    `);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});

    await page.evaluate(() => {
      const btn = document.querySelector(
        '[data-test="placeOrderButton"], [data-test="checkout-button"]',
      );
      if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); window.__submits += 1; });
    });

    await page.addScriptTag({ content: configJs });
    await page.addScriptTag({ content: checkoutJs });
    await page.waitForTimeout(900);

    const result = await page.evaluate(() => ({
      events: window.__events,
      submits: window.__submits,
      ledger: window.__local.orderLedger || null,
      banner: document.getElementById('pokebot-banner')?.textContent || '',
    }));
    return result;
  } finally {
    await browser.close();
  }
}

const kinds = (events) => events.map((e) => e.kind);

test('places the order when everything checks out', { skip: SKIP }, async () => {
  const r = await drive({ file: 'checkout-page.html', url: CHECKOUT_URL, settings: BASE });
  assert.ok(kinds(r.events).includes('placing-order'));
  assert.equal(r.submits, 1);
});

test('claims the daily budget slot before submitting, not after', { skip: SKIP }, async () => {
  const r = await drive({ file: 'checkout-page.html', url: CHECKOUT_URL, settings: BASE });
  assert.equal(r.ledger.count, 1, 'ledger must be written even though the click navigates away');
});

test('refuses when the order total is over the cap', { skip: SKIP }, async () => {
  const r = await drive({
    file: 'checkout-page.html', url: CHECKOUT_URL,
    settings: { ...BASE, maxOrderTotal: 10 },
  });
  assert.ok(kinds(r.events).includes('refused'));
  assert.equal(r.submits, 0);
});

test('refuses when the total cannot be read', { skip: SKIP }, async () => {
  // A page with a submit button but no readable total must never be submitted.
  const r = await drive({
    file: 'checkout-no-total.html', url: CHECKOUT_URL, settings: BASE,
  });
  assert.ok(kinds(r.events).includes('refused'));
  assert.equal(r.submits, 0);
});

test('refuses when the cart holds more items than allowed', { skip: SKIP }, async () => {
  const r = await drive({
    file: 'checkout-page.html', url: CHECKOUT_URL,
    settings: { ...BASE, maxOrderItems: 0 },
  });
  assert.ok(kinds(r.events).includes('refused'));
  assert.equal(r.submits, 0);
});

test("refuses once the day's order budget is spent", { skip: SKIP }, async () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = await drive({
    file: 'checkout-page.html', url: CHECKOUT_URL, settings: BASE,
    ledger: { date: today, count: 1 },
  });
  assert.ok(kinds(r.events).includes('refused'));
  assert.equal(r.submits, 0);
});

test('stops before submitting when placeOrder is off', { skip: SKIP }, async () => {
  const r = await drive({
    file: 'checkout-page.html', url: CHECKOUT_URL,
    settings: { ...BASE, placeOrder: false },
  });
  assert.ok(kinds(r.events).includes('ready-to-submit'));
  assert.equal(r.submits, 0);
});

test('dry run never submits', { skip: SKIP }, async () => {
  const r = await drive({
    file: 'checkout-page.html', url: CHECKOUT_URL,
    settings: { ...BASE, dryRun: true },
  });
  assert.ok(kinds(r.events).includes('dry-run'));
  assert.equal(r.submits, 0);
});

test('unarmed does nothing at all', { skip: SKIP }, async () => {
  const r = await drive({
    file: 'checkout-page.html', url: CHECKOUT_URL,
    settings: { ...BASE, armed: false },
  });
  assert.equal(r.submits, 0);
  assert.ok(!kinds(r.events).includes('placing-order'));
});

test('cart page continues to checkout when enabled', { skip: SKIP }, async () => {
  const r = await drive({ file: 'cart-page.html', url: CART_URL, settings: BASE });
  assert.ok(kinds(r.events).includes('checkout-step'));
  assert.equal(r.submits, 1);
});

test('cart page stops when auto-checkout is off', { skip: SKIP }, async () => {
  const r = await drive({
    file: 'cart-page.html', url: CART_URL,
    settings: { ...BASE, autoCheckout: false },
  });
  assert.equal(r.submits, 0);
});

test('shows a kill-switch banner whenever it is live', { skip: SKIP }, async () => {
  const r = await drive({ file: 'checkout-page.html', url: CHECKOUT_URL, settings: BASE });
  assert.match(r.banner, /STOP/);
});
