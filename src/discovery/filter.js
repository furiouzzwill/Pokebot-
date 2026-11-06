'use strict';

/**
 * Decides whether a discovered listing is a drop worth looking at.
 *
 * The first version matched "pokemon" as a substring, which on a retailer
 * search page lets through nearly everything: Japanese and Korean imports from
 * marketplace sellers, plushies, sleeves, binders, shirts. Those flooded the
 * review queue (or, with auto-add on, the watchlist) and the actual new set
 * got lost among them.
 *
 * Three lists now, each matched on whole words with accents folded, so
 * "pokémon" == "pokemon" and "tin" doesn't fire inside "stinger":
 *
 *   requireKeywords  a listing must name the brand (search-page products only)
 *   keywords         ...and be one of the product types you actually buy
 *   excludeKeywords  ...and contain none of these. Exclusion always wins.
 */

/** Lowercase, strip accents, collapse whitespace. */
function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s_]+/g, ' ');
}

const cache = new Map();

/**
 * Whole-word, plural-tolerant matcher for one term. "etb" matches "ETBs";
 * "build & battle" matches as a phrase. Terms are user input, so they are
 * escaped rather than treated as regex.
 */
function termPattern(term) {
  const key = normalize(term).replace(/-/g, ' ').replace(/ +/g, ' ').trim();
  if (key === '') return null;
  if (!cache.has(key)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
    // \b only works next to word characters; a term like "& more" would
    // never match with it, so fall back to space/edge anchors there.
    const start = /^\w/.test(key) ? '\\b' : '(?:^|\\s)';
    const end = /\w$/.test(key) ? '(?:e?s)?\\b' : '(?=\\s|$)';
    cache.set(key, new RegExp(`${start}${escaped}${end}`));
  }
  return cache.get(key);
}

/** @returns {string[]} the terms that appear in text, in list order. */
function matchTerms(text, terms) {
  const haystack = normalize(text).replace(/-/g, ' ');
  return (terms || []).filter((term) => {
    const pattern = termPattern(term);
    return pattern !== null && pattern.test(haystack);
  });
}

/**
 * Screen a product listing's title (plus its URL slug, which usually repeats
 * the name and is there even when the tile's text hasn't rendered yet).
 *
 * @param {string} text
 * @param {object} rules  { keywords, requireKeywords, excludeKeywords }
 * @param {object} [options]
 * @param {boolean} [options.requireBrand=true]  apply requireKeywords
 * @param {boolean} [options.requireType=true]   apply keywords
 * @returns {{ok: boolean, matched: string[], excluded: string[], reason: string}}
 */
function screen(text, rules = {}, { requireBrand = true, requireType = true } = {}) {
  const keywords = rules.keywords || [];
  const brands = rules.requireKeywords || [];
  const excludes = rules.excludeKeywords || [];

  const excluded = matchTerms(text, excludes);
  if (excluded.length > 0) {
    return { ok: false, matched: [], excluded, reason: `excluded: ${excluded.join(', ')}` };
  }

  const brandHits = matchTerms(text, brands);
  if (requireBrand && brands.some((b) => normalize(b).trim() !== '')) {
    if (brandHits.length === 0) {
      return { ok: false, matched: [], excluded: [], reason: 'not the brand' };
    }
  }

  const typeHits = matchTerms(text, keywords);
  if (requireType && keywords.some((k) => normalize(k).trim() !== '') && typeHits.length === 0) {
    return { ok: false, matched: [], excluded: [], reason: 'not a product type you watch' };
  }

  return { ok: true, matched: [...brandHits, ...typeHits], excluded: [], reason: '' };
}

/** Turn a product URL's slug into words, e.g. /p/pokemon-etb/-/A-1 -> "pokemon etb". */
function slugText(url) {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[/_-]+/g, ' ');
  } catch {
    return '';
  }
}

module.exports = { normalize, matchTerms, screen, slugText };
