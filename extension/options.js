'use strict';

const CHECKBOXES = ['armed', 'dryRun', 'goToCartAfterAdd'];
const NUMBERS = ['maxPrice', 'pollMs', 'reloadSeconds'];

const statusEl = document.getElementById('status');
let statusTimer = null;

function flash(message) {
  statusEl.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = '';
  }, 1800);
}

async function restore() {
  const settings = await loadSettings();
  for (const key of CHECKBOXES) document.getElementById(key).checked = Boolean(settings[key]);
  for (const key of NUMBERS) document.getElementById(key).value = settings[key];
  render(settings);
}

function render(settings) {
  // Make the live/dry-run distinction impossible to miss.
  if (settings.armed && !settings.dryRun) {
    statusEl.textContent = '● LIVE — will click Add to cart';
    statusEl.style.color = '#e63946';
  } else if (settings.armed) {
    statusEl.textContent = '○ Armed, dry run — logs only';
    statusEl.style.color = '';
  } else {
    statusEl.textContent = '○ Alert only';
    statusEl.style.color = '';
  }
}

async function persist() {
  const patch = {};
  for (const key of CHECKBOXES) patch[key] = document.getElementById(key).checked;
  for (const key of NUMBERS) {
    const value = Number.parseFloat(document.getElementById(key).value);
    if (Number.isFinite(value) && value >= 0) patch[key] = value;
  }
  await saveSettings(patch);
  render(patch);
  flash('Saved — reload the product tab to apply.');
}

for (const key of [...CHECKBOXES, ...NUMBERS]) {
  document.getElementById(key).addEventListener('change', persist);
}

restore();
