'use strict';

/**
 * Dashboard server: static UI + a WebSocket hub joining the browser dashboard
 * to the extension's service worker.
 *
 * The server never touches a retailer site. It holds the watchlist and
 * settings, tells the extension what to watch, and collects what comes back.
 * All clicking stays in your real browser session, where it works.
 *
 * Exported as a factory so the Electron shell can host it in-process, while
 * `npm run app` keeps reading configuration from the environment.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { WebSocketServer } = require('ws');

const state = require('./state');
const { fetchSubreddit, matchKeywords, firstExclusion } = require('../src/discovery/reddit');
const { dropWindow, scheduleFrom } = require('../src/discovery/schedule');
const discordIn = require('../src/discovery/discord');
const { postAlert, DEFAULT_EVENTS } = require('../src/discord');

/**
 * Discord credentials come from the environment, never from the state file.
 * A webhook URL and a bot token are both bearer credentials, and app-state
 * gets copied around, backed up and pasted into chats far too easily.
 */
function discordConfig() {
  return {
    webhookUrl: (process.env.DISCORD_WEBHOOK_URL || '').trim(),
    botToken: (process.env.DISCORD_BOT_TOKEN || '').trim(),
    channelIds: (process.env.DISCORD_CHANNEL_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    mention: (process.env.DISCORD_MENTION || '').trim(),
  };
}

const DEFAULT_PORT = 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

/**
 * Build (but do not start) the dashboard server.
 *
 * @param {object} options
 * @param {number} options.port   0 picks a free port (used by tests).
 * @param {boolean} options.lan   Bind to all interfaces instead of loopback.
 * @param {string} options.token  Required when lan is true.
 * @throws when LAN mode is requested without a token.
 */
function createDashboard({ port = DEFAULT_PORT, lan = false, token = '' } = {}) {
  const LAN = Boolean(lan);
  const TOKEN = String(token || '').trim();
  const HOST = LAN ? '0.0.0.0' : '127.0.0.1';

  if (LAN && TOKEN === '') {
    throw new Error(
      'LAN mode exposes the dashboard on your network, so a token is required.\n' +
        `Generate one:  POKEBOT_TOKEN=${crypto.randomBytes(12).toString('hex')}`,
    );
  }

  function authorised(req) {
    if (!LAN) return true; // Loopback only; nothing else can reach it.
    const url = new URL(req.url, 'http://localhost');
    const supplied =
      url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer /, '');
    if (supplied.length !== TOKEN.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(TOKEN));
  }

  const server = http.createServer((req, res) => {
    if (!authorised(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized: append ?token=<POKEBOT_TOKEN>');
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const name = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.join(PUBLIC_DIR, name);

    // Refuse anything that escapes the public dir.
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      });
      res.end(body);
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set(); // { socket, role }

  server.on('upgrade', (req, socket, head) => {
    if (!authorised(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function broadcast(message, role = null) {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (role && client.role !== role) continue;
      if (client.socket.readyState === 1) client.socket.send(payload);
    }
  }

  function hasExtension() {
    for (const client of clients) if (client.role === 'extension') return true;
    return false;
  }

  /**
   * Whether a scheduled drop window is open right now.
   *
   * Computed here rather than in the extension so the timezone and DST
   * arithmetic lives in one testable place, and the content scripts only ever
   * see a boolean.
   */
  function dropState() {
    const { settings, rules } = state.getState();
    return dropWindow(new Date(), scheduleFrom(settings, rules));
  }

  /**
   * Search pages the extension should have open right now.
   *
   * Only while a drop window is open, and only ever on a retailer host. This
   * list becomes chrome.tabs.create() calls in a browser you are logged into,
   * so it is not somewhere to trust whatever ended up in the settings file.
   */
  function searchTabsFor(drop) {
    const { settings, rules } = state.getState();
    if (!drop.active || !settings.openSearchDuringDrop) return [];

    const allowed = new Set(['www.walmart.com', 'www.target.com']);
    const urls = [];
    for (const raw of rules.searchUrls || []) {
      let parsed;
      try {
        parsed = new URL(String(raw).trim());
      } catch {
        continue;
      }
      if (parsed.protocol !== 'https:' || !allowed.has(parsed.hostname)) continue;
      urls.push(parsed.toString());
    }
    return urls;
  }

  /** Push watchlist + settings to the extension, and full state to dashboards. */
  function syncAll() {
    const snap = state.snapshot();
    const drop = dropState();

    broadcast({ type: 'state', ...snap, drop }, 'dashboard');
    broadcast(
      {
        type: 'sync',
        // dropActive rides along with settings so the search watcher picks it
        // up through the same storage.onChanged path as everything else.
        settings: { ...snap.settings, dropActive: drop.active },
        watchlist: snap.watchlist
          .filter((item) => item.enabled)
          .map(({ id, url, name, site }) => ({ id, url, name, site })),
        searchTabs: searchTabsFor(drop),
      },
      'extension',
    );
  }

  /**
   * The window opens and closes on wall-clock time, with nothing else
   * necessarily happening at that moment, so it needs its own tick. Only a
   * change is broadcast -- re-syncing every 15s would restart the extension's
   * tabs for no reason.
   */
  let lastDropActive = null;
  function watchDropWindow() {
    const { active } = dropState();
    if (active !== lastDropActive) {
      const first = lastDropActive === null;
      lastDropActive = active;
      if (!first) {
        state.recordEvent({
          kind: active ? 'drop-window-open' : 'drop-window-closed',
          detail: active
            ? 'Drop window open -- search tabs re-querying hard.'
            : 'Drop window closed -- back to the normal interval.',
        });
      }
      syncAll();
    }
  }

  const HANDLERS = {
    hello(client, message) {
      client.role = message.role === 'extension' ? 'extension' : 'dashboard';
      broadcast({ type: 'presence', extension: hasExtension() }, 'dashboard');
      syncAll();
    },

    addItem(client, message) {
      try {
        state.addItem({ url: message.url, name: message.name });
        syncAll();
      } catch (err) {
        client.socket.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    },

    removeItem(client, message) {
      state.removeItem(message.id);
      syncAll();
    },

    toggleItem(client, message) {
      state.setItemEnabled(message.id, message.enabled);
      syncAll();
    },

    setSettings(client, message) {
      state.setSettings(message.settings);
      syncAll();
    },

    setRules(client, message) {
      state.setRules(message.rules);
      syncAll();
    },

    /** Promote a discovered product onto the watchlist. */
    acceptDiscovery(client, message) {
      const found = state.getState().discoveries.find((d) => d.key === message.key);
      if (!found || !found.url) return;
      try {
        state.addItem({ url: found.url, name: found.title });
        state.dismissDiscovery(found.key);
        syncAll();
      } catch (err) {
        client.socket.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    },

    dismissDiscovery(client, message) {
      state.dismissDiscovery(message.key);
      syncAll();
    },

    /** Relayed from a content script via the extension's service worker. */
    event(client, message) {
      // Search pages report products rather than stock changes.
      if (message.kind === 'discovered' && Array.isArray(message.products)) {
        ingestSearchProducts(message.products);
        return;
      }
      const entry = state.recordEvent(message);
      broadcast({ type: 'event', entry }, 'dashboard');
      broadcast({ type: 'state', ...state.snapshot() }, 'dashboard');
      announce(entry);
    },
  };

  /**
   * Mirror an event into Discord.
   *
   * Only the events worth interrupting people for, and never blocking: a
   * failed alert is logged and dropped rather than retried, because a drop
   * does not wait for a webhook.
   */
  function announce(entry) {
    const { webhookUrl, mention } = discordConfig();
    const { settings } = state.getState();
    if (!webhookUrl || !settings.discordAlerts) return;
    if (!DEFAULT_EVENTS.includes(entry.kind)) return;

    // Only the events that need a human right now get to ping the channel.
    const shouldMention = mention && ['in-stock', 'carted', 'challenge'].includes(entry.kind);

    postAlert(webhookUrl, {
      kind: entry.kind,
      title: entry.name || entry.title || '',
      detail: entry.detail || '',
      url: entry.url || '',
      site: entry.site || '',
      source: entry.source || '',
      mention: shouldMention ? mention : undefined,
    }).then((result) => {
      if (!result.ok && result.error) {
        console.error(`[pokebot] discord alert failed: ${result.error}`);
      }
    });
  }

  /**
   * Products scraped off a retailer search page. Only those whose title
   * matches a keyword are kept -- a search results page is full of things you
   * did not ask for.
   */
  function ingestSearchProducts(products) {
    const { rules, settings } = state.getState();
    if (!settings.discoveryEnabled) return;

    let added = 0;
    for (const product of products) {
      if (!product || !product.url) continue;
      const title = product.title || product.url;
      const matched = matchKeywords(title, rules.keywords);
      if (rules.keywords.length > 0 && matched.length === 0) continue;

      // Checked after the positive match, so the log says which word did it.
      const excluded = firstExclusion(title, rules.excludeKeywords);
      if (excluded) {
        state.recordEvent({
          kind: 'filtered',
          detail: `Ignored "${title.slice(0, 80)}" -- matched exclusion "${excluded}".`,
          url: product.url,
          site: product.site,
        });
        continue;
      }

      const entry = state.addDiscovery({
        key: product.url,
        kind: 'product',
        title: product.title || product.url,
        url: product.url,
        site: product.site,
        source: 'search page',
        matched,
      });
      if (entry) {
        added += 1;
        announce({ kind: 'discovered', name: entry.title, url: entry.url, site: entry.site, source: entry.source });
      }
    }
    if (added > 0) autoAddOrAnnounce();
  }

  /**
   * Poll the configured Discord channels for links your group has shared.
   *
   * Cursors are per channel and start empty, so the first poll takes only the
   * latest handful rather than replaying an entire channel history as fresh
   * finds.
   */
  const discordCursors = new Map();
  let discordBackoff = 1;

  async function pollDiscord() {
    const { botToken, channelIds } = discordConfig();
    const { settings, rules } = state.getState();
    if (!settings.discoveryEnabled || !botToken || channelIds.length === 0) return;

    let limited = false;

    for (const channelId of channelIds) {
      const afterId = discordCursors.get(channelId) || null;
      const result = await discordIn.fetchMessages(botToken, channelId, {
        afterId,
        limit: afterId ? 50 : 10,
      });

      if (result.rateLimited) {
        limited = true;
        continue;
      }
      if (result.error) {
        console.error(`[pokebot] discord channel ${channelId}: ${result.error}`);
        continue;
      }

      const newest = discordIn.newestId(result.messages);
      if (newest) discordCursors.set(channelId, newest);

      for (const found of discordIn.parseMessages(result.messages, { keywords: rules.keywords })) {
        const entry = state.addDiscovery({
          key: found.key,
          kind: found.kind,
          title: found.title,
          url: found.url,
          site: found.site,
          source: `discord · ${found.author}`,
          matched: found.matched,
        });
        if (entry && entry.kind === 'product') {
          announce({ kind: 'discovered', name: entry.title, url: entry.url, site: entry.site, source: entry.source });
        }
      }
    }

    discordBackoff = limited ? Math.min(discordBackoff * 2, 8) : 1;
    autoAddOrAnnounce();
  }

  function autoAddOrAnnounce() {
    const { settings } = state.getState();
    // Inside a drop window autoAddDuringDrop stands in for the always-on
    // setting: the whole point of the window is that there is no time to press
    // Watch. Everything downstream is unchanged, so an auto-added item still
    // meets the price cap, the per-order limits and the daily order ledger.
    const autoAdd =
      settings.autoAddDiscoveries || (settings.autoAddDuringDrop && dropState().active);
    if (autoAdd) {
      for (const found of [...state.getState().discoveries]) {
        if (found.dismissed || found.kind !== 'product' || !found.url) continue;
        try {
          state.addItem({ url: found.url, name: found.title });
          state.dismissDiscovery(found.key);
        } catch {
          // Already on the list, or not a supported URL.
        }
      }
    }
    syncAll();
  }

  wss.on('connection', (socket) => {
    const client = { socket, role: 'dashboard' };
    clients.add(client);

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const handler = HANDLERS[message.type];
      if (handler) handler(client, message);
    });

    socket.on('close', () => {
      clients.delete(client);
      broadcast({ type: 'presence', extension: hasExtension() }, 'dashboard');
    });

    socket.on('error', () => clients.delete(client));
  });

  /**
   * Poll the configured subreddits for drop announcements.
   *
   * Announcements arrive before a listing exists, so most yield no URL -- they
   * are still worth surfacing, because they tell you when to be at the machine.
   * On a 429 the interval doubles for the next round rather than retrying.
   */
  let redditBackoff = 1;

  async function pollReddit() {
    const { settings, rules } = state.getState();
    if (!settings.discoveryEnabled || rules.subreddits.length === 0) return;

    let limited = false;

    for (const subreddit of rules.subreddits) {
      const result = await fetchSubreddit(subreddit, { keywords: rules.keywords });

      if (result.rateLimited) {
        limited = true;
        continue;
      }
      if (result.error) continue;

      for (const post of result.entries) {
        // A post carrying a product link is directly actionable; one without
        // is a heads-up, and both are worth knowing about.
        if (post.products.length > 0) {
          for (const product of post.products) {
            state.addDiscovery({
              key: product.url,
              kind: 'product',
              title: post.title,
              url: product.url,
              site: product.site,
              source: `r/${subreddit}`,
              matched: post.matched,
            });
          }
        } else {
          state.addDiscovery({
            key: post.id,
            kind: 'announcement',
            title: post.title,
            url: post.permalink,
            source: `r/${subreddit}`,
            matched: post.matched,
          });
        }
      }
    }

    redditBackoff = limited ? Math.min(redditBackoff * 2, 8) : 1;
    autoAddOrAnnounce();
  }

  let discordTimer = null;

  function scheduleDiscord() {
    const { settings } = state.getState();
    const base = Math.max(5, settings.discordPollSeconds) * 1000;
    discordTimer = setTimeout(async () => {
      try {
        await pollDiscord();
      } catch {
        // Discovery must never take the dashboard down.
      }
      scheduleDiscord();
    }, base * discordBackoff);
    discordTimer.unref?.();
  }

  let redditTimer = null;

  function scheduleReddit() {
    const { settings } = state.getState();
    const base = Math.max(1, settings.redditIntervalMinutes) * 60 * 1000;
    redditTimer = setTimeout(async () => {
      try {
        await pollReddit();
      } catch {
        // Discovery must never take the dashboard down.
      }
      scheduleReddit();
    }, base * redditBackoff);
    // Don't hold the process open just for discovery.
    redditTimer.unref?.();
  }

  let dropTimer = null;

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once('error', onError);
      server.listen(port, HOST, () => {
        server.removeListener('error', onError);
        scheduleReddit();
        scheduleDiscord();
        // 15s is fine granularity for a window measured in minutes, and the
        // tick does nothing at all unless the window actually changed.
        watchDropWindow();
        dropTimer = setInterval(watchDropWindow, 15000);
        dropTimer.unref?.();
        resolve(server.address().port);
      });
    });
  }

  function url() {
    const actual = server.address()?.port ?? port;
    const host = LAN ? localAddress() : '127.0.0.1';
    return `http://${host}:${actual}/${TOKEN ? `?token=${TOKEN}` : ''}`;
  }

  return {
    server,
    wss,
    listen,
    url,
    isLan: LAN,
    pollReddit, // exposed so tests can drive a round without waiting
    pollDiscord,
    dropState,
    watchDropWindow,
    close: () => new Promise((resolve) => {
      clearTimeout(redditTimer);
      clearTimeout(discordTimer);
      clearInterval(dropTimer);
      // Sockets keep an HTTP server's close() pending indefinitely, and the
      // dashboard's clients are long-lived WebSockets by design.
      for (const client of clients) client.socket.terminate();
      server.close(resolve);
    }),
  };
}

function localAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '0.0.0.0';
}

/** Read the CLI's configuration out of the environment. */
function optionsFromEnv() {
  return {
    port: Number.parseInt(process.env.POKEBOT_PORT, 10) || DEFAULT_PORT,
    lan: /^(1|true|yes)$/i.test(process.env.POKEBOT_LAN || ''),
    token: process.env.POKEBOT_TOKEN || '',
  };
}

if (require.main === module) {
  let dashboard;
  try {
    dashboard = createDashboard(optionsFromEnv());
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  dashboard
    .listen()
    .then(() => {
      console.log(`pokebot dashboard  ${dashboard.url()}`);
      if (dashboard.isLan) console.log('LAN mode: reachable from other devices on this network.');
      console.log('Load extension/ in Chrome and it will connect automatically.');
    })
    .catch((err) => {
      const { port: wanted } = optionsFromEnv();
      console.error(
        err.code === 'EADDRINUSE'
          ? `Port ${wanted} is already in use — is pokebot already running?`
          : err.message,
      );
      process.exit(1);
    });
}

module.exports = { createDashboard, optionsFromEnv, DEFAULT_PORT };
