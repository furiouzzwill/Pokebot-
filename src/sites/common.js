'use strict';

const cheerio = require('cheerio');

const IN_STOCK = 'in_stock';
const OUT_OF_STOCK = 'out_of_stock';
const UNKNOWN = 'unknown';
/** The origin served an anti-bot interstitial instead of the product page. */
const BLOCKED = 'blocked';

/**
 * Signatures of the bot-challenge pages both retailers return to non-browser
 * clients. Verified against live responses: Walmart serves a PerimeterX
 * "Robot or human?" page with a #px-captcha mount, and Target's redsky API
 * answers 403 with a captcha URL payload.
 *
 * These must be checked before any stock parsing. A challenge page has no
 * product markup, so the DOM heuristics would otherwise read it as
 * "no out-of-stock text found" and risk a false in-stock alert.
 */
const CHALLENGE_PATTERNS = [
  /<title>\s*Robot or human\?/i,
  /id="px-captcha"/i,
  /captchaRelativeURL/i,
  /\/_sec\/cp_challenge\//i,
  /Access to this page has been denied/i,
  /Pardon Our Interruption/i,
  /confirm that you'?re human/i,
];

/**
 * @returns {string|null} the matched signature, or null if this looks like a
 *   real page.
 */
function detectBotChallenge(html) {
  if (typeof html !== 'string' || html.length === 0) return null;
  // Challenge pages are tiny; scanning the head of a large real page is enough
  // and keeps this cheap on 400KB PDPs.
  const sample = html.length > 20000 ? html.slice(0, 20000) : html;
  for (const pattern of CHALLENGE_PATTERNS) {
    if (pattern.test(sample)) return String(pattern);
  }
  return null;
}

/**
 * Parse every <script type="application/ld+json"> block and flatten @graph
 * containers, so callers get a plain list of schema.org nodes.
 */
function extractJsonLd(html) {
  const $ = cheerio.load(html);
  const nodes = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // Malformed blocks are common in the wild; skip rather than throw.
    }
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node['@graph'])) nodes.push(...node['@graph']);
      else nodes.push(node);
    }
  });

  return nodes;
}

/** Contents of a `<script id="...">` JSON payload (e.g. Walmart's __NEXT_DATA__). */
function extractScriptJson(html, id) {
  const $ = cheerio.load(html);
  const raw = $(`script#${id}`).contents().text().trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Walk a nested object/array and return values whose key matches `keyTest`.
 * Retailers move their JSON around constantly; searching by key name survives
 * restructuring that a fixed path would not.
 */
function deepCollect(value, keyTest, limit = 25, seen = new Set()) {
  const found = [];

  function walk(node) {
    if (found.length >= limit) return;
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      if (found.length >= limit) return;
      if (keyTest(key)) found.push(child);
      walk(child);
    }
  }

  walk(value);
  return found;
}

/** Map a schema.org availability URL/string onto our status enum. */
function statusFromSchemaAvailability(availability) {
  if (typeof availability !== 'string') return UNKNOWN;
  const value = availability.toLowerCase();
  if (value.includes('outofstock') || value.includes('soldout') || value.includes('discontinued')) {
    return OUT_OF_STOCK;
  }
  if (value.includes('backorder') || value.includes('preorder')) return OUT_OF_STOCK;
  if (value.includes('instock') || value.includes('instoreonly') || value.includes('limitedavailability')) {
    return IN_STOCK;
  }
  return UNKNOWN;
}

/** Shared JSON-LD strategy: both Walmart and Target publish Product offers. */
function readJsonLdProduct(html) {
  const nodes = extractJsonLd(html);
  const product = nodes.find((n) => {
    const type = n['@type'];
    return Array.isArray(type) ? type.includes('Product') : type === 'Product';
  });
  if (!product) return null;

  const offers = [].concat(product.offers || []);
  let status = UNKNOWN;
  let price = null;

  for (const offer of offers) {
    if (!offer || typeof offer !== 'object') continue;
    const offerStatus = statusFromSchemaAvailability(offer.availability);
    if (offerStatus === IN_STOCK) status = IN_STOCK;
    else if (offerStatus === OUT_OF_STOCK && status === UNKNOWN) status = OUT_OF_STOCK;
    if (price === null && offer.price != null) price = normalizePrice(offer.price);
    if (price === null && offer.lowPrice != null) price = normalizePrice(offer.lowPrice);
  }

  if (status === UNKNOWN && !product.name) return null;

  return {
    status,
    price,
    title: typeof product.name === 'string' ? product.name : null,
    method: 'json-ld',
  };
}

function normalizePrice(value) {
  const parsed = Number.parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function isDisabled($, el) {
  const node = $(el);
  return (
    node.attr('disabled') !== undefined ||
    node.attr('aria-disabled') === 'true' ||
    node.attr('data-disabled') === 'true'
  );
}

/**
 * Last-resort read of the rendered DOM.
 *
 * Two rules learned from real pages:
 *  - Out-of-stock text beats add-to-cart text, because "Add to cart" appears in
 *    recommendation carousels on sold-out pages.
 *  - An add-to-cart *button* only counts as in-stock when it is not disabled.
 *    Target server-renders a disabled add-to-cart button on every PDP and fills
 *    in real availability after hydration, so matching the bare string reports
 *    in-stock for everything.
 *
 * Returns null (-> UNKNOWN) rather than guessing when the only add-to-cart
 * control on the page is disabled but nothing says it is out of stock: that
 * shape means stock lives in client-side state this parser cannot see.
 */
function readDomHeuristics(html, { outOfStockPatterns, inStockPatterns }) {
  const $ = cheerio.load(html);

  const buttons = $('button, input[type="submit"], a[role="button"]').filter((_, el) => {
    const label = ($(el).text() || $(el).attr('value') || $(el).attr('aria-label') || '').trim();
    return inStockPatterns.some((pattern) => pattern.test(label));
  });

  $('script, style, noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  for (const pattern of outOfStockPatterns) {
    if (pattern.test(text)) {
      return { status: OUT_OF_STOCK, method: 'dom-heuristic', matched: String(pattern) };
    }
  }

  if (buttons.length > 0) {
    const enabled = buttons.toArray().filter((el) => !isDisabled($, el));
    if (enabled.length > 0) {
      return { status: IN_STOCK, method: 'dom-heuristic', matched: 'enabled add-to-cart control' };
    }
    // Every purchase control is disabled and no copy explains why: not a
    // reliable out-of-stock signal, so decline to answer.
    return null;
  }

  return null;
}

function pageTitle(html) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  return title || null;
}

module.exports = {
  IN_STOCK,
  OUT_OF_STOCK,
  UNKNOWN,
  BLOCKED,
  detectBotChallenge,
  extractJsonLd,
  extractScriptJson,
  deepCollect,
  statusFromSchemaAvailability,
  readJsonLdProduct,
  readDomHeuristics,
  normalizePrice,
  pageTitle,
};
