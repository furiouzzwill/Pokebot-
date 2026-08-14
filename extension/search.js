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
 */
const RELOAD_MS = 90 * 1000;
const RELOAD_JITTER_MS = 20 * 1000;

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
  timer: null,
  reloadTimer: null,
  observer: null,
  reported: 0,
};

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
  // Jittered so several open search tabs don't re-query in lockstep, which is
  // both wasteful and a conspicuous traffic pattern.
  const delay = RELOAD_MS + Math.floor(Math.random() * RELOAD_JITTER_MS * 2) - RELOAD_JITTER_MS;
  state.reloadTimer = setTimeout(() => {
    // Reloading into a bot check would just re-trigger it.
    if (!isChallenge()) location.reload();
  }, Math.max(30000, delay));
}

function start() {
  // Results arrive after hydration and again on infinite scroll, so watch the
  // DOM rather than reading once on load.
  state.observer = new MutationObserver(() => tick());
  state.observer.observe(document.body, { childList: true, subtree: true });
  state.timer = setInterval(tick, 3000);
  scheduleReload();
  tick();
  log(`watching ${SITE} results; re-querying about every ${Math.round(RELOAD_MS / 1000)}s`);
}

start();
