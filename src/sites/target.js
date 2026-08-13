'use strict';

const {
  IN_STOCK,
  OUT_OF_STOCK,
  UNKNOWN,
  BLOCKED,
  detectBotChallenge,
  deepCollect,
  readJsonLdProduct,
  readDomHeuristics,
  pageTitle,
} = require('./common');

const OUT_OF_STOCK_PATTERNS = [
  /out of stock/i,
  /sold out/i,
  /this item isn'?t sold online/i,
  /not available at/i,
  /temporarily out of stock/i,
];

const IN_STOCK_PATTERNS = [/add to cart/i, /ship it/i, /pick it up/i];

/** Target PDP URLs end in /-/A-<tcin>. */
function itemId(url) {
  const match = /\/A-(\d+)/.exec(url.pathname);
  return match ? match[1] : null;
}

/**
 * Target hydrates from an inline __TGT_DATA__ blob rather than a clean JSON
 * script tag, so pull the availability fields out of whatever inline JSON the
 * page shipped instead of assuming a fixed shape.
 */
function readInlineState(html) {
  const blobs = [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html)) !== null) {
    const body = match[1];
    if (!/availability_status|available_to_promise|purchase_limit/i.test(body)) continue;
    // Recover the largest balanced-looking JSON object in the script body.
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      blobs.push(JSON.parse(body.slice(start, end + 1)));
    } catch {
      // Inline state is often wrapped in JS expressions; ignore what won't parse.
    }
  }

  for (const blob of blobs) {
    const statuses = deepCollect(blob, (key) => /^availability_status$/i.test(key));
    const value = statuses.find((s) => typeof s === 'string');
    if (!value) continue;

    const normalized = value.toUpperCase();
    let status = UNKNOWN;
    if (normalized === 'IN_STOCK' || normalized === 'PRE_ORDER_SELLABLE') status = IN_STOCK;
    else if (normalized === 'OUT_OF_STOCK' || normalized === 'UNAVAILABLE') status = OUT_OF_STOCK;

    if (status !== UNKNOWN) {
      const titles = deepCollect(blob, (key) => key === 'title');
      return {
        status,
        method: 'inline-state',
        raw: normalized,
        title: titles.find((t) => typeof t === 'string' && t.length > 3) || null,
        price: null,
      };
    }
  }

  return null;
}

module.exports = {
  key: 'target',
  label: 'Target',
  matches: (url) => /(^|\.)target\.com$/i.test(url.hostname),

  parse(html, url) {
    const challenge = detectBotChallenge(html);
    if (challenge) {
      return { status: BLOCKED, method: 'bot-challenge', matched: challenge, site: 'target', id: itemId(url), title: null };
    }

    const strategies = [
      () => readInlineState(html),
      () => readJsonLdProduct(html),
      () => readDomHeuristics(html, {
        outOfStockPatterns: OUT_OF_STOCK_PATTERNS,
        inStockPatterns: IN_STOCK_PATTERNS,
      }),
    ];

    for (const strategy of strategies) {
      const result = strategy();
      if (result && result.status !== UNKNOWN) {
        return { ...result, site: 'target', id: itemId(url), title: result.title || pageTitle(html) };
      }
    }

    return { status: UNKNOWN, method: 'none', site: 'target', id: itemId(url), title: pageTitle(html) };
  },

  itemId,
};
