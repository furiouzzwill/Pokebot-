'use strict';

/**
 * Electron shell around the dashboard.
 *
 * It hosts the same server the CLI does, in-process, and shows the same UI in
 * a window. Nothing about how the automation works changes: the Chrome
 * extension still connects over localhost and still does every click in your
 * real logged-in session.
 */

const path = require('path');
const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } = require('electron');

// Must be set before the dashboard is required: state.js resolves its path and
// reads the file at module load. The packaged default would point inside
// app.asar, where the first settings write dies with ENOTDIR.
if (!process.env.POKEBOT_STATE_FILE) {
  process.env.POKEBOT_STATE_FILE = path.join(app.getPath('userData'), 'app-state.json');
}

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
    dashboard = createDashboard({ port });
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

  dashboardUrl = dashboard.url();
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
