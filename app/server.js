'use strict';

/**
 * Dashboard server: static UI + a WebSocket hub joining the browser dashboard
 * to the extension's service worker.
 *
 * The server never touches a retailer site. It holds the watchlist and
 * settings, tells the extension what to watch, and collects what comes back.
 * All clicking stays in your real browser session, where it works.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { WebSocketServer } = require('ws');

const state = require('./state');

const PORT = Number.parseInt(process.env.POKEBOT_PORT, 10) || 8787;
// Localhost by default. Set POKEBOT_LAN=1 to reach it from your phone on the
// same wifi -- that also requires a token, enforced below.
const LAN = /^(1|true|yes)$/i.test(process.env.POKEBOT_LAN || '');
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const TOKEN = (process.env.POKEBOT_TOKEN || '').trim();

if (LAN && TOKEN === '') {
  console.error(
    'POKEBOT_LAN=1 exposes the dashboard on your network, so POKEBOT_TOKEN must be set.\n' +
      `Generate one:  POKEBOT_TOKEN=${crypto.randomBytes(12).toString('hex')}`,
  );
  process.exit(1);
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function authorised(req) {
  if (!LAN) return true; // Loopback only; nothing else can reach it.
  const url = new URL(req.url, 'http://localhost');
  const supplied = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer /, '');
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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

/** Push watchlist + settings to the extension, and full state to dashboards. */
function syncAll() {
  const snap = state.snapshot();
  broadcast({ type: 'state', ...snap }, 'dashboard');
  broadcast(
    {
      type: 'sync',
      settings: snap.settings,
      watchlist: snap.watchlist
        .filter((item) => item.enabled)
        .map(({ id, url, name, site }) => ({ id, url, name, site })),
    },
    'extension',
  );
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

  /** Relayed from a content script via the extension's service worker. */
  event(client, message) {
    const entry = state.recordEvent(message);
    broadcast({ type: 'event', entry }, 'dashboard');
    broadcast({ type: 'state', ...state.snapshot() }, 'dashboard');
  },
};

function hasExtension() {
  for (const client of clients) if (client.role === 'extension') return true;
  return false;
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

server.listen(PORT, HOST, () => {
  const base = `http://${LAN ? localAddress() : '127.0.0.1'}:${PORT}`;
  const suffix = TOKEN ? `/?token=${TOKEN}` : '/';
  console.log(`pokebot dashboard  ${base}${suffix}`);
  if (LAN) console.log('LAN mode: reachable from other devices on this network.');
  console.log('Load extension/ in Chrome and it will connect automatically.');
});

function localAddress() {
  const nets = require('os').networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '0.0.0.0';
}

module.exports = { server, PORT };
