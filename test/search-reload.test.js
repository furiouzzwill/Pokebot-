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
const EXT = path.join(__dirname, '..', 'extension');
const searchJs = SKIP ? '' : fs.readFileSync(path.join(EXT, 'search.js'), 'utf8');
const configJs = SKIP ? '' : fs.readFileSync(path.join(EXT, 'config.js'), 'utf8');

/**
 * config.js with the re-query floor lowered, so a test doesn't sit through the
 * five-second minimum a real tab is held to. The floor itself is asserted
 * separately rather than being quietly assumed away here.
 */
/**
 * search.js with the challenge backoff shortened. The real one starts at 30
 * seconds, which is right for a live retailer and far too long for a test.
 */
function withBackoff(ms) {
  const start = searchJs.indexOf('const CHALLENGE_BACKOFF_MS = [');
  const end = searchJs.indexOf('];', start) + 2;
  if (start === -1) throw new Error('CHALLENGE_BACKOFF_MS not found in search.js');
  return searchJs.slice(0, start) + `const CHALLENGE_BACKOFF_MS = [${ms}];` + searchJs.slice(end);
}

function configWithTinyFloor() {
  return configJs.replace(/const MIN_SEARCH_SECONDS = [^;]+;/, 'const MIN_SEARCH_SECONDS = 0.4;');
}

