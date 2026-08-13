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

  // Placing the order is always yours. The extension will never submit an
  // order or enter payment details -- it gets you to a full cart, fast.
  // (No setting here on purpose.)

  // Alert loudly on stock, on a challenge page, and on cart success/failure.
  sound: true,
  notifications: true,
};

async function loadSettings() {
  if (typeof chrome === 'undefined' || !chrome.storage) return { ...DEFAULTS };
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULTS, loadSettings, saveSettings };
}
