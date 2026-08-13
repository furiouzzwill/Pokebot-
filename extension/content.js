'use strict';

/**
 * Runs in your own logged-in tab on a Walmart or Target product page.
 *
 * Watches for the purchase control to become usable, sanity-checks the price,
 * clicks Add to cart, and then hands off to you. It does not touch checkout,
 * payment, or CAPTCHAs.
 */

const SITE = location.hostname.includes('walmart') ? 'walmart' : 'target';

const SELECTORS = {
  walmart: {
    // Ordered by specificity: stable hooks first, text match as the fallback.
    cart: ['[data-automation-id="atc"]', '[data-testid="add-to-cart-section"] button'],
    price: ['[itemprop="price"]', '[data-automation-id="product-price"]', '[data-seo-id="hero-price"]'],
    soldOut: ['[data-automation-id="oos-message"]'],
  },
  target: {
    cart: [
      '[data-test="shipItButton"]',
      '[data-test="orderPickupButton"]',
      '[data-test="addToCartButton"]',
    ],
    price: ['[data-test="product-price"]', '[data-test="product-price-value"]'],
    soldOut: ['[data-test="outOfStockMessage"]'],
  },
};

const CART_TEXT = /^(add to cart|add for shipping|ship it|add to bag)$/i;
const CHALLENGE_TEXT = /robot or human|confirm that you'?re human|press & hold|verify you are human|access denied/i;

const state = {
  settings: null,
  carts: 0,
  stopped: false,
  lastSignature: '',
  observer: null,
  pollTimer: null,
  reloadTimer: null,
};

function log(...args) {
  console.log('%c[pokebot]', 'color:#e63946;font-weight:bold', ...args);
}

function report(kind, detail) {
  log(kind, detail || '');
  try {
    chrome.runtime.sendMessage({ kind, detail, url: location.href, site: SITE });
  } catch {
    // Service worker asleep or extension reloading; console still has it.
  }
}

/** Bail out entirely -- used for challenge pages and for hard stops. */
function stop(reason) {
  if (state.stopped) return;
  state.stopped = true;
  state.observer?.disconnect();
  clearInterval(state.pollTimer);
  clearTimeout(state.reloadTimer);
  report('stopped', reason);
}

function isDisabled(el) {
  return (
    el.disabled === true ||
    el.getAttribute('disabled') !== null ||
    el.getAttribute('aria-disabled') === 'true' ||
    el.dataset.disabled === 'true' ||
    el.offsetParent === null // not rendered
  );
}

function queryAll(selectors) {
  const found = [];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) found.push(el);
  }
  return found;
}

/**
 * Find the real Add to cart control.
 *
 * Text matching alone is not enough: recommendation carousels carry their own
 * add-to-cart buttons, and Target server-renders a disabled one on every page.
 * So candidates must be enabled AND inside the main product region when we can
 * identify one.
 */
function findCartButton() {
  const config = SELECTORS[SITE];
  const main =
    document.querySelector('main') ||
    document.querySelector('[data-testid="product-details"]') ||
    document.body;

  const candidates = queryAll(config.cart).concat(
    Array.from(document.querySelectorAll('button, input[type="submit"]')).filter((el) => {
      const label = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
      return CART_TEXT.test(label);
    }),
  );

  const seen = new Set();
  const unique = candidates.filter((el) => !seen.has(el) && seen.add(el));

  // Prefer buttons inside the main product region over carousel buttons.
  const scoped = unique.filter((el) => main.contains(el));
  const pool = scoped.length > 0 ? scoped : unique;

  return pool.find((el) => !isDisabled(el)) || null;
}

function readPrice() {
  for (const selector of SELECTORS[SITE].price) {
    for (const el of document.querySelectorAll(selector)) {
      const raw = el.getAttribute('content') || el.textContent || '';
      const match = /\$?\s*([0-9]+(?:\.[0-9]{2})?)/.exec(raw.replace(/,/g, ''));
      if (match) {
        const value = Number.parseFloat(match[1]);
        if (Number.isFinite(value) && value > 0) return value;
      }
    }
  }
  return null;
}

function onChallengePage() {
  if (CHALLENGE_TEXT.test(document.title)) return true;
  if (document.querySelector('#px-captcha, iframe[src*="captcha"]')) return true;
  // Challenge interstitials are tiny; a real PDP never is.
  return document.body.innerText.length < 2000 && CHALLENGE_TEXT.test(document.body.innerText);
}

async function attemptCart(button) {
  const price = readPrice();
  const { settings } = state;

  if (price === null) {
    report('skipped', 'Add to cart is live but no price could be read -- not clicking blind.');
    return false;
  }

  if (price > settings.maxPrice) {
    report('skipped', `Price $${price.toFixed(2)} is over your $${settings.maxPrice} cap. Probably a reseller listing.`);
    stop('price cap exceeded');
    return false;
  }

  report('in-stock', `Add to cart is live at $${price.toFixed(2)}`);

  if (!settings.armed) {
    report('not-armed', 'Alerting only -- arm the extension in options to let it click.');
    return false;
  }

  if (settings.dryRun) {
    report('dry-run', `Would have clicked Add to cart at $${price.toFixed(2)}. Turn off dry run to go live.`);
    stop('dry run complete');
    return false;
  }

  button.click();
  state.carts += 1;
  report('carted', `Clicked Add to cart at $${price.toFixed(2)}`);

  if (state.carts >= settings.maxCarts) {
    stop('cart limit reached');
    if (settings.goToCartAfterAdd) {
      // Give the click's XHR a moment to land before navigating away.
      setTimeout(() => {
        location.href =
          SITE === 'walmart' ? 'https://www.walmart.com/cart' : 'https://www.target.com/cart';
      }, 2500);
    }
  }
  return true;
}

function check() {
  if (state.stopped) return;

  if (onChallengePage()) {
    report('challenge', 'This tab hit a bot check. Solve it yourself in the browser, then reload.');
    stop('challenge page');
    return;
  }

  const button = findCartButton();
  const signature = button ? `${button.tagName}:${button.textContent?.trim()}` : 'none';
  if (signature === state.lastSignature) return;
  state.lastSignature = signature;

  if (button) attemptCart(button);
}

async function init() {
  state.settings = await loadSettings();

  report(
    'watching',
    `${SITE} | armed=${state.settings.armed} dryRun=${state.settings.dryRun} cap=$${state.settings.maxPrice}`,
  );

  state.observer = new MutationObserver(() => check());
  state.observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'class'],
  });

  state.pollTimer = setInterval(check, state.settings.pollMs);

  if (state.settings.reloadSeconds > 0) {
    state.reloadTimer = setTimeout(() => {
      if (!state.stopped) location.reload();
    }, state.settings.reloadSeconds * 1000);
  }

  check();
}

init();
