'use strict';

/**
 * The search watcher's refresh behaviour.
 *
 * A results page never updates itself, so re-querying is the whole mechanism
 * by which a product that appears after page load is ever noticed. These pin
 * that it happens, and that it doesn't re-announce the page each time.
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
const searchJs = SKIP
  ? ''
  : fs.readFileSync(path.join(__dirname, '..', 'extension', 'search.js'), 'utf8');

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

const URL_ = 'https://www.target.com/s?searchTerm=pokemon';

function page(extraAnchor = '') {
  return `<!doctype html><html><head><title>pokemon : Target</title></head><body>
    <div id="root">
      <a href="/p/pokemon-etb/-/A-93954435">Pokemon ETB</a>
      ${extraAnchor}
    </div></body></html>`;
}

test('re-queries the page rather than trusting a stale snapshot', { skip: SKIP }, async () => {
  const browser = await chromium.launch(launchOptions());
  try {
    const tab = await browser.newPage();
    let loads = 0;

    await tab.route('**/*', (route) => {
      if (!route.request().url().startsWith('https://www.target.com/s')) return route.abort();
      loads += 1;
      // The drop lands between the first and second query.
      const extra = loads > 1 ? '<a href="/p/new-drop/-/A-99999999">Brand New Drop</a>' : '';
      return route.fulfill({ status: 200, contentType: 'text/html', body: page(extra) });
    });

    // Collected on the Node side, because a reload wipes anything page-side.
    const messages = [];
    await tab.exposeFunction('__pokebotReport', (m) => { messages.push(m); });

    // addInitScript re-runs on every navigation, the way a content script
    // registered at document_idle does. Shrink the reload delay so the test
    // doesn't wait 90 seconds for it.
    const fast = searchJs
      .replace(/const RELOAD_MS = [^;]+;/, 'const RELOAD_MS = 1200;')
      .replace(/const RELOAD_JITTER_MS = [^;]+;/, 'const RELOAD_JITTER_MS = 0;')
      .replace(/Math\.max\(30000, delay\)/, 'delay');

    await tab.addInitScript(`
      window.chrome = { runtime: { sendMessage: (m) => window.__pokebotReport(m) } };
      window.addEventListener('DOMContentLoaded', () => { ${fast} });
    `);

    await tab.goto(URL_, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await tab.waitForTimeout(4000);

    assert.ok(loads >= 2, `expected a re-query, page loaded ${loads} time(s)`);

    const ids = messages
      .filter((m) => m.kind === 'discovered')
      .flatMap((m) => m.products.map((p) => p.id));
    assert.ok(ids.includes('93954435'), 'the product present on first load must be found');
    assert.ok(ids.includes('99999999'), 'a product that appeared after load must be found');
  } finally {
    await browser.close();
  }
});

test('a refresh does not re-announce products already reported', { skip: SKIP }, async () => {
  const browser = await chromium.launch(launchOptions());
  try {
    const tab = await browser.newPage();
    await tab.route('**/*', (route) =>
      route.request().url().startsWith('https://www.target.com/s')
        ? route.fulfill({ status: 200, contentType: 'text/html', body: page() })
        : route.abort(),
    );
    await tab.addInitScript(`
      window.chrome = { runtime: { sendMessage: () => {} } };
    `);
    await tab.goto(URL_, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await tab.addScriptTag({ content: searchJs });
    await tab.waitForTimeout(400);

    // Reload by hand: sessionStorage must carry the seen set across it.
    await tab.reload({ waitUntil: 'domcontentloaded' });
    await tab.addInitScript(`window.__msgs = [];`);
    await tab.evaluate(() => { window.__msgs = []; window.chrome = { runtime: { sendMessage: (m) => window.__msgs.push(m) } }; });
    await tab.addScriptTag({ content: searchJs });
    await tab.waitForTimeout(500);

    const msgs = await tab.evaluate(() => window.__msgs || []);
    const ids = msgs.filter((m) => m.kind === 'discovered').flatMap((m) => m.products.map((p) => p.id));
    assert.ok(!ids.includes('93954435'), 'already-reported product must not be re-announced after reload');
  } finally {
    await browser.close();
  }
});
