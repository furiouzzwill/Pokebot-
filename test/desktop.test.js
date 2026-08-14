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

test('the app can be built without a bundled retailer credential', () => {
  // Guards against a card number or account secret being added to the packaged
  // config by accident.
  const banned = /(\bcvv\b|\bcard[_-]?number\b|\bpassword\b|\bsecret\b)/i;
  for (const file of ['desktop/main.js', 'app/server.js', 'app/state.js', 'extension/config.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!banned.test(source), `${file} references credential-shaped fields`);
  }
});
