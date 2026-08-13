'use strict';

/**
 * Cart and checkout automation, running in your own logged-in session.
 *
 * Flow: cart page -> checkout page -> (optionally) submit the order.
 *
 * It relies on the payment method and address already saved in your retailer
 * account. It never enters, stores, or transmits card details -- there is
 * nowhere in this extension that a card number could live.
 *
 * Every step that spends money is gated on: armed, autoCheckout, placeOrder,
 * an order-total ceiling, an item-count ceiling, and a persisted per-day
 * budget claimed *before* the click.
 */

const SITE = location.hostname.includes('walmart') ? 'walmart' : 'target';

const PAGE = (() => {
  const path = location.pathname;
  if (/\/cart/.test(path)) return 'cart';
  if (/checkout|\/co-/.test(path)) return 'checkout';
  return 'other';
})();

const SEL = {
  walmart: {
    toCheckout: ['[data-automation-id="checkout-btn"]', '[data-testid="continue-to-checkout"]'],
    placeOrder: ['[data-automation-id="place-order"]', '[data-testid="place-order-button"]'],
    total: ['[data-automation-id="order-total"]', '[data-testid="order-total"]'],
    items: ['[data-testid="cart-item"]', '[data-automation-id="cart-item"]'],
  },
  target: {
    toCheckout: ['[data-test="checkout-button"]', '[data-test="cart-checkout-button"]'],
    placeOrder: ['[data-test="placeOrderButton"]', '[data-test="place-order-button"]'],
    total: ['[data-test="orderSummaryTotal"]', '[data-test="order-summary-total"]'],
    items: ['[data-test="cartItem"]', '[data-test="cart-item"]'],
  },
};

const TO_CHECKOUT_TEXT = /^(continue to checkout|check ?out|proceed to checkout|sign in to check out)$/i;
const PLACE_ORDER_TEXT = /^(place order|place your order|submit order|pay now)$/i;
const CHALLENGE_TEXT = /robot or human|confirm that you'?re human|press & hold|verify you are human|access denied/i;

const state = { settings: null, stopped: false, acted: false, timer: null };

function report(kind, detail) {
  console.log('%c[pokebot:checkout]', 'color:#e63946;font-weight:bold', kind, detail || '');
  try {
    chrome.runtime.sendMessage({ kind, detail, url: location.href, site: SITE });
  } catch {
    // Service worker asleep; console still has it.
  }
}

function stop(reason) {
  if (state.stopped) return;
  state.stopped = true;
  clearInterval(state.timer);
  banner(`stopped: ${reason}`, '#888');
  report('stopped', reason);
}

/** Always-visible state, with a kill switch. This spends money; be loud. */
function banner(text, color) {
  let el = document.getElementById('pokebot-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pokebot-banner';
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'font:13px/1.4 system-ui,sans-serif', 'color:#fff', 'padding:8px 14px',
      'display:flex', 'align-items:center', 'gap:12px', 'box-shadow:0 2px 8px #0004',
    ].join(';');
    const stopBtn = document.createElement('button');
    stopBtn.textContent = 'STOP';
    stopBtn.style.cssText =
      'margin-left:auto;font:inherit;font-weight:700;padding:2px 12px;cursor:pointer;' +
      'background:#fff;color:#111;border:0;border-radius:4px';
    stopBtn.onclick = () => stop('stopped by user');
    el.appendChild(document.createElement('span'));
    el.appendChild(stopBtn);
    document.documentElement.appendChild(el);
  }
  el.style.background = color;
  el.firstChild.textContent = `Pokebot — ${text}`;
  return el;
}

function onChallengePage() {
  if (CHALLENGE_TEXT.test(document.title)) return true;
  if (document.querySelector('#px-captcha, iframe[src*="captcha"]')) return true;
  return document.body.innerText.length < 2000 && CHALLENGE_TEXT.test(document.body.innerText);
}

function isDisabled(el) {
  return (
    el.disabled === true ||
    el.getAttribute('disabled') !== null ||
    el.getAttribute('aria-disabled') === 'true' ||
    el.offsetParent === null
  );
}

function findButton(selectors, textPattern) {
  const candidates = [];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) candidates.push(el);
  }
  for (const el of document.querySelectorAll('button, input[type="submit"], a[role="button"]')) {
    const label = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
    if (textPattern.test(label)) candidates.push(el);
  }
  return candidates.find((el) => !isDisabled(el)) || null;
}

/**
 * Read the order total. Returns null when it can't be read with confidence --
 * callers must treat that as "do not submit", never as zero.
 */
