'use strict';

/**
 * Runs in your own logged-in tab on a Walmart or Target product page.
 *
 * Watches for the purchase control to become usable, sanity-checks the price,
 * clicks Add to cart, and then hands off to you. It does not touch checkout,
 * payment, or CAPTCHAs.
 */

const SITE = location.hostname.includes('walmart')
  ? 'walmart'
  : location.hostname.includes('amazon')
    ? 'amazon'
    : 'target';

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
  amazon: {
    // Add to Cart only. "Buy Now" skips the cart and the order-total checks.
    cart: ['#add-to-cart-button', 'input[name="submit.add-to-cart"]'],
    price: [
      '#corePrice_feature_div .a-offscreen',
      '#corePriceDisplay_desktop_feature_div .a-offscreen',
      '#apex_desktop .a-offscreen',
      '#price_inside_buybox',
      '#priceblock_ourprice',
    ],
    soldOut: ['#outOfStock'],
    seller: [
      '#merchantInfoFeature_feature_div',
      '[offer-display-feature-name="desktop-merchant-info"]',
      '#merchant-info',
      '#tabular-buybox',
    ],
    // The buy box; carousels below the fold carry their own cart buttons.
    region: ['#buybox', '#desktop_buybox', '#rightCol'],
  },
};

const CART_PAGE = {
  walmart: 'https://www.walmart.com/cart',
  target: 'https://www.target.com/cart',
  amazon: 'https://www.amazon.com/gp/cart/view.html',
};

const CART_TEXT = /^(add to cart|add for shipping|ship it|add to bag)$/i;
const CHALLENGE_TEXT = /robot or human|confirm that you'?re human|press & hold|verify you are human|access denied|enter the characters you see|type the characters you see/i;

const state = {
  settings: null,
  carts: 0,
  stopped: false,
  lastSignature: '',
  observer: null,
  pollTimer: null,
  reloadTimer: null,
  inviteDone: false,
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
  const region = (config.region || []).map((sel) => document.querySelector(sel)).find(Boolean);
  const main =
    region ||
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
  // Where the site has a known buy box, never look outside it: on a sold-out
  // page the only enabled cart buttons are in "similar items" carousels.
  const pool = region ? scoped : scoped.length > 0 ? scoped : unique;

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

/**
 * Who is selling the buy-box offer on Amazon. null when it can't be read.
 * @returns {{amazon: boolean, text: string}|null}
 */
function readAmazonSeller() {
  for (const selector of SELECTORS.amazon.seller) {
    const el = document.querySelector(selector);
    const text = (el?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const soldBy = /sold by:?\s*(.+?)(?:\s+(?:returns|payment|ships from|details|and fulfilled)\b|$)/i.exec(text);
    const seller = (soldBy ? soldBy[1] : text).trim();
    return {
      amazon: /^amazon(\.com)?\b/i.test(seller) && !/^amazon\s*(resale|warehouse)/i.test(seller),
      text: seller.slice(0, 60),
    };
  }
  return null;
}

/**
 * A skip (over the cap, wrong seller) is reported once per tab rather than on
 * every reload, or a 45-second reload loop buries the activity feed.
 */
function reportSkipOnce(detail) {
  const key = `pokebot:skip:${location.pathname}`;
  try {
    if (sessionStorage.getItem(key) === detail) return;
    sessionStorage.setItem(key, detail);
  } catch {
    // No storage; report every time rather than never.
  }
  report('skipped', detail);
}

async function attemptCart(button) {
  const price = readPrice();
  const { settings } = state;

  if (price === null) {
    report('skipped', 'Add to cart is live but no price could be read -- not clicking blind.');
    return false;
  }

  // Over the cap is usually a reseller holding the listing while first-party
  // stock is out. Keep watching (the reload timer stays on) so the real
  // restock at the normal price still gets caught.
  if (price > settings.maxPrice) {
    reportSkipOnce(`Price $${price.toFixed(2)} is over your $${settings.maxPrice} cap. Probably a reseller -- still watching.`);
    return false;
  }

  if (SITE === 'amazon' && settings.amazonOnly) {
    const seller = readAmazonSeller();
    if (!seller) {
      reportSkipOnce('In stock, but the seller could not be read -- not carting blind. Still watching.');
      return false;
    }
    if (!seller.amazon) {
      reportSkipOnce(`Sold by "${seller.text}", not Amazon -- still watching for Amazon's own stock.`);
      return false;
    }
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
        location.href = CART_PAGE[SITE];
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

  if (SITE === 'amazon') checkInvite();
  if (state.stopped) return;

  const button = findCartButton();
  const signature = button ? `${button.tagName}:${button.textContent?.trim()}` : 'none';
  if (signature === state.lastSignature) return;
  state.lastSignature = signature;

  if (button) attemptCart(button);
}

/**
 * Amazon gates some hyped items behind "Request invitation": one request per
 * account, and invites go out later. Requesting it as soon as the button
 * appears is the whole job; there is nothing to race after that.
 */
function checkInvite() {
  if (state.inviteDone) return;
  const button = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"]'))
    .find((el) => /^request (an )?invit(e|ation)$/i.test((el.textContent || el.value || '').trim()));
  if (!button || isDisabled(button)) return;
  state.inviteDone = true;

  if (!state.settings.armed || state.settings.dryRun) {
    report('in-stock', 'Amazon invite-only item: "Request invitation" is open. Request it now.');
    return;
  }
  button.click();
  report('carted', 'Requested an Amazon invitation for this item. Amazon emails you if you are picked.');
  stop('invitation requested');
}

/**
 * Reload on a jittered schedule while nothing is buyable. Jitter keeps a
 * dozen pinned tabs from reloading in lockstep, which looks far more like a
 * bot than a person and wastes a burst of requests at the same instant.
 */
function scheduleReload() {
  const base = state.settings.reloadSeconds * 1000;
  if (base <= 0) return;
  const delay = Math.max(20000, base * (0.8 + Math.random() * 0.4));
  state.reloadTimer = setTimeout(() => {
    if (!state.stopped && !onChallengePage()) location.reload();
  }, delay);
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

  scheduleReload();

  check();
}

init();
