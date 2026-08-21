'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { resolveSite } = require('../src/sites');

// Running from source this sits next to the repo's config/. The desktop build
// overrides it, because there __dirname is inside app.asar -- an archive file,
// not a directory, so creating the parent fails with ENOTDIR on the first
// write. The install directory isn't user-writable either.
const STATE_FILE = process.env.POKEBOT_STATE_FILE
  ? path.resolve(process.env.POKEBOT_STATE_FILE)
  : path.resolve(__dirname, '..', 'config', 'app-state.json');
const MAX_HISTORY = 500;

/**
 * Settings mirrored down to the extension. Names match extension/config.js so
 * the dashboard is the single source of truth and the popup just reflects it.
 */
const DEFAULT_SETTINGS = {
  armed: false,
  dryRun: true,
  maxPrice: 100,
  minPrice: 0,
  maxCarts: 1,
  pollMs: 1000,
  reloadSeconds: 0,
  goToCartAfterAdd: true,
  autoCheckout: false,
  placeOrder: false,
  maxOrderTotal: 150,
  maxOrderItems: 2,
  maxOrdersPerDay: 1,

  // --- Discovery ------------------------------------------------------------
  // Finds products you haven't added yet: announcements from subreddits, and
  // product links appearing on retailer search pages you have open.
  discoveryEnabled: true,
  // Minutes between subreddit polls. Reddit rate-limits unauthenticated
  // polling, so this is deliberately unhurried; the search-page watcher is
  // what catches a URL quickly.
  redditIntervalMinutes: 5,
  // Add matching finds straight to the watchlist, enabled. Off by default:
  // an auto-added URL that turns out to be the wrong item would be armed
  // against your real payment method.
  autoAddDiscoveries: false,

  // --- Scheduled drops ------------------------------------------------------
  // A retailer restock happens at a fixed local time and the product page
  // often does not exist until it does. Inside the window the search watcher
  // re-queries far harder than it would the rest of the week.
  dropScheduleEnabled: false,
  dropTime: '21:00',
  // An IANA zone, not an offset: see src/discovery/schedule.js.
  dropTimeZone: 'America/New_York',
  dropLeadMinutes: 10,
  dropTrailMinutes: 20,
  // Seconds between search-page re-queries, outside the window and inside it.
  searchSeconds: 90,
  dropSearchSeconds: 10,
  // Add matching finds straight to the watchlist, but only inside the window.
  // Narrower than autoAddDiscoveries, which does it around the clock.
  autoAddDuringDrop: false,
  // Open the search pages below as pinned tabs while the window is open, and
  // close them when it shuts. Without this the watcher only ever sees a tab
  // you remembered to leave open yourself.
  openSearchDuringDrop: true,
  // Ignore everything already listed when a search tab opens, and report only
  // what appears afterwards. This is what keeps a drop-night run from carting
  // old stock that merely happens to be in stock.
  onlyNewListings: true,
  // Hard ceiling on how many finds one drop window may auto-add. Each added
  // item opens its own pinned tab and carts independently -- maxCarts is per
  // tab, so thirteen tabs is thirteen carts, and thirteen tabs hammering a
  // retailer is the traffic pattern that earns a bot check.
  maxAutoAddsPerWindow: 2,

  // --- Discord --------------------------------------------------------------
  // Credentials live in .env, not here. These only decide whether to use them.
  discordAlerts: true,
  discordPollSeconds: 15,
};

/** Subreddits and keywords are lists, kept out of the numeric/boolean block. */
const DEFAULT_RULES = {
  subreddits: ['pkmntcgdeals', 'PokeInvesting'],
  // Deliberately loose. The set that drops on a given Wednesday isn't knowable
  // in advance, so these match the brand and the product *type* -- both of
  // which outlive any particular set -- and excludeKeywords does the rejecting.
  // Tightening this instead would miss the very drop it exists to catch, and
  // 'pokemon' is also what matches a Reddit announcement, which never mentions
  // a product type at all.
  keywords: [
    'pokemon', 'pokémon',
    'booster bundle', 'elite trainer box', 'etb', 'booster box', 'booster pack',
    'collection box', 'premium collection', 'surprise box', 'binder collection',
  ],
  // Rejected even when a keyword matched. A Pokemon search page is mostly
  // merchandise, and matching loosely enough to catch an unknown set means
  // catching all of that too.
  excludeKeywords: [
    'sock', 'plush', 'figure', 'shirt', 'hoodie', 'backpack', 'lunch',
    'sleeve', 'binder page', 'toploader', 'blanket', 'mug', 'poster',
    'costume', 'puzzle', 'single card', 'psa ', 'graded',
  ],
  // Weekdays the drop schedule fires on. Walmart's Pokemon restocks are a
  // Wednesday-night fixture, hence the default.
  dropDays: ['wednesday'],
  // Search or category pages to watch during a drop window. Sorted newest
  // first, because relevance ranking buries a brand new SKU.
  searchUrls: [],
};

