'use strict';

/**
 * Amazon support: link handling in Node, and the content/checkout scripts in
 * real Chromium against Amazon-shaped markup. The Chromium tests skip unless
 * Playwright is installed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { resolveSite } = require('../src/sites');
const { IN_STOCK, OUT_OF_STOCK, BLOCKED } = require('../src/sites/common');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  // Left null; browser tests skip.
}
const SKIP = chromium === null;

const EXT = path.join(__dirname, '..', 'extension');
const configJs = fs.readFileSync(path.join(EXT, 'config.js'), 'utf8');
const contentJs = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
const checkoutJs = fs.readFileSync(path.join(EXT, 'checkout.js'), 'utf8');

const ASIN = 'B0DLPL7LC5';
const PDP_URL = `https://www.amazon.com/dp/${ASIN}`;

// --- Node: links and parsing ---------------------------------------------

test('every common Amazon link shape resolves to one canonical product URL', () => {
  for (const raw of [
    `https://www.amazon.com/Pokemon-TCG-Prismatic-Evolutions-Elite/dp/${ASIN}/ref=sr_1_3?crid=abc`,
    `https://www.amazon.com/dp/${ASIN}?tag=someone-20`,
    `https://www.amazon.com/gp/product/${ASIN}?th=1`,
    `https://www.amazon.com/gp/aw/d/${ASIN}`,
  ]) {
    const { adapter, url } = resolveSite(raw);
    assert.equal(adapter.key, 'amazon');
    assert.equal(adapter.canonical(url), PDP_URL, raw);
  }
});

test('an Amazon search page is not mistaken for a product', () => {
  const { adapter, url } = resolveSite('https://www.amazon.com/s?k=pokemon+etb');
  assert.equal(adapter.itemId(url), null);
});

test('the Node parser reads Amazon availability and its CAPTCHA page', () => {
  const { adapter, url } = resolveSite(PDP_URL);
  const inStock = adapter.parse('<div id="availability"><span>In Stock</span></div><input id="add-to-cart-button">', url);
  assert.equal(inStock.status, IN_STOCK);
  const out = adapter.parse('<div id="availability"><span>Currently unavailable.</span></div>', url);
  assert.equal(out.status, OUT_OF_STOCK);
  const captcha = adapter.parse('<form action="/errors/validateCaptcha">Enter the characters you see below</form>', url);
  assert.equal(captcha.status, BLOCKED);
});

test('the dashboard stores an Amazon link once, however it was pasted', () => {
  const statePath = require.resolve('../app/state');
  const state = require(statePath);
  const { url } = state.canonicalUrl(`https://www.amazon.com/Some-Name/dp/${ASIN}/ref=x?y=1`);
  assert.equal(url, PDP_URL);
  assert.ok(state.sameProduct(PDP_URL, `https://www.amazon.com/gp/product/${ASIN}`));
  assert.ok(!state.sameProduct(PDP_URL, 'https://www.amazon.com/dp/B000000000'));
});

// --- Chromium: product page ----------------------------------------------

function launchOptions() {
  const bundled = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  for (const dir of fs.existsSync(bundled) ? fs.readdirSync(bundled) : []) {
    const candidate = path.join(bundled, dir, 'chrome-linux', 'chrome');
    if (dir.startsWith('chromium-') && fs.existsSync(candidate)) return { executablePath: candidate };
  }
  return {};
}

function pdp({ seller = 'Amazon.com', price = '$49.99', cart = true, extra = '' } = {}) {
  return `<!doctype html><html><head><title>Amazon.com: Pokemon TCG Elite Trainer Box</title></head><body>
    <div id="centerCol"><h1 id="title">Pokemon TCG: Elite Trainer Box</h1>
      <div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">${price}</span></span></div>
      <div id="availability"><span>${cart ? 'In Stock' : 'Currently unavailable.'}</span></div>
      <p>${'Product description text. '.repeat(120)}</p>
    </div>
    <div id="rightCol"><div id="buybox">
      ${cart ? '<form id="addToCart"><input id="add-to-cart-button" type="submit" value="Add to Cart"></form>' : ''}
      <div id="merchantInfoFeature_feature_div"><span>Ships from</span> <span>Amazon.com</span>
        <span>Sold by</span> <span>${seller}</span> <span>Returns</span></div>
      ${extra}
    </div></div>
    <div id="similarities"><form><input type="submit" value="Add to Cart" class="carousel-atc"></form></div>
  </body></html>`;
}

const LIVE = {
  armed: true, dryRun: false, maxPrice: 100, maxCarts: 1, amazonOnly: true,
  pollMs: 250, reloadSeconds: 0, goToCartAfterAdd: false,
};

async function drivePdp(html, settings = LIVE) {
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) =>
      route.request().url() === PDP_URL
        ? route.fulfill({ status: 200, contentType: 'text/html', body: html })
        : route.abort(),
    );
    await page.addInitScript(`
      window.__events = []; window.__clicks = 0; window.__wrongClicks = 0;
      window.chrome = {
        runtime: { sendMessage: (m) => window.__events.push(m) },
        storage: { sync: { get: async () => (${JSON.stringify(settings)}) } },
      };
    `);
    await page.goto(PDP_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.evaluate(() => {
      for (const form of document.querySelectorAll('form')) form.addEventListener('submit', (e) => e.preventDefault());
      document.querySelector('#add-to-cart-button')?.addEventListener('click', () => { window.__clicks += 1; });
      document.querySelector('.carousel-atc')?.addEventListener('click', () => { window.__wrongClicks += 1; });
      for (const el of document.querySelectorAll('button')) {
        el.addEventListener('click', () => { window.__clicks += 1; });
      }
    });
    await page.addScriptTag({ content: configJs });
    await page.addScriptTag({ content: contentJs });
    await page.waitForTimeout(700);
    return await page.evaluate(() => ({
      events: window.__events, clicks: window.__clicks, wrongClicks: window.__wrongClicks,
    }));
  } finally {
    await browser.close();
  }
}

const kinds = (events) => events.map((e) => e.kind);

test('carts the buy-box item when Amazon is the seller', { skip: SKIP }, async () => {
  const r = await drivePdp(pdp());
  assert.ok(kinds(r.events).includes('carted'));
  assert.equal(r.clicks, 1);
  assert.equal(r.wrongClicks, 0, 'the carousel button must never be clicked');
});

test('refuses a third-party seller and keeps watching', { skip: SKIP }, async () => {
  const r = await drivePdp(pdp({ seller: 'PokeFlip Collectibles LLC' }));
  assert.equal(r.clicks, 0);
  const skip = r.events.find((e) => e.kind === 'skipped');
  assert.ok(skip && /not Amazon/.test(skip.detail));
  assert.ok(!kinds(r.events).includes('stopped'), 'it must keep watching for Amazon stock');
});

test('Amazon Resale (used) does not count as Amazon', { skip: SKIP }, async () => {
  const r = await drivePdp(pdp({ seller: 'Amazon Resale' }));
  assert.equal(r.clicks, 0);
});

test('a third-party seller is allowed when the setting is off', { skip: SKIP }, async () => {
  const r = await drivePdp(pdp({ seller: 'PokeFlip Collectibles LLC' }), { ...LIVE, amazonOnly: false });
  assert.equal(r.clicks, 1);
});

test('over the price cap: no click, and the tab keeps watching', { skip: SKIP }, async () => {
  const r = await drivePdp(pdp({ price: '$189.99' }));
  assert.equal(r.clicks, 0);
  assert.ok(kinds(r.events).includes('skipped'));
  assert.ok(!kinds(r.events).includes('stopped'));
});

test('out of stock: nothing clicked', { skip: SKIP }, async () => {
  const r = await drivePdp(pdp({ cart: false }));
  assert.equal(r.clicks, 0);
  assert.equal(r.wrongClicks, 0, 'a carousel item must never be carted in its place');
  assert.ok(!kinds(r.events).includes('carted'));
});

test('stops on the Amazon CAPTCHA page', { skip: SKIP }, async () => {
  const html = `<!doctype html><html><head><title>Amazon.com</title></head><body>
    <form action="/errors/validateCaptcha"><h4>Enter the characters you see below</h4>
    <input id="captchacharacters"><button type="submit">Continue shopping</button></form></body></html>`;
  const r = await drivePdp(html);
  assert.ok(kinds(r.events).includes('challenge'));
  assert.equal(r.clicks, 0);
});

test('requests an invitation on invite-only items', { skip: SKIP }, async () => {
  const html = pdp({ cart: false, extra: '<button id="invite">Request invitation</button>' });
  const r = await drivePdp(html);
  assert.equal(r.clicks, 1);
  assert.ok(r.events.some((e) => e.kind === 'carted' && /invitation/i.test(e.detail)));
});

test('in dry run the invitation is only announced', { skip: SKIP }, async () => {
  const html = pdp({ cart: false, extra: '<button id="invite">Request invitation</button>' });
  const r = await drivePdp(html, { ...LIVE, dryRun: true });
  assert.equal(r.clicks, 0);
  assert.ok(kinds(r.events).includes('in-stock'));
});

// --- Chromium: checkout --------------------------------------------------

const SPC_URL = 'https://www.amazon.com/gp/buy/spc/handlers/display.html?hasWorkingJavascript=1';
const CHECKOUT_SETTINGS = {
  ...LIVE, autoCheckout: true, placeOrder: true,
  maxOrderTotal: 150, maxOrderItems: 2, maxOrdersPerDay: 1,
};

function spc(total = '$54.37') {
  return `<!doctype html><html><head><title>Amazon.com Checkout</title></head><body>
    <h1>Checkout</h1>
    <div id="subtotals"><table id="subtotals-marketplace-table"><tr>
      <td>Order total:</td><td class="grand-total-price">${total}</td></tr></table></div>
    <span id="submitOrderButtonId"><input id="placeOrder" type="submit" value="Place your order"></span>
    <p>${'Delivery details. '.repeat(150)}</p>
  </body></html>`;
}

async function driveCheckout(html, settings = CHECKOUT_SETTINGS) {
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) =>
      route.request().url() === SPC_URL
        ? route.fulfill({ status: 200, contentType: 'text/html', body: html })
        : route.abort(),
    );
    await page.addInitScript(`
      window.__events = []; window.__submits = 0; window.__local = {};
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
    await page.goto(SPC_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.evaluate(() => {
      document.querySelector('#placeOrder')?.addEventListener('click', (e) => {
        e.preventDefault();
        window.__submits += 1;
      });
    });
    await page.addScriptTag({ content: configJs });
    await page.addScriptTag({ content: checkoutJs });
    await page.waitForTimeout(900);
    return await page.evaluate(() => ({ events: window.__events, submits: window.__submits }));
  } finally {
    await browser.close();
  }
}

test('places an Amazon order when the total is readable and under the cap', { skip: SKIP }, async () => {
  const r = await driveCheckout(spc());
  assert.ok(kinds(r.events).includes('placing-order'));
  assert.equal(r.submits, 1);
});

test('refuses an Amazon order over the total cap', { skip: SKIP }, async () => {
  const r = await driveCheckout(spc('$212.40'));
  assert.equal(r.submits, 0);
  assert.ok(kinds(r.events).includes('refused'));
});

test('refuses an Amazon order whose total cannot be read', { skip: SKIP }, async () => {
  const r = await driveCheckout(spc('see details'));
  assert.equal(r.submits, 0);
  assert.ok(kinds(r.events).includes('refused'));
});
