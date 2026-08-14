'use strict';

/**
 * Packaging sanity checks. These are cheap and catch the mistakes that only
 * show up as a broken installer half an hour into a CI build: an entry point
 * that doesn't exist, a missing icon, or a files list that omits code the app
 * requires at runtime.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('electron entry point exists and parses', () => {
  const entry = path.join(ROOT, pkg.main);
  assert.ok(fs.existsSync(entry), `package.json main points at a missing file: ${pkg.main}`);
  const source = fs.readFileSync(entry, 'utf8');
  assert.doesNotThrow(() => new vm.Script(source, { filename: pkg.main }));
});

test('builder config names an icon that exists', () => {
  for (const platform of ['mac', 'win', 'linux']) {
    const icon = pkg.build[platform]?.icon;
    assert.ok(icon, `no icon configured for ${platform}`);
    assert.ok(fs.existsSync(path.join(ROOT, icon)), `missing icon for ${platform}: ${icon}`);
  }
});

test('packaged files list covers everything main.js pulls in at runtime', () => {
  // main.js requires the dashboard, which requires state and the site adapters.
  const needed = ['desktop', 'app', 'src', 'extension'];
  const globs = pkg.build.files.join(' ');
  for (const dir of needed) {
    assert.ok(globs.includes(dir), `build.files omits ${dir}/, which the app requires`);
    assert.ok(fs.existsSync(path.join(ROOT, dir)), `${dir}/ does not exist`);
  }
});

test('the dashboard UI assets are inside the packaged app directory', () => {
  // server.js serves these from app/public; if they moved, packaging breaks.
  for (const file of ['index.html', 'app.js', 'style.css']) {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'app', 'public', file)),
      `app/public/${file} is missing`,
    );
  }
});

test('electron is a dev dependency, not a runtime one', () => {
  // A 300MB runtime dep would land on everyone running `npm install` just to
  // use the dashboard or the CLI monitor.
  assert.ok(!pkg.dependencies.electron, 'electron must not be a runtime dependency');
  assert.ok(pkg.devDependencies.electron, 'electron should be a devDependency');
});

test('the packaged app redirects its state file off the install directory', () => {
  // Packaged, __dirname is inside app.asar. state.js defaulting there made the
  // first settings write throw ENOTDIR out of mkdirSync and crash the main
  // process. main.js must point the state somewhere writable *before* it pulls
  // in the dashboard, because state.js resolves the path at module load.
  const source = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');

  const assigned = source.indexOf('POKEBOT_STATE_FILE');
  const requiresDashboard = source.indexOf("require('../app/server')");

  assert.notStrictEqual(assigned, -1, 'main.js never sets POKEBOT_STATE_FILE');
  assert.notStrictEqual(requiresDashboard, -1, 'main.js no longer requires the dashboard');
  assert.ok(
    assigned < requiresDashboard,
    'POKEBOT_STATE_FILE must be set before app/server is required, or state.js '
      + 'will already have resolved the unwritable in-archive path',
  );
  assert.match(
    source,
    /app\.getPath\(['"]userData['"]\)/,
    'the state file should land in Electron userData, not the install directory',
  );
});

test('state.js honours POKEBOT_STATE_FILE, creating parent directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokebot-statepath-'));
  // Nested, so this also covers the mkdirSync that ENOTDIR was thrown from.
  const target = path.join(dir, 'userData', 'app-state.json');

  const previous = process.env.POKEBOT_STATE_FILE;
  process.env.POKEBOT_STATE_FILE = target;
  delete require.cache[require.resolve('../app/state')];

  try {
    const state = require('../app/state');
    assert.strictEqual(state.STATE_FILE, target);

    state.setSettings({ armed: true });

    assert.ok(fs.existsSync(target), 'settings write did not reach the override path');
    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.strictEqual(written.settings.armed, true);
  } finally {
    if (previous === undefined) delete process.env.POKEBOT_STATE_FILE;
    else process.env.POKEBOT_STATE_FILE = previous;
    delete require.cache[require.resolve('../app/state')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the app can be built without a bundled retailer credential', () => {
  // Guards against a card number or account secret being added to the packaged
  // config by accident.
  const banned = /(\bcvv\b|\bcard[_-]?number\b|\bpassword\b|\bsecret\b)/i;
  for (const file of ['desktop/main.js', 'app/server.js', 'app/state.js', 'extension/config.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!banned.test(source), `${file} references credential-shaped fields`);
  }
});
