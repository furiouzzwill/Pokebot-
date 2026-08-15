'use strict';

/**
 * Finds newly listed products on retailer search and category pages.
 *
 * A drop's product page often does not exist until minutes before it goes
 * live, so there is nothing to paste into the watchlist ahead of time. This
 * watches a search page in a real tab and reports product links as they
 * appear, which is how a new SKU gets picked up without anyone noticing it
 * manually.
 *
 * Runs in your own session for the same reason as the rest of the extension:
 * both retailers refuse plain HTTP clients, and Target's search results are
 * rendered client-side so they only exist after hydration.
 */

const SITE = location.hostname.includes('walmart') ? 'walmart' : 'target';

/**
 * Product links are matched by URL shape, not by CSS class. Retailers restyle
 * constantly but cannot change these paths without breaking every existing
 * link to their own catalogue, so this survives redesigns that would break a
 * selector-based scraper.
 */
const PRODUCT_PATTERNS = {
  target: /^\/p\/[^/]+\/-\/A-(\d+)/,
  walmart: /^\/ip\/(?:[^/?#]+\/)?(\d{4,})/,
};

/**
 * A results page is a snapshot: it never updates itself, so the page must be
 * re-queried to see a product that appeared after load. Without this the whole
 * watcher is useless for its actual job -- you'd load a search in the evening
 * and its DOM would still show the evening's results when the drop lands.
 *
 * The interval comes from settings, because the right answer differs by two
 * orders of magnitude: idling on a Tuesday, 90 seconds is plenty and anything
 * faster is a conspicuous traffic pattern for no gain. At 9pm on drop night,
 * 90 seconds is the difference between carting and reading about it.
 */
const JITTER_FRACTION = 0.2;

// Reported ids survive the reload in sessionStorage, so a refresh doesn't
// re-announce the whole page as new. Cleared when the tab closes.
const SEEN_KEY = `pokebot:seen:${location.pathname}${location.search}`;

function loadSeen() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-500)));
  } catch {
    // Storage full or blocked; dedupe falls back to the server's, which keys
    // on product URL anyway.
  }
}

const state = {
  seen: loadSeen(),
  settings: null,
  timer: null,
  reloadTimer: null,
  observer: null,
  reported: 0,
};

/** Seconds between re-queries, given whether a drop window is open. */
function reloadSeconds(settings) {
  const chosen = settings.dropActive ? settings.dropSearchSeconds : settings.searchSeconds;
  const seconds = Number(chosen);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULTS.searchSeconds;
  return Math.max(MIN_SEARCH_SECONDS, seconds);
}

function log(...args) {
  console.log('%c[pokebot:search]', 'color:#1d3557;font-weight:bold', ...args);
}

function isChallenge() {
  return (
    /robot or human|confirm that you'?re human|access denied/i.test(document.title) ||
    document.querySelector('#px-captcha') !== null
  );
}

/** @returns {Array<{url,id,site,title}>} products currently on the page. */
function scrape() {
  const pattern = PRODUCT_PATTERNS[SITE];
  const found = [];
  // Results pages link the same product from its image and its title, so a
  // pass must dedupe against itself as well as against earlier passes --
  // state.seen is only written once the batch is reported.
  const thisPass = new Set();

  for (const anchor of document.querySelectorAll('a[href]')) {
    let url;
    try {
      url = new URL(anchor.getAttribute('href'), location.origin);
    } catch {
      continue;
    }
    if (url.hostname !== location.hostname) continue;

    const match = pattern.exec(url.pathname);
    if (!match) continue;

    // Drop tracking params so the same product doesn't look like several.
    const clean = `${url.origin}${url.pathname}`;
    const id = match[1];
    if (state.seen.has(id) || thisPass.has(id)) continue;
    thisPass.add(id);

    const title =
      (anchor.getAttribute('aria-label') || anchor.textContent || '').replace(/\s+/g, ' ').trim();

    found.push({ url: clean, id, site: SITE, title: title.slice(0, 140) });
  }

  // Newest first. Both retailers issue ids that climb over time, so the
  // highest id on the page is the most recently listed product -- which on a
  // drop night is exactly the one worth reporting before the rest. DOM order
  // is relevance order, which buries a brand new SKU.
  found.sort((a, b) => {
    const left = BigInt(a.id);
    const right = BigInt(b.id);
    if (left === right) return 0;
    return left > right ? -1 : 1;
  });

  return found;
}

function report(products) {
  if (products.length === 0) return;
  for (const product of products) state.seen.add(product.id);
  saveSeen(state.seen);
  state.reported += products.length;

  log(`found ${products.length} product(s)`, products.map((p) => p.title || p.id));
  try {
    chrome.runtime.sendMessage({
      kind: 'discovered',
      detail: `${products.length} product(s) on ${SITE} search`,
      site: SITE,
      url: location.href,
      products,
    });
  } catch {
    // Service worker asleep; the next tick will retry with the same batch
    // excluded, which is fine -- discovery is best-effort by nature.
  }
}

function tick() {
  if (isChallenge()) {
    log('bot check on this page; stopping');
    stop();
    try {
      chrome.runtime.sendMessage({
        kind: 'challenge',
        detail: 'Search page hit a bot check. Solve it and reload.',
        site: SITE,
        url: location.href,
      });
    } catch {
      // Nothing more to do.
    }
    return;
  }
  report(scrape());
}

function stop() {
  clearInterval(state.timer);
  clearTimeout(state.reloadTimer);
  state.observer?.disconnect();
}

function scheduleReload() {
  clearTimeout(state.reloadTimer);

  const base = reloadSeconds(state.settings) * 1000;
  // Jittered so several open search tabs don't re-query in lockstep, which is
  // both wasteful and a conspicuous traffic pattern.
  const spread = base * JITTER_FRACTION;
  const delay = base + Math.floor(Math.random() * spread * 2) - spread;

  state.reloadTimer = setTimeout(() => {
    // Reloading into a bot check would just re-trigger it.
    if (!isChallenge()) location.reload();
  }, Math.max(MIN_SEARCH_SECONDS * 1000, delay));
}

/**
 * Re-read settings without a reload, so a window opening at 9pm speeds up a
 * tab that has been sitting there since the afternoon. Reloading the tab to
 * pick up the new interval would be the one thing guaranteed to make it miss
 * the first seconds of the drop.
 */
async function applySettings() {
  const previous = state.settings;
  state.settings = await loadSettings();
  if (!previous) return;

  if (reloadSeconds(state.settings) !== reloadSeconds(previous)) {
    log(
      `re-query interval now ~${reloadSeconds(state.settings)}s`,
      state.settings.dropActive ? '(drop window open)' : '',
    );
    scheduleReload();
  }
}

async function start() {
  state.settings = await loadSettings();

  // Results arrive after hydration and again on infinite scroll, so watch the
  // DOM rather than reading once on load.
  state.observer = new MutationObserver(() => tick());
  state.observer.observe(document.body, { childList: true, subtree: true });
  state.timer = setInterval(tick, 3000);

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'sync') applySettings();
  });

  scheduleReload();
  tick();
  log(`watching ${SITE} results; re-querying about every ${reloadSeconds(state.settings)}s`);
}

start();
