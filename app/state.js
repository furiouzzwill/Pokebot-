'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { resolveSite } = require('../src/sites');

const STATE_FILE = path.resolve(__dirname, '..', 'config', 'app-state.json');
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
};

function emptyState() {
  return { settings: { ...DEFAULT_SETTINGS }, watchlist: [], history: [] };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
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
    watchlist: state.watchlist.map((item) => ({
      ...item,
      status: status.get(item.id) || { kind: 'idle', detail: '', at: null },
    })),
    history: state.history.slice(-100),
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

module.exports = {
  DEFAULT_SETTINGS,
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
