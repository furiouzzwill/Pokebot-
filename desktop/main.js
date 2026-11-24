'use strict';

/**
 * Electron shell around the dashboard.
 *
 * It hosts the same server the CLI does, in-process, and shows the same UI in
 * a window. Nothing about how the automation works changes: the Chrome
 * extension still connects over localhost and still does every click in your
 * real logged-in session.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage, clipboard, powerSaveBlocker,
} = require('electron');

const { createDashboard, DEFAULT_PORT } = require('../app/server');

let mainWindow = null;
let tray = null;
let dashboard = null;
let dashboardUrl = '';
let quitting = false;

const ICON = path.join(__dirname, '..', 'extension', 'icon128.png');

// Two copies would fight over the port and over the state file, so the second
// launch just surfaces the window the first one already has.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
}

function showWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: 'Pokebot',
    icon: ICON,
    backgroundColor: '#101216',
    show: false,
    webPreferences: {
      // The window only ever loads our own localhost UI, which needs no Node
      // access. Keeping the renderer sandboxed costs nothing here.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(dashboardUrl);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Retailer links in the activity feed belong in the real browser, where the
  // user is logged in -- never inside this window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window leaves it running in the tray; a drop can happen while
  // the window is shut.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Phone alerts: lets a phone on the same wifi POST drop links (from an SMS
 * automation or a share-sheet shortcut) into the watchlist. Off by default.
 * The token is generated once and kept in the app's data folder, so the link
 * set up on the phone keeps working across restarts.
 */
function phoneConfigPath() {
  return path.join(app.getPath('userData'), 'phone-alerts.json');
}

function loadPhoneConfig() {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(phoneConfigPath(), 'utf8'));
  } catch {
    // First run, or unreadable: start disabled with a fresh token.
  }
  if (typeof config.token !== 'string' || config.token.length < 16) {
    config.token = crypto.randomBytes(16).toString('hex');
  }
  config.enabled = Boolean(config.enabled);
  savePhoneConfig(config);
  return config;
}

function savePhoneConfig(config) {
  try {
    fs.mkdirSync(path.dirname(phoneConfigPath()), { recursive: true });
    fs.writeFileSync(phoneConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
  } catch {
    // Non-fatal; the toggle just won't persist.
  }
}

function setPhoneAlerts(enabled) {
  const config = loadPhoneConfig();
  config.enabled = enabled;
  savePhoneConfig(config);
  // The listening address changes, so the server has to restart.
  app.relaunch();
  quitting = true;
  app.quit();
}

function setRemote(enabled) {
  const config = loadPhoneConfig();
  config.remote = enabled;
  savePhoneConfig(config);
  app.relaunch();
  quitting = true;
  app.quit();
}

function copyDashboardLink() {
  if (!dashboard?.isLan) return;
  const link = dashboard.url();
  clipboard.writeText(link);
  dialog.showMessageBox({
    type: 'info',
    title: 'Pokebot',
    message: 'Phone dashboard link copied',
    detail:
      `${link}\n\nOpen this on your phone to see status, arm or disarm, and add links. ` +
      'On the same wifi it works as is. From work, install Tailscale on this computer and ' +
      'your phone and replace the address with this computer\'s Tailscale address (100.x.x.x). ' +
      'Keep it private: anyone with it can control your watchlist and checkout settings.',
  });
}

function copyPhoneLink() {
  const link = dashboard?.phoneLinkUrl() || '';
  if (!link) return;
  clipboard.writeText(link);
  dialog.showMessageBox({
    type: 'info',
    title: 'Pokebot',
    message: 'Phone alert link copied',
    detail:
      `${link}\n\nUse this as the URL in your phone shortcut or automation (POST, ` +
      'body = the alert text or link). It only works on the same wifi as this computer. ' +
      'Keep it private: anyone with it can add items to your watchlist.',
  });
}

/**
 * Keep the computer from sleeping while Pokebot runs. A sleeping machine runs
 * nothing -- not this, not Chrome -- so a restock during the workday would
 * be missed. The screen may still turn off. On by default; the choice is
 * remembered in the same file as the phone settings.
 */
let awakeBlocker = null;

function applyKeepAwake(on) {
  if (on && awakeBlocker === null) {
    awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!on && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = null;
  }
}

function setKeepAwake(on) {
  const config = loadPhoneConfig();
  config.keepAwake = on;
  savePhoneConfig(config);
  applyKeepAwake(on);
}

function createTray() {
  const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip('Pokebot — dashboard running');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open dashboard', click: showWindow },
      {
        label: 'Open in browser',
        click: () => shell.openExternal(dashboardUrl),
      },
      { type: 'separator' },
      {
        label: 'Keep computer awake',
        type: 'checkbox',
        checked: awakeBlocker !== null,
        click: (item) => setKeepAwake(item.checked),
      },
      {
        label: 'Control from phone (dashboard + alerts)',
        type: 'checkbox',
        checked: Boolean(dashboard?.isLan),
        click: (item) => setRemote(item.checked),
      },
      {
        label: 'Copy phone dashboard link',
        enabled: Boolean(dashboard?.isLan),
        click: copyDashboardLink,
      },
      {
        label: 'Accept alerts from phone',
        type: 'checkbox',
        checked: Boolean(dashboard?.isPhone || dashboard?.isLan),
        enabled: !dashboard?.isLan,
        click: (item) => setPhoneAlerts(item.checked),
      },
      {
        label: 'Copy phone alert link',
        enabled: Boolean(dashboard?.isPhone || dashboard?.isLan),
        click: copyPhoneLink,
      },
      { type: 'separator' },
      {
        label: 'Quit Pokebot',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showWindow);
}

async function start() {
  const port = Number.parseInt(process.env.POKEBOT_PORT, 10) || DEFAULT_PORT;

  try {
    const phone = loadPhoneConfig();
    applyKeepAwake(phone.keepAwake !== false);
    dashboard = createDashboard({
      port,
      lan: Boolean(phone.remote),
      phoneAlerts: phone.enabled,
      token: phone.token,
    });
    await dashboard.listen();
  } catch (err) {
    const message =
      err.code === 'EADDRINUSE'
        ? `Port ${port} is already in use.\n\nPokebot may already be running, or another program ` +
          'has the port. Quit the other copy and try again.'
        : `Could not start the dashboard.\n\n${err.message}`;
    dialog.showErrorBox('Pokebot', message);
    app.quit();
    return;
  }

  // The window on this machine never needs the token in its URL.
  dashboardUrl = dashboard.localUrl();
  console.log(`pokebot dashboard  ${dashboardUrl}`);

  createWindow();
  try {
    createTray();
  } catch {
    // A tray isn't available on every Linux desktop; the window still works.
  }
}

app.whenReady().then(start);

app.on('activate', showWindow); // macOS dock click

// Deliberately no 'window-all-closed' -> quit: closing the window hides it and
// the watcher keeps running. Quit is via the tray or Cmd/Ctrl-Q.
app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', async () => {
  if (dashboard) await dashboard.close();
});