/**
 * Per-retailer profile: the hunt.
 *
 * Walmart restocks on Wednesday at 9pm; Target's good drops are pre-orders at
 * 3am on another day entirely, at different prices. One global schedule cannot
 * express both, and editing it before every drop is how the wrong number ends
 * up live at 3am. What stays global is the master switches -- armed, dry run,
 * whether an order may be placed at all, and the daily order budget, which is
 * a budget across everything rather than per retailer.
 */
const DEFAULT_SITE = {
  minPrice: 0,
  maxPrice: 100,
  maxOrderTotal: 150,
  maxOrderItems: 2,

  // Target's sought-after drops are pre-orders, and a pre-order button says
  // "Preorder", not "Add to cart" -- so it is invisible unless this is on.
  // Off by default: on a restock night a pre-order is the wrong thing to buy.
  allowPreorders: false,

  dropScheduleEnabled: false,
  dropTime: '21:00',
  dropTimeZone: 'America/New_York',
  dropLeadMinutes: 15,
  // Generous by default. A restock is over in ninety seconds, but a pre-order
  // drop trickles: listings appeared thirteen minutes late on a live 3am run,
  // and closing at +30 meant standing there watching nothing. Staying open
  // costs a re-query every ten seconds and nothing else.
  dropTrailMinutes: 90,
  searchSeconds: 90,
  dropSearchSeconds: 10,
  autoAddDuringDrop: false,
  maxAutoAddsPerWindow: 1,

  // Lists live in the profile too, so a retailer's schedule and the pages it
  // watches travel together.
  dropDays: ['wednesday'],
  searchUrls: [],
};

const SITE_KEYS = ['walmart', 'target'];

function defaultSites() {
  return {
    walmart: { ...DEFAULT_SITE, dropDays: ['wednesday'], dropTime: '21:00' },
    target: {
      ...DEFAULT_SITE,
      dropDays: ['tuesday'],
      dropTime: '03:00',
      // Pre-orders trickle in for longer than a restock does.
      dropTrailMinutes: 120,
      // The reason this profile exists.
      allowPreorders: true,
    },
  };
}

