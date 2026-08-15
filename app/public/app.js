'use strict';

const BOOLS = [
  'armed', 'dryRun', 'autoCheckout', 'placeOrder',
  'discoveryEnabled', 'autoAddDiscoveries', 'discordAlerts',
  'dropScheduleEnabled', 'autoAddDuringDrop',
];
const NUMS = [
  'maxPrice', 'maxOrderTotal', 'maxOrderItems', 'maxOrdersPerDay', 'reloadSeconds',
  'redditIntervalMinutes', 'discordPollSeconds',
  'dropLeadMinutes', 'dropTrailMinutes', 'searchSeconds', 'dropSearchSeconds',
];
const TEXTS = ['dropTime', 'dropTimeZone'];
const LISTS = ['keywords', 'subreddits', 'dropDays'];

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token');

let socket = null;
let settings = null;
let suppressSend = false;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${token}` : ''}`);

  socket.addEventListener('open', () => {
    send({ type: 'hello', role: 'dashboard' });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') {
      renderSettings(message.settings);
      renderRules(message.rules);
      renderWatchlist(message.watchlist);
      renderDiscoveries(message.discoveries || []);
      renderDrop(message.drop);
      renderLog(message.history);
    } else if (message.type === 'event') {
      appendLog(message.entry);
    } else if (message.type === 'presence') {
      setPill($('extPill'), message.extension, 'extension connected', 'extension offline');
    } else if (message.type === 'error') {
      $('addError').textContent = message.message;
    }
  });

  // The server may not be up yet, or may restart while the tab is open.
  socket.addEventListener('close', () => {
    setPill($('extPill'), false, '', 'dashboard offline');
    setTimeout(connect, 1500);
  });
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function setPill(el, on, onText, offText) {
  el.textContent = on ? onText : offText;
  el.className = `pill ${on ? 'on' : 'off'}`;
}

function renderSettings(next) {
  settings = next;
  suppressSend = true;
  for (const key of BOOLS) $(key).checked = Boolean(next[key]);
  for (const key of NUMS) $(key).value = next[key];
  for (const key of TEXTS) $(key).value = next[key] ?? '';
  suppressSend = false;

  // placeOrder can't fire without autoCheckout, so don't let it look armed.
  $('placeOrder').disabled = !next.autoCheckout;

  const pill = $('modePill');
  if (!next.armed) {
    pill.textContent = 'alert only';
    pill.className = 'pill off';
  } else if (next.dryRun) {
    pill.textContent = 'dry run';
    pill.className = 'pill';
  } else if (next.placeOrder) {
    pill.textContent = `LIVE — places orders ≤ $${next.maxOrderTotal}`;
    pill.className = 'pill live';
  } else if (next.autoCheckout) {
    pill.textContent = 'live — stops before submit';
    pill.className = 'pill warn';
  } else {
    pill.textContent = 'live — carts only';
    pill.className = 'pill warn';
  }
}

const STATUS_TEXT = {
  idle: '—',
  watching: 'watching',
  'in-stock': 'IN STOCK',
  carted: 'carted',
  'checkout-step': 'at checkout',
  'ready-to-submit': 'ready to submit',
  'placing-order': 'placing order',
  refused: 'refused',
  challenge: 'bot check',
  skipped: 'skipped',
  'dry-run': 'dry run hit',
  stopped: 'stopped',
  'not-armed': 'idle',
};

function renderWatchlist(items) {
  const list = $('watchlist');
  list.textContent = '';

  for (const item of items) {
    const li = document.createElement('li');

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = item.enabled;
    toggle.title = item.enabled ? 'Watching' : 'Paused';
    toggle.addEventListener('change', () =>
      send({ type: 'toggleItem', id: item.id, enabled: toggle.checked }),
    );

    const main = document.createElement('div');
    main.className = 'item-main';
    const name = document.createElement('div');
    name.className = 'item-name';
    name.textContent = item.name;
    const url = document.createElement('div');
    url.className = 'item-url';
    url.textContent = item.url;
    main.append(name, url);

    const site = document.createElement('span');
    site.className = 'site-tag';
    site.textContent = item.site;

    const status = document.createElement('span');
    const kind = item.status?.kind || 'idle';
    status.className = `item-status k-${kind}`;
    status.textContent = item.enabled ? STATUS_TEXT[kind] || kind : 'paused';
    if (item.status?.detail) status.title = item.status.detail;

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.addEventListener('click', () => send({ type: 'removeItem', id: item.id }));

    li.append(toggle, main, site, status, remove);
    list.append(li);
  }

  $('emptyHint').style.display = items.length ? 'none' : '';
  const active = items.filter((i) => i.enabled).length;
  $('countLabel').textContent = items.length ? `${active} of ${items.length} active` : '';
}

