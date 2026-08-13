'use strict';

/**
 * Links the extension to the local dashboard.
 *
 * The dashboard owns the watchlist and settings; this opens a pinned tab per
 * watched product, keeps them in sync, and relays content-script events back.
 * With no dashboard running the extension still works standalone from the
 * popup -- the bridge just sits there retrying.
 */

const DASHBOARD_PORT = 8787;
const RECONNECT_MS = 4000;

let socket = null;
// itemId -> tabId for the tabs this extension opened. Tabs you opened yourself
// are never touched.
const managedTabs = new Map();

function bridgeLog(...args) {
  console.log('%c[pokebot:bridge]', 'color:#1d3557;font-weight:bold', ...args);
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const { dashboardToken } = await chrome.storage.local.get('dashboardToken');
  const query = dashboardToken ? `?token=${encodeURIComponent(dashboardToken)}` : '';

  try {
    socket = new WebSocket(`ws://127.0.0.1:${DASHBOARD_PORT}/ws${query}`);
  } catch {
    setTimeout(connect, RECONNECT_MS);
    return;
  }

  socket.addEventListener('open', () => {
    bridgeLog('connected to dashboard');
    socket.send(JSON.stringify({ type: 'hello', role: 'extension' }));
  });

  socket.addEventListener('message', async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'sync') {
      // Settings first: a tab must not open and act under stale settings.
      if (message.settings) await chrome.storage.sync.set(message.settings);
      await reconcileTabs(message.watchlist || []);
    }
  });

  socket.addEventListener('close', () => setTimeout(connect, RECONNECT_MS));
  socket.addEventListener('error', () => socket?.close());
}

/** Open tabs for newly watched items, close tabs for ones no longer watched. */
async function reconcileTabs(watchlist) {
  const wanted = new Map(watchlist.map((item) => [item.id, item]));

  for (const [itemId, tabId] of [...managedTabs]) {
    if (!wanted.has(itemId)) {
      managedTabs.delete(itemId);
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // Already gone.
      }
    }
  }

  for (const [itemId, item] of wanted) {
    const existing = managedTabs.get(itemId);
    if (existing !== undefined) {
      // Confirm it's still alive; a user can close a managed tab at any time.
      try {
        await chrome.tabs.get(existing);
        continue;
      } catch {
        managedTabs.delete(itemId);
      }
    }
    const tab = await chrome.tabs.create({ url: item.url, pinned: true, active: false });
    managedTabs.set(itemId, tab.id);
    bridgeLog('opened tab for', item.name);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [itemId, id] of managedTabs) {
    if (id === tabId) managedTabs.delete(itemId);
  }
});

/** Called by background.js for every content-script event. */
function relayEvent(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'event', ...message }));
  }
}

// MV3 service workers are evicted when idle; the alarm wakes this one back up
// so the dashboard link re-establishes itself without user action.
chrome.alarms.create('pokebot-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pokebot-keepalive') connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
