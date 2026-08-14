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

  // --- Discord --------------------------------------------------------------
  // Credentials live in .env, not here. These only decide whether to use them.
  discordAlerts: true,
  discordPollSeconds: 15,
};

/** Subreddits and keywords are lists, kept out of the numeric/boolean block. */
const DEFAULT_RULES = {
  subreddits: ['pkmntcgdeals', 'PokeInvesting'],
  keywords: ['pokemon', 'pokémon', 'elite trainer', 'booster bundle', 'etb'],
};

function emptyState() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    rules: { ...DEFAULT_RULES },
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
    next[key] = typeof DEFAULT_SETTINGS[key] === 'boolean' ? Boolean(value) : Number(value);
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

function setRules(patch) {
  const next = { ...state.rules };
  for (const field of ['subreddits', 'keywords']) {
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
