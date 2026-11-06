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

// Whether this tab has already recorded what was listed before you started
// watching. Kept in sessionStorage so it survives the periodic reload.
const BASELINE_KEY = `pokebot:baseline:${location.pathname}${location.search}`;
// Results hydrate in stages and lazy-load as they scroll in, so "already
// listed" means anything seen in the first stretch after the tab opened.
const BASELINE_WINDOW_MS = 15 * 1000;

function loadBaselined() {
  try {
    return sessionStorage.getItem(BASELINE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * A tile whose link has rendered but whose name hasn't yet is retried for this
 * long before being reported with only its URL. Reporting it nameless
 * straight away was the bug that lost new drops: the dashboard screens on the
 * title, rejected the blank one, and the id was already marked seen so the
 * tile never got a second chance once its name filled in.
 */
const UNTITLED_GRACE_MS = 8 * 1000;

const startedAt = Date.now();

const state = {
  seen: loadSeen(),
  baselined: loadBaselined(),
  untitled: new Map(), // id -> when first seen without a usable title
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

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Best available name for a product link. The image link usually comes first
 * in a tile and has no text, so every candidate is considered and the longest
 * wins: aria-label, visible text, title attribute, image alt text.
 */
function anchorTitle(anchor) {
  const candidates = [
    anchor.getAttribute('aria-label'),
    anchor.textContent,
    anchor.getAttribute('title'),
    ...[...anchor.querySelectorAll('img[alt]')].map((img) => img.getAttribute('alt')),
  ].map(cleanText);
  return candidates.reduce((best, next) => (next.length > best.length ? next : best), '');
}

// Badge text, prices and ratings get swept up in a tile's textContent; none of
// it is a product name.
const NOT_A_TITLE = /^(?:\$[\d.,]+.*|\d+(?:\.\d)? out of 5.*|sponsored|new|add to cart|shop now)$/i;

/** @returns {Array<{url,id,site,title,fresh}>} products currently on the page. */
function scrape() {
  const pattern = PRODUCT_PATTERNS[SITE];
  // Results pages link the same product from its image and its title, so
  // collect every link per id first and pick the best name across them.
  const byId = new Map();

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

    const id = match[1];
    if (state.seen.has(id)) continue;

    // Drop tracking params so the same product doesn't look like several.
    const clean = `${url.origin}${url.pathname}`;
    let title = anchorTitle(anchor);
    if (NOT_A_TITLE.test(title)) title = '';

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { url: clean, id, site: SITE, title });
    } else if (title.length > existing.title.length) {
      existing.title = title;
    }
  }

  // Inside the baseline window everything on the page was listed before you
  // started watching; after it, a new id is a new listing.
  const fresh = state.baselined || Date.now() - startedAt > BASELINE_WINDOW_MS;

  const found = [];
  for (const product of byId.values()) {
    if (product.title === '') {
      if (!state.untitled.has(product.id)) state.untitled.set(product.id, Date.now());
      // Name may still be rendering; the 3s interval tick comes back for it.
      if (Date.now() - state.untitled.get(product.id) < UNTITLED_GRACE_MS) continue;
    }
    state.untitled.delete(product.id);
    product.title = product.title.slice(0, 160);
    product.fresh = fresh;
    found.push(product);
  }

  if (!state.baselined && Date.now() - startedAt > BASELINE_WINDOW_MS) {
    state.baselined = true;
    try {
      sessionStorage.setItem(BASELINE_KEY, '1');
    } catch {
      // Without storage the next reload re-baselines; the server dedupes by
      // URL, so that costs nothing but the fresh flag on those 90 seconds.
    }
  }

  return found;
}

function report(products) {
  if (products.length === 0) return;
  for (const product of products) state.seen.add(product.id);
  saveSeen(state.seen);
  state.reported += products.length;

  const fresh = products.filter((p) => p.fresh).length;
  log(
    `found ${products.length} product(s), ${fresh} new since you started watching`,
    products.map((p) => `${p.fresh ? 'NEW ' : ''}${p.title || p.id}`),
  );
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