/** A chrome stub whose settings can be swapped mid-test, as the dashboard does. */
function chromeStub(overrides, { report = false } = {}) {
  return `
    window.__settings = { ...${JSON.stringify(overrides)} };
    window.__storageListeners = [];
    window.chrome = {
      runtime: { sendMessage: (m) => ${report ? 'window.__pokebotReport(m)' : '(window.__msgs = window.__msgs || []).push(m)'} },
      storage: {
        sync: { get: async (defaults) => ({ ...defaults, ...window.__settings }) },
        onChanged: { addListener: (fn) => window.__storageListeners.push(fn) },
      },
    };
    window.__changeSettings = (patch) => {
      Object.assign(window.__settings, patch);
      for (const fn of window.__storageListeners) fn({}, 'sync');
    };
  `;
}

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
    // registered at document_idle does. The interval now comes from settings,
    // so the test asks for a fast one rather than rewriting the source.
    await tab.addInitScript(`
      ${chromeStub({ searchSeconds: 1.2, dropActive: false, onlyNewListings: false }, { report: true })}
      window.addEventListener('DOMContentLoaded', () => {
        ${configWithTinyFloor()}
        ${searchJs}
      });
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
    await tab.addInitScript(chromeStub({ searchSeconds: 90, dropActive: false }));
    await tab.goto(URL_, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await tab.addScriptTag({ content: configJs });
    await tab.addScriptTag({ content: searchJs });
    await tab.waitForTimeout(400);

    // Reload by hand: sessionStorage must carry the seen set across it.
    await tab.reload({ waitUntil: 'domcontentloaded' });
    await tab.evaluate(() => { window.__msgs = []; });
    await tab.addScriptTag({ content: configJs });
    await tab.addScriptTag({ content: searchJs });
    await tab.waitForTimeout(500);

    const msgs = await tab.evaluate(() => window.__msgs || []);
    const ids = msgs.filter((m) => m.kind === 'discovered').flatMap((m) => m.products.map((p) => p.id));
    assert.ok(!ids.includes('93954435'), 'already-reported product must not be re-announced after reload');
  } finally {
    await browser.close();
  }
});

// --- Scheduled drop windows --------------------------------------------------

test('an open drop window speeds the re-query up, live', { skip: SKIP }, async () => {
  const browser = await chromium.launch(launchOptions());
  try {
    const tab = await browser.newPage();
    const loadTimes = [];

    await tab.route('**/*', (route) => {
      if (!route.request().url().startsWith('https://www.target.com/s')) return route.abort();
      loadTimes.push(Date.now());
      return route.fulfill({ status: 200, contentType: 'text/html', body: page() });
    });

    // Idle at a pace no test would wait for; the window is what makes it move.
    await tab.addInitScript(`
      ${chromeStub({ searchSeconds: 3600, dropSearchSeconds: 0.6, dropActive: false, onlyNewListings: false })}
      window.addEventListener('DOMContentLoaded', () => {
        ${configWithTinyFloor()}
        ${searchJs}
      });
    `);

    await tab.goto(URL_, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await tab.waitForTimeout(800);
    assert.strictEqual(loadTimes.length, 1, 'must not re-query on the idle interval yet');

    // 9pm arrives: the server flips dropActive and the tab is told over storage.
    await tab.evaluate(() => window.__changeSettings({ dropActive: true }));
    await tab.waitForTimeout(2000);

    assert.ok(
      loadTimes.length >= 2,
      `the open window must re-query without a reload; loaded ${loadTimes.length} time(s)`,
    );
  } finally {
    await browser.close();
  }
});

test('the re-query interval is floored, however low it is set', { skip: SKIP }, async () => {
  const browser = await chromium.launch(launchOptions());
  try {
    const tab = await browser.newPage();
    await tab.route('**/*', (route) =>
      route.request().url().startsWith('https://www.target.com/s')
        ? route.fulfill({ status: 200, contentType: 'text/html', body: page() })
        : route.abort(),
    );

    // The real config.js this time: the floor is the thing under test.
    await tab.addInitScript(chromeStub({ dropSearchSeconds: 0, dropActive: true }));
    await tab.goto(URL_, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await tab.addScriptTag({ content: configJs });
    await tab.addScriptTag({ content: searchJs });

    const seconds = await tab.evaluate(() => reloadSeconds(state.settings));
    assert.ok(seconds >= 5, `a zero interval must be floored, got ${seconds}`);
  } finally {
    await browser.close();
  }
});

test('newest listings are reported before the rest of the page', { skip: SKIP }, async () => {
  const browser = await chromium.launch(launchOptions());
  try {
    const tab = await browser.newPage();
    // DOM order puts the established best-seller first, as relevance ranking
    // does. The newest SKU is the one worth reporting first on a drop night.
    const results = `<!doctype html><html><head><title>pokemon : Target</title></head><body>
      <div id="root">
        <a href="/p/old-best-seller/-/A-10000001">Pokemon best seller</a>
        <a href="/p/brand-new-drop/-/A-99999999">Pokemon brand new drop</a>
        <a href="/p/middling/-/A-50000000">Pokemon middling</a>
      </div></body></html>`;

    await tab.route('**/*', (route) =>
      route.request().url().startsWith('https://www.target.com/s')
        ? route.fulfill({ status: 200, contentType: 'text/html', body: results })
        : route.abort(),
    );
    await tab.addInitScript(chromeStub({ searchSeconds: 3600, dropActive: false, onlyNewListings: false }));
    await tab.goto(URL_, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await tab.addScriptTag({ content: configJs });
    await tab.addScriptTag({ content: searchJs });
    await tab.waitForTimeout(400);

    const msgs = await tab.evaluate(() => window.__msgs || []);
    const ids = msgs
      .filter((m) => m.kind === 'discovered')
      .flatMap((m) => m.products.map((p) => p.id));
    assert.deepStrictEqual(ids, ['99999999', '50000000', '10000001']);
  } finally {
    await browser.close();
  }
});

// --- Only brand-new listings -------------------------------------------------
//
// The failure this prevents: a drop-night tab opens at 2:50am, the first scrape
// announces the entire existing Pokemon catalogue, auto-add takes all of it and
// carts whatever old stock is in stock -- while the actual drop is still ten
// minutes away.

test('what is already on the page when the tab opens is never reported', { skip: SKIP }, async () => {
  const browser = await chromium.launch(launchOptions());
  try {
    const tab = await browser.newPage();
    let loads = 0;

    await tab.route('**/*', (route) => {
      if (!route.request().url().startsWith('https://www.target.com/s')) return route.abort();
      loads += 1;
      // The drop lands on the second query, alongside the old stock.
      const extra = loads > 1 ? '<a href="/p/tonights-drop/-/A-99999999">Tonights Drop ETB</a>' : '';
      return route.fulfill({ status: 200, contentType: 'text/html', body: page(extra) });
    });

    const messages = [];
    await tab.exposeFunction('__pokebotReport', (m) => { messages.push(m); });

    await tab.addInitScript(`
      ${chromeStub({ searchSeconds: 1.5, onlyNewListings: true }, { report: true })}
      window.addEventListener('DOMContentLoaded', () => {
        ${configWithTinyFloor()}
        ${searchJs.replace(/const BASELINE_MS = [^;]+;/, 'const BASELINE_MS = 600;')}
      });
    `);

    await tab.goto(URL_, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await tab.waitForTimeout(5000);

    const reported = messages
      .filter((m) => m.kind === 'discovered')
      .flatMap((m) => m.products.map((p) => p.id));

    assert.ok(
      !reported.includes('93954435'),
      'the listing already on the page at open must never be reported -- it is old stock',
    );
    assert.ok(
      reported.includes('99999999'),
      'a listing that appeared after the baseline is the drop, and must be reported',
    );
    assert.ok(
      messages.some((m) => m.kind === 'baseline'),
      'the dashboard should be told the baseline happened',
    );
  } finally {
    await browser.close();
  }
});

test('a re-query during the drop does not re-baseline', { skip: SKIP }, async () => {
  const browser = await chromium.launch(launchOptions());
  try {
    const tab = await browser.newPage();
    let loads = 0;

    await tab.route('**/*', (route) => {
      if (!route.request().url().startsWith('https://www.target.com/s')) return route.abort();
      loads += 1;
      // Nothing new on load 2; the drop lands on load 3. If reloading rebuilt
      // the baseline, load 3's product would be swallowed as "pre-existing".
      // Above the baseline id (93954435): a real new listing always is.
      const extra = loads >= 3 ? '<a href="/p/late-drop/-/A-99888888">Late Drop ETB</a>' : '';
      return route.fulfill({ status: 200, contentType: 'text/html', body: page(extra) });
    });

    const messages = [];
    await tab.exposeFunction('__pokebotReport', (m) => { messages.push(m); });

    await tab.addInitScript(`
      ${chromeStub({ searchSeconds: 1.2, onlyNewListings: true }, { report: true })}
      window.addEventListener('DOMContentLoaded', () => {
        ${configWithTinyFloor()}
        ${searchJs.replace(/const BASELINE_MS = [^;]+;/, 'const BASELINE_MS = 500;')}
      });
    `);

    await tab.goto(URL_, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await tab.waitForTimeout(6000);

    assert.ok(loads >= 3, `expected several re-queries, got ${loads}`);
    const reported = messages
      .filter((m) => m.kind === 'discovered')
      .flatMap((m) => m.products.map((p) => p.id));
    assert.ok(
      reported.includes('99888888'),
      'a product appearing after a reload must still be reported',
    );
    assert.ok(!reported.includes('93954435'), 'old stock must stay excluded across reloads');
  } finally {
    await browser.close();
  }
});

test('an old SKU resurfacing on page one is never reported', { skip: SKIP }, async () => {
  // Taken from a live run. The baseline saw the newest listing at 1013118349;
  // Prismatic Evolutions (1001632618) was out of stock then, reappeared on page
  // one twenty minutes later, looked brand new, and was carted.
  const browser = await chromium.launch(launchOptions());
  try {
    const tab = await browser.newPage();
    let loads = 0;

    const shelf = (extra) => `<!doctype html><html><head><title>pokemon : Target</title></head>
      <body><div id="root">
        <a href="/p/lumiose-tin/-/A-1013118349">Pokemon Lumiose City Mini Tin</a>
        ${extra}
      </div></body></html>`;

    await tab.route('**/*', (route) => {
      if (!route.request().url().startsWith('https://www.target.com/s')) return route.abort();
      loads += 1;
      const extra = loads > 1
        ? `<a href="/p/prismatic/-/A-1001632618">Prismatic Evolutions Booster Pack</a>
           <a href="/p/tonights-drop/-/A-1013500000">Tonights Drop Booster Bundle</a>`
        : '';
      return route.fulfill({ status: 200, contentType: 'text/html', body: shelf(extra) });
    });

    const messages = [];
    await tab.exposeFunction('__pokebotReport', (m) => { messages.push(m); });
    await tab.addInitScript(`
      ${chromeStub({ searchSeconds: 1.5, onlyNewListings: true }, { report: true })}
      window.addEventListener('DOMContentLoaded', () => {
        ${configWithTinyFloor()}
        ${searchJs.replace(/const BASELINE_MS = [^;]+;/, 'const BASELINE_MS = 600;')}
      });
    `);

    await tab.goto(URL_, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await tab.waitForTimeout(5000);

    const reported = messages
      .filter((m) => m.kind === 'discovered')
      .flatMap((m) => m.products.map((p) => p.id));

    assert.ok(
      !reported.includes('1001632618'),
      'an id below the baseline floor is old stock resurfacing, not a drop',
    );
    assert.ok(
      reported.includes('1013500000'),
      'an id above the floor is genuinely new and must still be reported',
    );
  } finally {
    await browser.close();
  }
});

// --- Bot checks on a search page ---------------------------------------------
//
// From a live 3am run: both search tabs were challenged at 03:00:05, stop()
// tore down their timers and observers, and nothing watched anything until a
// tab happened to be recreated thirteen minutes later. The window was open the
// whole time. Stopping is right on a product page -- carting into a challenge
// is the thing this refuses to do -- but a results page is read-only and the
// challenge is usually transient.

const challengeHtml = () =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'walmart-bot-challenge.html'), 'utf8');

test('a challenged search page retries instead of dying', { skip: SKIP }, async () => {
  const browser = await chromium.launch(launchOptions());
  try {
    const tab = await browser.newPage();
    let loads = 0;

    await tab.route('**/*', (route) => {
      if (!route.request().url().startsWith('https://www.target.com/s')) return route.abort();
      loads += 1;
      // Challenged on the first two loads, then it clears -- as they do.
      const body = loads <= 2
        ? challengeHtml()
        : page('<a href="/p/the-drop/-/A-99999999">The Drop ETB</a>');
      return route.fulfill({ status: 200, contentType: 'text/html', body });
    });

    const messages = [];
    await tab.exposeFunction('__pokebotReport', (m) => { messages.push(m); });
    await tab.addInitScript(`
      ${chromeStub({ searchSeconds: 1, onlyNewListings: false }, { report: true })}
      window.addEventListener('DOMContentLoaded', () => {
        ${configWithTinyFloor()}
        ${withBackoff(400)}
      });
    `);

    await tab.goto(URL_, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await tab.waitForTimeout(5000);

    assert.ok(
      loads >= 3,
      `a challenge must not be terminal; the page loaded only ${loads} time(s)`,
    );
    assert.ok(
      messages.some((m) => m.kind === 'challenge'),
      'the first bot check should still be reported',
    );
    assert.ok(
      messages.some((m) => m.kind === 'watching' && /cleared/i.test(m.detail || '')),
      'clearing the challenge should be reported too',
    );

    const ids = messages
      .filter((m) => m.kind === 'discovered')
      .flatMap((m) => m.products.map((p) => p.id));
    assert.ok(
      ids.includes('99999999'),
      'once the challenge clears the watcher must find the drop it exists for',
    );
  } finally {
    await browser.close();
  }
});

test('a persistent challenge is reported more than once', { skip: SKIP }, async () => {
  const browser = await chromium.launch(launchOptions());
  try {
    const tab = await browser.newPage();
    await tab.route('**/*', (route) =>
      route.request().url().startsWith('https://www.target.com/s')
        ? route.fulfill({ status: 200, contentType: 'text/html', body: challengeHtml() })
        : route.abort(),
    );

    const messages = [];
    await tab.exposeFunction('__pokebotReport', (m) => { messages.push(m); });
    await tab.addInitScript(`
      ${chromeStub({ searchSeconds: 1, onlyNewListings: false }, { report: true })}
      window.addEventListener('DOMContentLoaded', () => {
        ${configWithTinyFloor()}
        ${withBackoff(300)}
      });
    `);

    await tab.goto(URL_, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await tab.waitForTimeout(4000);

    const challenges = messages.filter((m) => m.kind === 'challenge');
    assert.ok(challenges.length >= 2, 'a challenge that will not clear needs a person told twice');
    assert.ok(
      challenges.some((m) => /needs you/i.test(m.detail || '')),
      'the follow-up should say plainly that it needs a human',
    );
  } finally {
    await browser.close();
  }
});
