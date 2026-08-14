'use strict';

/**
 * Drives extension/search.js in real Chromium against search-results markup.
 * Skipped unless Playwright is installed.
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
const searchJs = SKIP ? '' : fs.readFileSync(path.join(EXT, 'search.js'), 'utf8');

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

async function drive({ html, url, mutate }) {
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) =>
      route.request().url().startsWith(url.split('?')[0])
        ? route.fulfill({ status: 200, contentType: 'text/html', body: html })
        : route.abort(),
    );
    await page.addInitScript(`
      window.__msgs = [];
      window.chrome = { runtime: { sendMessage: (m) => window.__msgs.push(m) } };
    `);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.addScriptTag({ content: searchJs });
    await page.waitForTimeout(400);

    if (mutate) {
      await page.evaluate(mutate);
      await page.waitForTimeout(600);
    }

    const msgs = await page.evaluate(() => window.__msgs);
    return msgs;
  } finally {
    await browser.close();
  }
}

const TARGET_SEARCH = 'https://www.target.com/s?searchTerm=pokemon';
const WALMART_SEARCH = 'https://www.walmart.com/search?q=pokemon';

const targetResults = `<!doctype html><html><head><title>pokemon : Target</title></head><body>
  <div id="root">
    <a href="/p/pokemon-tcg-scarlet-violet-elite-trainer-box/-/A-93954435">Pokemon TCG ETB</a>
    <a href="/p/pokemon-booster-bundle/-/A-91234567?preselect=1#lnk=sametab">Booster Bundle</a>
    <a href="/c/trading-cards/-/N-5xtfz">Trading Cards category</a>
    <a href="/p/pokemon-tcg-scarlet-violet-elite-trainer-box/-/A-93954435">duplicate link</a>
  </div></body></html>`;

const walmartResults = `<!doctype html><html><head><title>pokemon - Walmart.com</title></head><body>
  <div id="app">
    <a href="/ip/Pokemon-TCG-Booster-Bundle/1234567890">Booster Bundle</a>
    <a href="/ip/5501234567">Bare id link</a>
    <a href="/browse/toys/trading-cards/4171_4187">Category</a>
    <a href="https://www.ebay.com/itm/999">Offsite</a>
  </div></body></html>`;

const products = (msgs) => msgs.filter((m) => m.kind === 'discovered').flatMap((m) => m.products);

test('finds Target product links and ignores category links', { skip: SKIP }, async () => {
  const found = products(await drive({ html: targetResults, url: TARGET_SEARCH }));
  const ids = found.map((p) => p.id).sort();
  assert.deepEqual(ids, ['91234567', '93954435']);
  assert.ok(found.every((p) => p.site === 'target'));
});

test('strips query strings and fragments from product URLs', { skip: SKIP }, async () => {
  const found = products(await drive({ html: targetResults, url: TARGET_SEARCH }));
  assert.ok(found.every((p) => !p.url.includes('?') && !p.url.includes('#')));
});

test('reports each product once even when linked twice', { skip: SKIP }, async () => {
  const found = products(await drive({ html: targetResults, url: TARGET_SEARCH }));
  assert.equal(new Set(found.map((p) => p.id)).size, found.length);
});

test('finds Walmart item links and ignores offsite links', { skip: SKIP }, async () => {
  const found = products(await drive({ html: walmartResults, url: WALMART_SEARCH }));
  const ids = found.map((p) => p.id).sort();
  assert.deepEqual(ids, ['1234567890', '5501234567']);
  assert.ok(found.every((p) => p.site === 'walmart'));
});

test('picks up products injected after load, as on infinite scroll', { skip: SKIP }, async () => {
  const msgs = await drive({
    html: targetResults,
    url: TARGET_SEARCH,
    mutate: () => {
      const a = document.createElement('a');
      a.href = '/p/brand-new-drop/-/A-99999999';
      a.textContent = 'Brand New Drop';
      document.getElementById('root').appendChild(a);
    },
  });
  assert.ok(products(msgs).some((p) => p.id === '99999999'), 'late product must be reported');
});

test('a late product is reported without re-reporting the earlier ones', { skip: SKIP }, async () => {
  const msgs = await drive({
    html: targetResults,
    url: TARGET_SEARCH,
    mutate: () => {
      const a = document.createElement('a');
      a.href = '/p/brand-new-drop/-/A-99999999';
      document.getElementById('root').appendChild(a);
    },
  });
  const all = products(msgs).map((p) => p.id);
  assert.equal(new Set(all).size, all.length, 'no product should be reported twice');
});

test('stops on a bot-check page instead of scraping it', { skip: SKIP }, async () => {
  const msgs = await drive({
    html: fs.readFileSync(path.join(FIXTURES, 'walmart-bot-challenge.html'), 'utf8'),
    url: WALMART_SEARCH,
  });
  assert.ok(msgs.some((m) => m.kind === 'challenge'));
  assert.equal(products(msgs).length, 0);
});
