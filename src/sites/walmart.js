'use strict';

const {
  IN_STOCK,
  OUT_OF_STOCK,
  UNKNOWN,
  BLOCKED,
  detectBotChallenge,
  extractScriptJson,
  deepCollect,
  readJsonLdProduct,
  readDomHeuristics,
  normalizePrice,
  pageTitle,
} = require('./common');

const OUT_OF_STOCK_PATTERNS = [
  /out of stock/i,
  /currently unavailable/i,
  /this item is no longer available/i,
  /sold out/i,
];

const IN_STOCK_PATTERNS = [/add to cart/i, /buy now/i];

/** e.g. https://www.walmart.com/ip/Some-Product-Name/1234567890 */
function itemId(url) {
  const match = /\/ip\/(?:[^/?#]+\/)?(\d{4,})/.exec(url);
  return match ? match[1] : null;
}

/**
 * Walmart renders the PDP from a __NEXT_DATA__ payload whose product node
 * carries an explicit availabilityStatus. That's the most trustworthy signal
 * on the page when it's present.
 */
function readNextData(html) {
  const nextData = extractScriptJson(html, '__NEXT_DATA__');
  if (!nextData) return null;

  const statuses = deepCollect(nextData, (key) => key === 'availabilityStatus');
  const value = statuses.find((s) => typeof s === 'string');
  if (!value) return null;

  const normalized = value.toUpperCase();
  let status = UNKNOWN;
  if (normalized === 'IN_STOCK') status = IN_STOCK;
  else if (normalized === 'OUT_OF_STOCK' || normalized === 'RETIRED') status = OUT_OF_STOCK;

  const names = deepCollect(nextData, (key) => key === 'name');
  const prices = deepCollect(nextData, (key) => key === 'currentPrice' || key === 'priceString');

  const priceNode = prices.find((p) => p != null);
  const price = priceNode && typeof priceNode === 'object'
    ? normalizePrice(priceNode.price ?? priceNode.priceString)
    : normalizePrice(priceNode);

  return {
    status,
    price,
    title: names.find((n) => typeof n === 'string' && n.length > 3) || null,
    method: 'next-data',
    raw: normalized,
  };
}

module.exports = {
  key: 'walmart',
  label: 'Walmart',
  matches: (url) => /(^|\.)walmart\.com$/i.test(url.hostname),

  /**
   * Ordered strategies, most authoritative first. Each returns null when its
   * signal isn't present so the next one gets a turn.
   */
  parse(html, url) {
    const challenge = detectBotChallenge(html);
    if (challenge) {
      return { status: BLOCKED, method: 'bot-challenge', matched: challenge, site: 'walmart', id: itemId(url), title: null };
    }

    const strategies = [
      () => readNextData(html),
      () => readJsonLdProduct(html),
      () => readDomHeuristics(html, {
        outOfStockPatterns: OUT_OF_STOCK_PATTERNS,
        inStockPatterns: IN_STOCK_PATTERNS,
      }),
    ];

    for (const strategy of strategies) {
      const result = strategy();
      if (result && result.status !== UNKNOWN) {
        return { ...result, site: 'walmart', id: itemId(url), title: result.title || pageTitle(html) };
      }
    }

    return { status: UNKNOWN, method: 'none', site: 'walmart', id: itemId(url), title: pageTitle(html) };
  },

  itemId,
};
