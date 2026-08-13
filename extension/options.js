'use strict';

const CHECKBOXES = ['armed', 'dryRun', 'goToCartAfterAdd', 'autoCheckout', 'placeOrder'];
const NUMBERS = [
  'maxPrice', 'pollMs', 'reloadSeconds',
  'maxOrderTotal', 'maxOrderItems', 'maxOrdersPerDay',
];

const statusEl = document.getElementById('status');
let statusTimer = null;

function flash(message) {
  const previous = statusEl.textContent;
  statusEl.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = previous;
  }, 1800);
}

const get = (key) => document.getElementById(key);

function render(settings) {
  // placeOrder without autoCheckout can never fire, so don't let it look armed.
  get('placeOrder').disabled = !settings.autoCheckout;

  let text;
  let color = '';
  if (!settings.armed) {
    text = '○ Alert only';
  } else if (settings.dryRun) {
    text = '○ Armed, dry run — logs only, spends nothing';
  } else if (settings.placeOrder && settings.autoCheckout) {
    text = `● LIVE — will place orders up to $${settings.maxOrderTotal}`;
    color = '#e63946';
  } else if (settings.autoCheckout) {
    text = '● LIVE — carts and goes to checkout, stops before submitting';
    color = '#b26a00';
  } else {
    text = '● LIVE — carts only';
    color = '#b26a00';
  }
  statusEl.textContent = text;
  statusEl.style.color = color;
  statusEl.style.fontWeight = color ? '600' : '';
}

function collect() {
  const patch = {};
  for (const key of CHECKBOXES) patch[key] = get(key).checked;
  for (const key of NUMBERS) {
    const value = Number.parseFloat(get(key).value);
    if (Number.isFinite(value) && value >= 0) patch[key] = value;
  }
  // Enforce the dependency in stored state, not just in the UI.
  if (!patch.autoCheckout) patch.placeOrder = false;
  return patch;
}

async function persist() {
  const patch = collect();
  await saveSettings(patch);
  get('placeOrder').checked = patch.placeOrder;
  render(patch);
  flash('Saved — reload the tab to apply.');
}

async function restore() {
  const settings = await loadSettings();
  for (const key of CHECKBOXES) get(key).checked = Boolean(settings[key]);
  for (const key of NUMBERS) get(key).value = settings[key];
  render(settings);

  const ledger = await readLedger();
  if (ledger.count > 0) {
    flash(`${ledger.count} order(s) placed today`);
  }
}

for (const key of [...CHECKBOXES, ...NUMBERS]) {
  get(key).addEventListener('change', persist);
}

get('resetLedger').addEventListener('click', async (event) => {
  event.preventDefault();
  await resetLedger();
  flash("Today's order count reset.");
});

restore();
