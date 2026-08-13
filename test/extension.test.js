'use strict';

/**
 * Drives extension/content.js in a real Chromium page against captured
 * retailer markup. Skipped unless Playwright is installed:
 *
 *   npm install --no-save playwright && npm run test:extension
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
const contentJs = SKIP ? '' : fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');

// The bundled Chromium; PLAYWRIGHT_BROWSERS_PATH builds may not match the
// npm package's expected revision, so prefer an explicit path when present.
function launchOptions() {
  const bundled = (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers');
  for (const dir of fs.existsSync(bundled) ? fs.readdirSync(bundled) : []) {
    const candidate = path.join(bundled, dir, 'chrome-linux', 'chrome');
    if (dir.startsWith('chromium-') && fs.existsSync(candidate)) {
      return { executablePath: candidate };
    }
  }
  return {};
}

const ARMED = {
  armed: true, dryRun: true, maxPrice: 100, maxCarts: 1,
  pollMs: 300, reloadSeconds: 0, goToCartAfterAdd: false,
};

const ENABLE_BUTTON = () => {
  const btn = [...document.querySelectorAll('button')]
    .find((el) => /add to cart/i.test(el.textContent));
  btn.removeAttribute('disabled');
  btn.disabled = false;
};

function targetHtml() {
  return fs
    .readFileSync(path.join(FIXTURES, 'target-client-rendered.html'), 'utf8')
    .replace('</body>', '<div data-test="product-price">$24.99</div></body>');
}

/** Load `html` at `url`, run the content script, optionally mutate, collect events. */
async function drive({ html, url, settings, mutate, trackClicks = false }) {
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) =>
      route.request().url() === url
        ? route.fulfill({ status: 200, contentType: 'text/html', body: html })
        : route.abort(),
    );

    await page.addInitScript(`
      window.__events = []; window.__clicks = 0;
      window.chrome = {
        runtime: { sendMessage: (m) => window.__events.push(m) },
        storage: { sync: { get: async () => (${JSON.stringify(settings)}) } },
      };
    `);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});

    if (trackClicks) {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
          .find((el) => /add to cart/i.test(el.textContent));
        btn.addEventListener('click', () => { window.__clicks += 1; });
      });
    }

    // addScriptTag evaluates at global scope, the way a content script's
    // isolated world shares scope across its files.
    await page.addScriptTag({ content: configJs });
    await page.addScriptTag({ content: contentJs });
    await page.waitForTimeout(500);

    if (mutate) {
      await page.evaluate(mutate);
      await page.waitForTimeout(1200);
    }

    // Must await here: `return promise` inside try/finally runs the finally
    // block before the promise settles, closing the browser mid-evaluate.
    const result = await page.evaluate(() => ({
      events: window.__events,
      clicks: window.__clicks,
    }));
    return result;
  } finally {
    await browser.close();
  }
}

const kinds = (events) => events.map((e) => e.kind);
const TARGET_URL = 'https://www.target.com/p/thing/-/A-1003554613';

test('never carts on a real Target PDP whose button is server-rendered disabled', { skip: SKIP }, async () => {
  const { events } = await drive({ html: targetHtml(), url: TARGET_URL, settings: ARMED });
  assert.ok(!kinds(events).includes('carted'));
  assert.ok(!kinds(events).includes('dry-run'));
});

test('detects the button becoming enabled mid-watch', { skip: SKIP }, async () => {
  const { events } = await drive({
    html: targetHtml(), url: TARGET_URL, settings: ARMED, mutate: ENABLE_BUTTON,
  });
  assert.ok(kinds(events).includes('in-stock'));
  assert.ok(kinds(events).includes('dry-run'));
});

test('refuses to cart above the price cap', { skip: SKIP }, async () => {
  const { events } = await drive({
    html: targetHtml().replace('$24.99', '$449.00'),
    url: TARGET_URL, settings: ARMED, mutate: ENABLE_BUTTON,
  });
  assert.ok(kinds(events).includes('skipped'));
  assert.ok(!kinds(events).includes('carted'));
});

test('stops on a bot-challenge page instead of clicking', { skip: SKIP }, async () => {
  const { events } = await drive({
    html: fs.readFileSync(path.join(FIXTURES, 'walmart-bot-challenge.html'), 'utf8'),
    url: 'https://www.walmart.com/ip/thing/1234567890',
    settings: ARMED,
  });
  assert.ok(kinds(events).includes('challenge'));
  assert.ok(!kinds(events).includes('carted'));
});

test('unarmed, it alerts but never clicks', { skip: SKIP }, async () => {
  const { events } = await drive({
    html: targetHtml(), url: TARGET_URL,
    settings: { ...ARMED, armed: false }, mutate: ENABLE_BUTTON,
  });
  assert.ok(kinds(events).includes('in-stock'));
  assert.ok(kinds(events).includes('not-armed'));
  assert.ok(!kinds(events).includes('carted'));
});

test('live mode clicks the real button exactly once', { skip: SKIP }, async () => {
  const { events, clicks } = await drive({
    html: targetHtml(), url: TARGET_URL,
    settings: { ...ARMED, dryRun: false }, mutate: ENABLE_BUTTON, trackClicks: true,
  });
  assert.ok(kinds(events).includes('carted'));
  assert.equal(clicks, 1);
});