function emptyState() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    rules: { ...DEFAULT_RULES },
    sites: defaultSites(),
    watchlist: [],
    history: [],
    discoveries: [],
  };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      rules: { ...DEFAULT_RULES, ...(parsed.rules || {}) },
      // A state file written before profiles existed has no `sites`; each
      // retailer falls back to its default rather than to nothing.
      sites: Object.fromEntries(
        SITE_KEYS.map((key) => [
          key,
          { ...defaultSites()[key], ...((parsed.sites || {})[key] || {}) },
        ]),
      ),
      watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      discoveries: Array.isArray(parsed.discoveries) ? parsed.discoveries : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[pokebot] state file unreadable (${err.message}); starting fresh`);
    }
    return emptyState();
  }
}

let state = load();

function persist() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // Write-then-rename so a crash mid-write can't truncate the watchlist.
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function getState() {
  return state;
}

/** Live per-item status, rebuilt on restart rather than persisted. */
const status = new Map();

function snapshot() {
  return {
    settings: state.settings,
    rules: state.rules,
    sites: state.sites,
    watchlist: state.watchlist.map((item) => ({
      ...item,
      status: status.get(item.id) || { kind: 'idle', detail: '', at: null },
    })),
    history: state.history.slice(-100),
    discoveries: state.discoveries.slice(0, 40),
  };
}

function addItem({ url, name }) {
  const trimmed = String(url || '').trim();
  // resolveSite throws on anything that isn't a supported product URL, which
  // is exactly the validation we want before it reaches the extension.
  const { adapter } = resolveSite(trimmed);

  if (state.watchlist.some((item) => item.url === trimmed)) {
    throw new Error('That URL is already on the watchlist');
  }

  const item = {
    id: crypto.randomUUID(),
    url: trimmed,
    name: String(name || '').trim() || trimmed,
    site: adapter.key,
    enabled: true,
    addedAt: new Date().toISOString(),
  };
  state.watchlist.push(item);
  persist();
  return item;
}

function removeItem(id) {
  const before = state.watchlist.length;
  state.watchlist = state.watchlist.filter((item) => item.id !== id);
  status.delete(id);
  if (state.watchlist.length !== before) persist();
}

function setItemEnabled(id, enabled) {
  const item = state.watchlist.find((entry) => entry.id === id);
  if (!item) return null;
  item.enabled = Boolean(enabled);
  if (!item.enabled) status.delete(id);
  persist();
  return item;
}

function setSettings(patch) {
  const next = { ...state.settings };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULT_SETTINGS)) continue;

    // Coerce to the shape of the default. Everything used to go through
    // Number(), which turned a wall-clock time or a timezone name into NaN --
    // and NaN persists as null, so one bad write poisoned the setting for good.
    const shape = typeof DEFAULT_SETTINGS[key];
    if (shape === 'boolean') {
      next[key] = Boolean(value);
    } else if (shape === 'number') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) next[key] = parsed;
    } else {
      next[key] = String(value);
    }
  }
  // placeOrder can never fire without autoCheckout; keep stored state honest
  // rather than relying on the UI to enforce it.
  if (!next.autoCheckout) next.placeOrder = false;
  state.settings = next;
  persist();
  return next;
}

function matchItem(url) {
  if (!url) return null;
  return state.watchlist.find((item) => url.startsWith(item.url.split('?')[0])) || null;
}

/** Record an event from the extension and update the item's live status. */
function recordEvent({ kind, detail, url, site }) {
  const item = matchItem(url);
  const entry = {
    at: new Date().toISOString(),
    kind,
    detail: detail || '',
    url: url || '',
    site: site || (item && item.site) || '',
    itemId: item ? item.id : null,
    name: item ? item.name : null,
  };

  if (item) status.set(item.id, { kind, detail: detail || '', at: entry.at });

  // Routine heartbeats would bury the events that matter.
  if (kind !== 'watching') {
    state.history.push(entry);
    if (state.history.length > MAX_HISTORY) {
      state.history = state.history.slice(-MAX_HISTORY);
    }
    persist();
  }

  return entry;
}

const MAX_DISCOVERIES = 200;

/**
 * Record something discovery found. Deduped on `key` (a reddit post id, or a
 * product URL) so the same find re-seen on every poll doesn't pile up.
 *
 * @returns {object|null} the stored candidate, or null if already known.
 */
function addDiscovery({ key, kind, title, url, site, source, matched = [] }) {
  if (!key) return null;
  if (state.discoveries.some((d) => d.key === key)) return null;

  // A product already on the watchlist is not a discovery.
  if (url && state.watchlist.some((item) => item.url === url)) return null;

  const entry = {
    key,
    kind, // 'product' (has a usable URL) | 'announcement' (a heads-up only)
    title: title || url || key,
    url: url || '',
    site: site || '',
    source: source || '',
    matched,
    at: new Date().toISOString(),
    dismissed: false,
  };

  state.discoveries.unshift(entry);
  if (state.discoveries.length > MAX_DISCOVERIES) {
    state.discoveries = state.discoveries.slice(0, MAX_DISCOVERIES);
  }
  persist();
  return entry;
}

function dismissDiscovery(key) {
  const entry = state.discoveries.find((d) => d.key === key);
  if (!entry) return null;
  entry.dismissed = true;
  persist();
  return entry;
}

/**
 * Update one retailer's profile.
 *
 * Coerces to the shape of the default the same way setSettings does, and for
 * the same reason: a wall-clock time or a zone name put through Number()
 * becomes NaN, and NaN persists as null.
 */
function setSiteSettings(site, patch) {
  if (!SITE_KEYS.includes(site)) throw new Error(`Unknown retailer: ${site}`);

  const next = { ...state.sites[site] };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULT_SITE)) continue;

    const shape = DEFAULT_SITE[key];
    if (Array.isArray(shape)) {
      if (!Array.isArray(value)) continue;
      next[key] = value.map((entry) => String(entry).trim()).filter((entry) => entry !== '');
    } else if (typeof shape === 'boolean') {
      next[key] = Boolean(value);
    } else if (typeof shape === 'number') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) next[key] = parsed;
    } else {
      next[key] = String(value);
    }
  }

  state.sites = { ...state.sites, [site]: next };
  persist();
  return next;
}

function setRules(patch) {
  const next = { ...state.rules };
  for (const field of ['subreddits', 'keywords', 'excludeKeywords', 'dropDays', 'searchUrls']) {
    if (!Array.isArray(patch?.[field])) continue;
    next[field] = patch[field]
      .map((value) => String(value).trim())
      .filter((value) => value !== '');
  }
  state.rules = next;
  persist();
  return next;
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_RULES,
  addDiscovery,
  dismissDiscovery,
  setRules,
  setSiteSettings,
  DEFAULT_SITE,
  SITE_KEYS,
  STATE_FILE,
  getState,
  snapshot,
  addItem,
  removeItem,
  setItemEnabled,
  setSettings,
  recordEvent,
  status,
};
