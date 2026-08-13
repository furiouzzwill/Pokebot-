'use strict';

const { EventEmitter } = require('events');

const { config } = require('./config');
const { fetchHtml } = require('./fetch');
const { resolveSite } = require('./sites');
const { IN_STOCK, OUT_OF_STOCK, UNKNOWN, BLOCKED } = require('./sites/common');
const { logger, sleep, jitter, humanDuration, truncate } = require('./utils');

/**
 * Check a single product URL once.
 *
 * This is the unit the whole monitor is built on, and it's side-effect free
 * apart from the network call -- call it directly to test a URL or a new
 * parser without starting a watch loop.
 *
 * @param {string} rawUrl Walmart or Target product URL.
 * @returns {Promise<object>} status, site, title, price, method, elapsedMs.
 */
async function checkProduct(rawUrl, options = {}) {
  const { adapter, url } = resolveSite(rawUrl);
  const { html, elapsedMs } = await fetchHtml(url, options);

  if (html.trim() === '') {
    return {
      status: UNKNOWN,
      site: adapter.key,
      url: String(url),
      method: 'empty-response',
      elapsedMs,
      checkedAt: new Date().toISOString(),
    };
  }

  const parsed = adapter.parse(html, url);

  return {
    ...parsed,
    site: adapter.key,
    siteLabel: adapter.label,
    url: String(url),
    elapsedMs,
    bytes: html.length,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Watches a list of products and emits when stock state changes.
 *
 * Events:
 *   check    (result)               every completed check
 *   change   ({from, to, result})   status transition, in either direction
 *   restock  (result)               transition into in_stock -- the one you care about
 *   blocked  (result)               origin served an anti-bot challenge
 *   error    ({product, error})     a check failed
 *   stopped  ()
 */
class Monitor extends EventEmitter {
  constructor(products, options = {}) {
    super();
    this.products = products;
    this.intervalMs = options.intervalMs ?? config.poll.intervalMs;
    this.jitterMs = options.jitterMs ?? config.poll.jitterMs;
    this.maxConsecutiveErrors = options.maxConsecutiveErrors ?? config.poll.maxConsecutiveErrors;
    this.once = options.once === true;
    this.running = false;
    this.controller = null;
    this.state = new Map(); // url -> { status, errors, backoffMs, lastNotifiedAt, checks }
  }

  start() {
    if (this.running) return Promise.resolve();
    this.running = true;
    this.controller = new AbortController();

    const loops = this.products.map((product, index) => this.#loop(product, index));
    return Promise.all(loops).then(() => {
      this.running = false;
      this.emit('stopped');
    });
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.controller?.abort();
  }

  stateOf(url) {
    if (!this.state.has(url)) {
      this.state.set(url, {
        status: null,
        errors: 0,
        backoffMs: 0,
        lastNotifiedAt: 0,
        checks: 0,
      });
    }
    return this.state.get(url);
  }

  async #loop(product, index) {
    // Stagger startup so N products don't all fire their first request at once.
    if (index > 0) await sleep(Math.min(index * 750, this.intervalMs));

    while (this.running) {
      const waitMs = await this.#tick(product);
      if (this.once || !this.running) break;
      await sleep(waitMs);
    }
  }

  async #tick(product) {
    const state = this.stateOf(product.url);
    const label = truncate(product.name);

    try {
      const result = await checkProduct(product.url, { signal: this.controller?.signal });
      state.checks += 1;
      const enriched = { ...result, product };
      this.emit('check', enriched);

      // A challenge page is not a stock reading. Leave the last known status
      // untouched, warn once, and back off -- polling harder makes it worse.
      if (result.status === BLOCKED) {
        state.blocked = (state.blocked || 0) + 1;
        if (state.blocked === 1) this.emit('blocked', enriched);
        state.backoffMs = state.backoffMs
          ? Math.min(state.backoffMs * 2, config.poll.maxErrorBackoffMs)
          : config.poll.errorBackoffMs;
        return state.backoffMs;
      }

      state.errors = 0;
      state.backoffMs = 0;
      state.blocked = 0;

      const previous = state.status;
      if (result.status !== previous) {
        state.status = result.status;
        if (previous !== null) {
          this.emit('change', { from: previous, to: result.status, result: enriched });
        }
        if (result.status === IN_STOCK) {
          state.lastNotifiedAt = Date.now();
          this.emit('restock', enriched);
        }
      } else if (
        result.status === IN_STOCK &&
        config.notify.renotifyMs > 0 &&
        Date.now() - state.lastNotifiedAt >= config.notify.renotifyMs
      ) {
        state.lastNotifiedAt = Date.now();
        this.emit('restock', enriched);
      }

      return jitter(this.intervalMs, this.jitterMs);
    } catch (error) {
      if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') return 0;

      state.errors += 1;
      this.emit('error', { product, error, consecutive: state.errors });

      // Explicit Retry-After from the origin always wins.
      if (error.retryAfterMs) {
        logger.warn('Backing off on origin request', {
          product: label,
          waitFor: humanDuration(error.retryAfterMs),
        });
        return error.retryAfterMs;
      }

      if (state.errors >= this.maxConsecutiveErrors) {
        state.backoffMs = state.backoffMs
          ? Math.min(state.backoffMs * 2, config.poll.maxErrorBackoffMs)
          : config.poll.errorBackoffMs;
        logger.warn('Repeated failures, backing off', {
          product: label,
          consecutive: state.errors,
          waitFor: humanDuration(state.backoffMs),
        });
        return state.backoffMs;
      }

      return jitter(this.intervalMs, this.jitterMs);
    }
  }
}

module.exports = { Monitor, checkProduct, IN_STOCK, OUT_OF_STOCK, UNKNOWN, BLOCKED };
