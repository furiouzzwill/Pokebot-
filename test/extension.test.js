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
async function drive({ html, url, settings, mutate, settingsChange, trackClicks = false }) {
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) =>
      route.request().url() === url
        ? route.fulfill({ status: 200, contentType: 'text/html', body: html })
        : route.abort(),
    );

    // Settings live in a mutable object with real onChanged plumbing, so a test
    // can change one the way the dashboard does and see what the tab does next.
    await page.addInitScript(`
      window.__events = []; window.__clicks = 0;
      window.__settings = ${JSON.stringify(settings)};
      window.__storageListeners = [];
      window.chrome = {
        runtime: { sendMessage: (m) => window.__events.push(m) },
        storage: {
          sync: { get: async () => ({ ...window.__settings }) },
          onChanged: { addListener: (fn) => window.__storageListeners.push(fn) },
        },
      };
      window.__changeSettings = (patch) => {
        Object.assign(window.__settings, patch);
        for (const fn of window.__storageListeners) fn({}, 'sync');
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

    if (settingsChange) {
      await page.evaluate((patch) => window.__changeSettings(patch), settingsChange);
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

// --- Settings applied without a page reload ----------------------------------
//
// Settings used to be read once at startup, so the dashboard's toggles did
// nothing to a tab that was already watching. That is a live-fire hazard in
// both directions: dry run left on when you meant to buy, and -- worse -- left
// off when you meant to stop.

test('a raised price cap resumes a tab that stopped under the old one', { skip: SKIP }, async () => {
  const { events } = await drive({
    html: targetHtml().replace('$24.99', '$449.00'),
    url: TARGET_URL,
    settings: { ...ARMED, maxPrice: 100 },
    mutate: ENABLE_BUTTON,
    settingsChange: { maxPrice: 500 },
  });

  assert.ok(kinds(events).includes('skipped'), 'expected the first pass to refuse');
  assert.ok(
    kinds(events).includes('in-stock'),
    'the tab never re-examined the button after the cap was raised',
  );
  assert.ok(kinds(events).includes('dry-run'));
});

test('turning dry run off goes live without a reload', { skip: SKIP }, async () => {
  const { events, clicks } = await drive({
    html: targetHtml(),
    url: TARGET_URL,
    settings: ARMED,
    mutate: ENABLE_BUTTON,
    settingsChange: { dryRun: false },
    trackClicks: true,
  });

  assert.ok(kinds(events).includes('dry-run'), 'expected the dry run pass first');
  assert.ok(kinds(events).includes('carted'), 'dry run off did not take effect');
  assert.equal(clicks, 1, 'the real button should be clicked exactly once');
});

test('a bot check is never resumed by a settings change', { skip: SKIP }, async () => {
  // No trackClicks here: a challenge interstitial has no cart button to watch.
  const { events } = await drive({
    html: fs.readFileSync(path.join(FIXTURES, 'walmart-bot-challenge.html'), 'utf8'),
    url: 'https://www.walmart.com/ip/thing/1234567890',
    settings: ARMED,
    settingsChange: { dryRun: false, maxPrice: 999 },
  });

  assert.ok(kinds(events).includes('challenge'));
  assert.ok(!kinds(events).includes('carted'));
  // A challenge stop needs a human, not a toggle. Resuming into one would be
  // the extension working around a bot check, which it must never do.
  assert.ok(
    !events.some((e) => e.kind === 'watching' && /resumed/.test(e.detail || '')),
    'a settings change restarted a tab that had hit a bot check',
  );
});

test('disarming stops a watching tab from carting', { skip: SKIP }, async () => {
  const { events, clicks } = await drive({
    html: targetHtml(),
    url: TARGET_URL,
    settings: { ...ARMED, dryRun: false, armed: false },
    mutate: ENABLE_BUTTON,
    settingsChange: { maxPrice: 999 },
    trackClicks: true,
  });

  assert.ok(kinds(events).includes('not-armed'));
  assert.ok(!kinds(events).includes('carted'));
  assert.equal(clicks, 0);
});

test('the content script registers a settings listener', () => {
  // Runs without Playwright, so CI (which skips the browser tests) still fails
  // if the live-settings wiring is removed.
  const source = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
  assert.match(source, /chrome\.storage\?\.onChanged\?\.addListener/);
  assert.match(source, /function applySettings/);
  assert.match(source, /stop\('price cap exceeded', \{ resumable: true \}\)/);
  assert.match(source, /stop\('challenge page'\)/, 'a challenge stop must not be resumable');
});

// --- Minimum price -----------------------------------------------------------
//
// A drop is a lineup, not one item: tonight's Ascended Heroes shelf is a $70
// ETB beside a $31 bundle, a $75 poster collection and an $18 sticker blister.
// With one auto-add per window, whichever is seen first is the one bought, and
// a maximum price cannot express "not the cheap accessory".

test('refuses to cart below the price floor', { skip: SKIP }, async () => {
  const { events, clicks } = await drive({
    html: targetHtml().replace('$24.99', '$18.00'),
    url: TARGET_URL,
    settings: { ...ARMED, dryRun: false, minPrice: 50, maxPrice: 100 },
    mutate: ENABLE_BUTTON,
    trackClicks: true,
  });

  assert.ok(kinds(events).includes('skipped'), 'an $18 blister must be refused');
  assert.ok(!kinds(events).includes('carted'));
  assert.equal(clicks, 0);
});

test('carts the item that clears the floor', { skip: SKIP }, async () => {
  const { events, clicks } = await drive({
    html: targetHtml().replace('$24.99', '$69.99'),
    url: TARGET_URL,
    settings: { ...ARMED, dryRun: false, minPrice: 50, maxPrice: 100 },
    mutate: ENABLE_BUTTON,
    trackClicks: true,
  });

  assert.ok(kinds(events).includes('carted'), 'the $69.99 ETB is the one wanted');
  assert.equal(clicks, 1);
});

test('a floor of zero disables the check', { skip: SKIP }, async () => {
  const { events } = await drive({
    html: targetHtml().replace('$24.99', '$18.00'),
    url: TARGET_URL,
    settings: { ...ARMED, dryRun: false, minPrice: 0, maxPrice: 100 },
    mutate: ENABLE_BUTTON,
  });
  assert.ok(kinds(events).includes('carted'), 'minPrice 0 must not block anything');
});

test('raising the floor mid-watch re-checks, lowering it resumes', { skip: SKIP }, async () => {
  // The floor stop is a settings stop, so it lifts when the setting changes.
  const { events } = await drive({
    html: targetHtml().replace('$24.99', '$18.00'),
    url: TARGET_URL,
    settings: { ...ARMED, minPrice: 50, maxPrice: 100 },
    mutate: ENABLE_BUTTON,
    settingsChange: { minPrice: 10 },
  });

  assert.ok(kinds(events).includes('skipped'), 'refused under the original floor');
  assert.ok(kinds(events).includes('dry-run'), 'lowering the floor should resume the tab');
});
