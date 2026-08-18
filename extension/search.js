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

/**
 * On the first load of a results page, everything already listed is recorded as
 * seen without being reported: the point of watching a category page is the
 * product that wasn't there a minute ago, and the shelf it arrives on is not
 * news. Without this the first scrape announces the entire existing catalogue,
 * which -- with auto-add on during a drop window -- means carting whatever old
 * stock happens to be in stock while the actual drop is still minutes away.
 *
 * Time-boxed rather than single-shot because results hydrate after load and
 * again on scroll, so the first tick often sees an empty page. Anything that
 * appears during the baseline period counts as pre-existing.
 *
 * Only ever on the first load in a tab session. A re-query during the drop must
 * report immediately -- re-baselining then would swallow the drop itself.
 */
const BASELINE_MS = 8000;
const BASELINE_KEY = `pokebot:baselined:${location.pathname}${location.search}`;

/**
 * The highest product id present at baseline. Nothing at or below it is ever
 * reported again.
 *
 * Absence from the page is too weak a test for "new". A retailer's first page
 * of results churns constantly as availability flips, so an old set that was
 * out of stock at 02:45 reappears at 03:10 and looks brand new -- which on a
 * live run means carting it. Both retailers issue ids that climb over time, so
 * the newest thing on the shelf when watching starts is a floor: a genuinely
 * new listing is above it, and every reappearing old SKU is below.
 */
const FLOOR_KEY = `pokebot:floor:${location.pathname}${location.search}`;

function toId(value) {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function loadFloor() {
  try {
    return toId(sessionStorage.getItem(FLOOR_KEY) || '0') ?? 0n;
  } catch {
    return 0n;
  }
}

function saveFloor(floor) {
  try {
    sessionStorage.setItem(FLOOR_KEY, floor.toString());
  } catch {
    // Falls back to in-memory for this page load.
  }
}

function alreadyBaselined() {
  try {
    return sessionStorage.getItem(BASELINE_KEY) === '1';
  } catch {
    // No storage: treat as baselined so a failure can't cause the whole page
    // to be announced as new.
    return true;
  }
}

function markBaselined() {
  try {
    sessionStorage.setItem(BASELINE_KEY, '1');
  } catch {
    // Dedupe still falls back to the server's, which keys on product URL.
  }
}

const state = {
  seen: loadSeen(),
  settings: null,
  baselineUntil: 0,
  floor: loadFloor(),
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

function report(allProducts) {
  // Below the floor is an old SKU resurfacing, not a drop. Marked seen so it
  // is not reconsidered every tick.
  const products = [];
  for (const product of allProducts) {
    const id = toId(product.id);
    if (state.floor > 0n && (id === null || id <= state.floor)) {
      state.seen.add(product.id);
      continue;
    }
    products.push(product);
  }
  if (products.length !== allProducts.length) saveSeen(state.seen);

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

  const found = scrape();

  // While baselining, everything on the page is pre-existing stock: absorb it
  // and report nothing. finishBaseline() ends this on its own timer.
  if (state.baselineUntil) {
    for (const product of found) state.seen.add(product.id);
    if (found.length > 0) saveSeen(state.seen);
    return;
  }

  report(found);
}

/**
 * End the baseline period.
 *
 * On its own timer rather than waiting for a tick to land past the deadline:
 * ticks are 3s apart and a re-query can reload the page before one arrives, in
 * which case the baseline would never complete, the session flag would never be
 * set, and the watcher would re-baseline on every load -- reporting nothing at
 * all, on the one night it matters.
 */
function finishBaseline() {
  if (!state.baselineUntil) return;

  for (const product of scrape()) state.seen.add(product.id);
  saveSeen(state.seen);

  for (const seenId of state.seen) {
    const id = toId(seenId);
    if (id !== null && id > state.floor) state.floor = id;
  }
  saveFloor(state.floor);

  state.baselineUntil = 0;
  markBaselined();

  log(
    `baselined ${state.seen.size} existing listing(s); `
    + `reporting only ids above ${state.floor}`,
  );
  try {
    chrome.runtime.sendMessage({
      kind: 'baseline',
      detail:
        `Ignoring ${state.seen.size} listing(s) already on this page. `
        + 'Only products that appear from now on will be reported.',
      site: SITE,
      url: location.href,
    });
  } catch {
    // Service worker asleep; the console still has it.
  }
}

function stop() {
  clearInterval(state.timer);
  clearTimeout(state.reloadTimer);
  state.observer?.disconnect();
}

function scheduleReload() {
  clearTimeout(state.reloadTimer);

  let base = reloadSeconds(state.settings) * 1000;

  // A reload mid-baseline would discard it and start over. Hold the re-query
  // until the baseline has completed, however short the interval is set.
  const remaining = state.baselineUntil - Date.now();
  if (remaining > 0) base = Math.max(base, remaining + 500);
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

  if (state.settings.onlyNewListings && !alreadyBaselined()) {
    state.baselineUntil = Date.now() + BASELINE_MS;
    setTimeout(finishBaseline, BASELINE_MS);
    log('baselining what is already listed; nothing will be reported for a moment');
  }

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
