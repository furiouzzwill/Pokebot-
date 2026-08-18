'use strict';

/**
 * Shared settings for the drop assistant.
 *
 * Everything here runs inside your own logged-in browser session. There is no
 * CAPTCHA solver and no fingerprint spoofing: if the site puts up a challenge,
 * the extension stops and shouts for you rather than trying to get around it.
 */
const DEFAULTS = {
  // Master switch. Off means "watch and alert only, never click".
  armed: false,

  // Dry run logs and alerts on the click it *would* make, without clicking.
  // This is the default so a misfiring selector can't spend your money.
  dryRun: true,

  // Refuse to cart above this price, in dollars. Guards against carting a
  // marketplace reseller listing that replaced the sold-out first-party one.
  maxPrice: 100,

  // Stop after this many successful carts per tab, so a re-render loop can't
  // cart repeatedly.
  maxCarts: 1,

  // How often to re-check the page for an enabled purchase control (ms).
  // The MutationObserver catches most changes; this is the safety net.
  pollMs: 1000,

  // Reload the page every N seconds if nothing has changed. Some PDPs never
  // re-hydrate stock state on their own. 0 disables reloading.
  reloadSeconds: 0,

  // After a successful cart, open the cart page.
  goToCartAfterAdd: true,

  // --- Checkout -------------------------------------------------------------
  // Two separate gates, both off by default. autoCheckout walks cart ->
  // checkout and stops with the order ready to submit. placeOrder is the one
  // that actually spends money, and it requires autoCheckout as well.
  autoCheckout: false,
  placeOrder: false,

  // Hard ceiling on the order total at the point of submission, in dollars.
  // Checked against the total the checkout page actually shows -- separate
  // from maxPrice, so shipping, tax, or a sneaky extra line item can't slip
  // an order through under an item-level cap.
  maxOrderTotal: 150,

  // Refuse to submit an order containing more than this many items. Catches a
  // stuck cart or a quantity stepper that ran away.
  maxOrderItems: 2,

  // Orders this extension may place per calendar day, across all tabs.
  // Persisted, so a reload loop cannot re-order.
  maxOrdersPerDay: 1,

  // Alert loudly on stock, on a challenge page, and on cart success/failure.
  sound: true,
  notifications: true,

  // --- Search-page watcher --------------------------------------------------
  // Seconds between re-queries of a search or category page. A results page is
  // a snapshot and never updates itself, so this is the only thing that lets
  // the watcher see a listing that appeared after the tab loaded.
  searchSeconds: 90,

  // The interval used instead while a scheduled drop window is open. The
  // dashboard owns the schedule and the timezone arithmetic; the extension is
  // told nothing more than whether a window is currently open.
  dropSearchSeconds: 10,
  dropActive: false,

  // Report only products that appear *after* the tab opens. What is already on
  // the shelf when the watcher starts is not a drop, and auto-add would buy it.
  onlyNewListings: true,
};

// Below this the re-query stops looking like a person with a tab open. A bot
// check during the one minute that matters costs the whole drop.
const MIN_SEARCH_SECONDS = 5;

async function loadSettings() {
  if (typeof chrome === 'undefined' || !chrome.storage) return { ...DEFAULTS };
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}

/**
 * Daily order ledger, kept in local storage so it survives reloads and is
 * shared across tabs. This is the backstop that stops a reload loop or two
 * open tabs from placing the same order twice.
 */
const LEDGER_KEY = 'orderLedger';

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function readLedger() {
  if (typeof chrome === 'undefined' || !chrome.storage) return { date: today(), count: 0 };
  const { [LEDGER_KEY]: ledger } = await chrome.storage.local.get(LEDGER_KEY);
  if (!ledger || ledger.date !== today()) return { date: today(), count: 0 };
  return ledger;
}

/** @returns {Promise<boolean>} true when another order is allowed today. */
async function canPlaceOrder(maxPerDay) {
  const ledger = await readLedger();
  return ledger.count < maxPerDay;
}

/**
 * Claim a slot in today's budget. Call this BEFORE clicking submit, not after:
 * if the click succeeds and the page navigates away, an after-the-fact write
 * never lands and the guard is useless.
 */
async function recordOrder() {
  const ledger = await readLedger();
  const next = { date: ledger.date, count: ledger.count + 1 };
  await chrome.storage.local.set({ [LEDGER_KEY]: next });
  return next;
}

async function resetLedger() {
  await chrome.storage.local.set({ [LEDGER_KEY]: { date: today(), count: 0 } });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULTS, MIN_SEARCH_SECONDS, loadSettings, saveSettings,
    readLedger, canPlaceOrder, recordOrder, resetLedger,
  };
}