/** Countdown to the next scheduled drop, or the fact that one is live now. */
function renderDrop(drop) {
  const pill = $('dropPill');
  const hint = $('dropHint');
  if (!pill || !hint) return;

  if (!drop || drop.minutesUntilNext === null) {
    pill.style.display = 'none';
    hint.textContent = settings?.dropScheduleEnabled
      ? 'Set a day and a time to schedule a drop window.'
      : 'Off — search tabs re-query at the normal interval all week.';
    return;
  }

  pill.style.display = '';
  if (drop.active) {
    pill.textContent = 'DROP WINDOW OPEN';
    pill.className = 'pill live';
    hint.textContent = `Search tabs re-querying about every ${settings?.dropSearchSeconds ?? 10}s.`;
    return;
  }

  pill.textContent = 'scheduled';
  pill.className = 'pill';
  const minutes = drop.minutesUntilNext;
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  hint.textContent = `Next window opens in ${parts.join(' ')} (${settings?.dropLeadMinutes ?? 10} min before the drop).`;
}

function renderRules(rules) {
  if (!rules) return;
  suppressSend = true;
  for (const key of LISTS) {
    if (Array.isArray(rules[key])) $(key).value = rules[key].join(', ');
  }
  suppressSend = false;
}

function pushRules() {
  if (suppressSend) return;
  const rules = {};
  for (const key of LISTS) {
    rules[key] = $(key).value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  send({ type: 'setRules', rules });
}

function renderDiscoveries(items) {
  const open = items.filter((item) => !item.dismissed);
  const list = $('discoveries');
  list.textContent = '';

  for (const item of open.slice(0, 25)) {
    const li = document.createElement('li');

    const kind = document.createElement('span');
    kind.className = `kind-tag ${item.kind === 'product' ? 'product' : ''}`;
    kind.textContent = item.kind === 'product' ? 'link' : 'news';

    const main = document.createElement('div');
    main.className = 'disc-main';
    const title = document.createElement('div');
    title.className = 'disc-title';
    title.textContent = item.title;
    const meta = document.createElement('div');
    meta.className = 'disc-meta';
    const when = new Date(item.at).toLocaleTimeString([], { hour12: false });
    meta.textContent = [item.source, item.site, when].filter(Boolean).join(' · ');
    main.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'disc-actions';

    if (item.kind === 'product') {
      const add = document.createElement('button');
      add.textContent = 'Watch';
      add.addEventListener('click', () => send({ type: 'acceptDiscovery', key: item.key }));
      actions.append(add);
    } else if (item.url) {
      const open = document.createElement('a');
      open.href = item.url;
      open.target = '_blank';
      open.rel = 'noreferrer';
      open.textContent = 'Read';
      open.className = 'link';
      actions.append(open);
    }

    const hide = document.createElement('button');
    hide.className = 'ghost';
    hide.textContent = 'Hide';
    hide.addEventListener('click', () => send({ type: 'dismissDiscovery', key: item.key }));
    actions.append(hide);

    li.append(kind, main, actions);
    list.append(li);
  }

  $('discoveryHint').style.display = open.length ? 'none' : '';
  $('discoveryCount').textContent = open.length ? `${open.length} waiting` : '';
}

function logRow(entry) {
  const li = document.createElement('li');

  const time = document.createElement('time');
  // 24h keeps the column narrow enough not to wrap next to the kind label.
  time.textContent = new Date(entry.at).toLocaleTimeString([], { hour12: false });
  time.dateTime = entry.at;

  const kind = document.createElement('span');
  kind.className = `kind k-${entry.kind}`;
  kind.textContent = entry.kind;

  const detail = document.createElement('span');
  detail.className = 'detail';
  detail.textContent = entry.name ? `${entry.name} — ${entry.detail}` : entry.detail;

  li.append(time, kind, detail);
  return li;
}

function renderLog(history) {
  const log = $('log');
  log.textContent = '';
  for (const entry of history.slice().reverse()) log.append(logRow(entry));
}

function appendLog(entry) {
  const log = $('log');
  log.prepend(logRow(entry));
  while (log.children.length > 200) log.lastChild.remove();
}

function pushSettings() {
  if (suppressSend) return;
  const patch = {};
  for (const key of BOOLS) patch[key] = $(key).checked;
  for (const key of NUMS) {
    const value = Number.parseFloat($(key).value);
    if (Number.isFinite(value) && value >= 0) patch[key] = value;
  }
  for (const key of TEXTS) {
    const value = $(key).value.trim();
    if (value !== '') patch[key] = value;
  }
  send({ type: 'setSettings', settings: patch });
}

for (const key of [...BOOLS, ...NUMS, ...TEXTS]) {
  $(key).addEventListener('change', pushSettings);
}

for (const key of LISTS) {
  $(key).addEventListener('change', pushRules);
}

$('addForm').addEventListener('submit', (event) => {
  event.preventDefault();
  $('addError').textContent = '';
  send({ type: 'addItem', url: $('addUrl').value, name: $('addName').value });
  $('addUrl').value = '';
  $('addName').value = '';
});

$('clearLog').addEventListener('click', () => {
  $('log').textContent = '';
});

connect();
