'use strict';

/**
 * Amazon product pages.
 *
 * Used by the dashboard to validate and normalise pasted links, and by the
 * Node monitor. As with the other retailers, Amazon serves a CAPTCHA to plain
 * HTTP clients often enough that the Node monitor is a fallback at best --
 * the extension, running in your logged-in Chrome, is what buys.
 */

const {
  IN_STOCK,
  OUT_OF_STOCK,
  UNKNOWN,
  BLOCKED,
  detectBotChallenge,
  readJsonLdProduct,
  pageTitle,
} = require('./common');

// /dp/ASIN, /Some-Name/dp/ASIN, /gp/product/ASIN, /gp/aw/d/ASIN (mobile).
const ASIN = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin)\/([A-Z0-9]{10})(?=[/?#]|$)/i;

function itemId(url) {
  const match = ASIN.exec(typeof url === 'string' ? url : `${url.pathname}`);
  return match ? match[1].toUpperCase() : null;
}

/**
 * The one canonical form of an Amazon product link. Pasted links carry
 * tracking params, product-name slugs and ref tags that make the same item
 * look like several.
 */
function canonical(url) {
  const id = itemId(url);
  return id ? `https://www.amazon.com/dp/${id}` : null;
}

function readAvailability(html) {
  const block = /<div[^>]+id="availability"[^>]*>([\s\S]{0,2000}?)<\/div>/i.exec(html);
  const text = block ? block[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const hasCart = /id="add-to-cart-button"/i.test(html);

  if (/currently unavailable|out of stock|temporarily out of stock/i.test(text)) {
    return { status: OUT_OF_STOCK, method: 'availability', raw: text };
  }
  if (/in stock|only \d+ left/i.test(text) && hasCart) {
    return { status: IN_STOCK, method: 'availability', raw: text };
  }
  if (!text && hasCart) return { status: IN_STOCK, method: 'cart-button', raw: '' };
  return null;
}

module.exports = {
  key: 'amazon',
  label: 'Amazon',
  matches: (url) => /(^|\.)amazon\.com$/i.test(url.hostname),

  parse(html, url) {
    const id = itemId(url);
    if (/validateCaptcha|enter the characters you see below/i.test(html) || detectBotChallenge(html)) {
      return { status: BLOCKED, method: 'bot-challenge', site: 'amazon', id, title: null };
    }
    for (const strategy of [() => readAvailability(html), () => readJsonLdProduct(html)]) {
      const result = strategy();
      if (result && result.status !== UNKNOWN) {
        return { price: null, ...result, site: 'amazon', id, title: result.title || pageTitle(html) };
      }
    }
    return { status: UNKNOWN, method: 'none', site: 'amazon', id, title: pageTitle(html) };
  },

  itemId,
  canonical,
};
