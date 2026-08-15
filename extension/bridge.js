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
// connect() awaits storage before it can open the socket, and the keepalive
// alarm calls it every 30s. Without this the readyState guard below reads a
// stale `socket` during that await and a second socket gets opened.
let connecting = false;
// itemId -> tabId for the tabs this extension opened. Tabs you opened yourself
// are never touched.
const managedTabs = new Map();
// url -> tabId for search tabs opened for a drop window, kept separate so
// closing them at the end of the window can't touch a watchlist tab.
const searchTabs = new Map();

function bridgeLog(...args) {
  console.log('%c[pokebot:bridge]', 'color:#1d3557;font-weight:bold', ...args);
}

async function connect() {
  if (connecting) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  connecting = true;

  // Every handler below closes over `ws` rather than `socket`. A reconnect
  // reassigns `socket`, so an older connection's handlers would otherwise act
  // on whichever socket happens to be current -- sending `hello` on a socket
  // still CONNECTING, which throws and leaves us registered as a dashboard
  // client that never receives the watchlist.
  let ws;
  try {
    const { dashboardToken } = await chrome.storage.local.get('dashboardToken');
    const query = dashboardToken ? `?token=${encodeURIComponent(dashboardToken)}` : '';
    ws = new WebSocket(`ws://127.0.0.1:${DASHBOARD_PORT}/ws${query}`);
  } catch {
    connecting = false;
    setTimeout(connect, RECONNECT_MS);
    return;
  }

  socket = ws;
  connecting = false;

  ws.addEventListener('open', () => {
    bridgeLog('connected to dashboard');
    ws.send(JSON.stringify({ type: 'hello', role: 'extension' }));
  });

  ws.addEventListener('message', async (event) => {
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
      await reconcileSearchTabs(message.searchTabs || []);
    }
  });

  ws.addEventListener('close', () => {
    if (socket === ws) socket = null;
    setTimeout(connect, RECONNECT_MS);
  });
  ws.addEventListener('error', () => ws.close());
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

/**
 * Open the drop-night search tabs, and close them when the window shuts.
 *
 * The search watcher can only see a results page that is actually open in a
 * tab, so relying on you to have left one there is the weakest link in the
 * whole chain: forget it on a Wednesday afternoon and the 9pm window watches
 * nothing at all. The dashboard sends the list while a window is open and an
 * empty list once it closes, so these tabs exist only for the drop.
 */
async function reconcileSearchTabs(urls) {
  const wanted = new Set(urls);

  for (const [url, tabId] of [...searchTabs]) {
    if (!wanted.has(url)) {
      searchTabs.delete(url);
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // Already gone.
      }
    }
  }

  for (const url of wanted) {
    const existing = searchTabs.get(url);
    if (existing !== undefined) {
      try {
        await chrome.tabs.get(existing);
        continue;
      } catch {
        searchTabs.delete(url);
      }
    }
    const tab = await chrome.tabs.create({ url, pinned: true, active: false });
    searchTabs.set(url, tab.id);
    bridgeLog('opened search tab for the drop window', url);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [itemId, id] of managedTabs) {
    if (id === tabId) managedTabs.delete(itemId);
  }
  for (const [url, id] of searchTabs) {
    if (id === tabId) searchTabs.delete(url);
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