function readTotal() {
  for (const selector of SEL[SITE].total) {
    for (const el of document.querySelectorAll(selector)) {
      const match = /\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/.exec(el.textContent || '');
      if (match) {
        const value = Number.parseFloat(match[1].replace(/,/g, ''));
        if (Number.isFinite(value) && value > 0) return value;
      }
    }
  }
  // Fallback: a labelled total row anywhere on the page.
  const rows = Array.from(document.querySelectorAll('div, tr, li, section'));
  for (const row of rows) {
    const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/^(order )?total\b/i.test(text) || text.length > 60) continue;
    const match = /\$\s*([0-9][0-9,]*\.[0-9]{2})/.exec(text);
    if (match) return Number.parseFloat(match[1].replace(/,/g, ''));
  }
  return null;
}

function countItems() {
  for (const selector of SEL[SITE].items) {
    const found = document.querySelectorAll(selector);
    if (found.length > 0) return found.length;
  }
  return null;
}

async function handleCart() {
  const { settings } = state;
  const button = findButton(SEL[SITE].toCheckout, TO_CHECKOUT_TEXT);
  if (!button) return;

  if (!settings.autoCheckout) {
    banner('cart ready — auto-checkout is off, finish manually', '#b26a00');
    stop('auto-checkout disabled');
    return;
  }

  if (settings.dryRun) {
    banner('DRY RUN — would continue to checkout', '#555');
    report('dry-run', 'Would have clicked Continue to checkout.');
    stop('dry run');
    return;
  }

  state.acted = true;
  banner('continuing to checkout…', '#1d3557');
  report('checkout-step', 'Clicked Continue to checkout');
  button.click();
}

async function handleCheckout() {
  const { settings } = state;
  const button = findButton(SEL[SITE].placeOrder, PLACE_ORDER_TEXT);
  if (!button) return;

  const total = readTotal();
  const items = countItems();

  // ---- Refuse-to-submit checks. Any failure is terminal, not a retry. ----

  if (!settings.placeOrder) {
    banner(
      `ready to submit${total ? ` — $${total.toFixed(2)}` : ''} — click Place order yourself`,
      '#b26a00',
    );
    report('ready-to-submit', `Order is ready. Total ${total ? `$${total.toFixed(2)}` : 'unknown'}.`);
    stop('placeOrder disabled');
    return;
  }

  if (total === null) {
    banner('order total unreadable — refusing to submit', '#c1121f');
    report('refused', 'Could not read the order total. Not submitting blind.');
    stop('total unreadable');
    return;
  }

  if (total > settings.maxOrderTotal) {
    banner(`total $${total.toFixed(2)} over $${settings.maxOrderTotal} cap — refusing`, '#c1121f');
    report('refused', `Order total $${total.toFixed(2)} exceeds your $${settings.maxOrderTotal} cap.`);
    stop('over order-total cap');
    return;
  }

  if (items !== null && items > settings.maxOrderItems) {
    banner(`${items} items exceeds cap of ${settings.maxOrderItems} — refusing`, '#c1121f');
    report('refused', `Cart has ${items} items, over your cap of ${settings.maxOrderItems}.`);
    stop('over item cap');
    return;
  }

  if (!(await canPlaceOrder(settings.maxOrdersPerDay))) {
    banner(`daily order limit (${settings.maxOrdersPerDay}) already used`, '#c1121f');
    report('refused', `Already placed ${settings.maxOrdersPerDay} order(s) today.`);
    stop('daily limit reached');
    return;
  }

  if (settings.dryRun) {
    banner(`DRY RUN — would submit $${total.toFixed(2)}`, '#555');
    report('dry-run', `Would have placed the order. Total $${total.toFixed(2)}.`);
    stop('dry run');
    return;
  }

  // Claim the daily slot BEFORE clicking: the click navigates away, and a
  // write that never lands would let a reload place a second order.
  await recordOrder();

  state.acted = true;
  banner(`PLACING ORDER — $${total.toFixed(2)}`, '#c1121f');
  report('placing-order', `Submitting order, total $${total.toFixed(2)}`);
  button.click();
  stop('order submitted');
}

function tick() {
  if (state.stopped || state.acted) return;

  if (onChallengePage()) {
    banner('bot check — solve it yourself, then reload', '#c1121f');
    report('challenge', 'Checkout hit a bot check. Solve it in the browser and reload.');
    stop('challenge page');
    return;
  }

  if (PAGE === 'cart') handleCart();
  else if (PAGE === 'checkout') handleCheckout();
}

async function init() {
  if (PAGE === 'other') return;
  state.settings = await loadSettings();

  if (!state.settings.armed) {
    report('not-armed', 'Checkout automation is off (extension not armed).');
    return;
  }

  const mode = state.settings.dryRun
    ? 'DRY RUN'
    : state.settings.placeOrder
      ? 'LIVE — will submit orders'
      : 'will stop before submitting';
  banner(`${PAGE} — ${mode}`, state.settings.dryRun ? '#555' : '#1d3557');
  report('watching', `${SITE} ${PAGE} | ${mode}`);

  // Escape is a second kill switch, since the banner can be covered by modals.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') stop('escape pressed');
  });

  state.timer = setInterval(tick, state.settings.pollMs);
  tick();
}

init();
