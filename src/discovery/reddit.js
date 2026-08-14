'use strict';

/**
 * Drop announcements from subreddit RSS.
 *
 * Communities like r/pkmntcgdeals post "TARGET DROP TONIGHT 3am EST" hours
 * before a listing exists, which is the earliest usable signal there is --
 * earlier than any retailer page, because the page isn't up yet.
 *
 * Reddit serves Atom at /r/<sub>/new/.rss with no auth, but rate-limits
 * unauthenticated polling hard (429s are routine), so the caller must back off
 * rather than retry tightly.
 */

const { resolveSite } = require('../sites');

/** Reddit asks for a descriptive UA and throttles generic ones harder. */
const USER_AGENT = 'pokebot/0.1 (personal drop alerter)';

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tag(entry, name) {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry);
  return match ? decodeEntities(match[1]).trim() : '';
}

/**
 * Pull the retailer product URLs out of a post body.
 *
 * Matching on URL shape rather than markup: a Walmart or Target product link
 * has a stable path pattern, and that survives redesigns in a way that CSS
 * selectors do not.
 */
function extractProductUrls(html) {
  const found = [];
  const seen = new Set();
  const candidates = decodeEntities(html).match(/https?:\/\/[^\s"'<>)]+/g) || [];

  for (const raw of candidates) {
    // Trim trailing punctuation that comes from prose, not the URL.
    const url = raw.replace(/[.,;:!?)\]]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const { adapter } = resolveSite(url);
      // resolveSite accepts any page on a supported host; require a product.
      if (adapter.itemId(new URL(url))) found.push({ url, site: adapter.key });
    } catch {
      // Not a supported retailer, or not a URL. Ignore.
    }
  }
  return found;
}

/** @returns {string[]} the keywords that matched, empty when none did. */
function matchKeywords(text, keywords) {
  const haystack = text.toLowerCase();
  return keywords.filter((word) => {
    const needle = String(word).trim().toLowerCase();
    return needle !== '' && haystack.includes(needle);
  });
}

/**
 * Parse a subreddit Atom feed into candidate announcements.
 *
 * @param {string} xml     raw feed body
 * @param {object} options
 * @param {string[]} options.keywords  post must match at least one (empty = all posts)
 * @returns {Array<object>} one entry per matching post
 */
function parseFeed(xml, { keywords = [] } = {}) {
  const source = String(xml || '');
  const feedTitle = tag(source.split('<entry>')[0] || '', 'title');
  const results = [];

  for (const chunk of source.split('<entry>').slice(1)) {
    const entry = chunk.split('</entry>')[0];

    const title = tag(entry, 'title');
    const content = tag(entry, 'content');
    // t3_xxxxx -- stable across edits, so it dedupes reliably.
    const id = tag(entry, 'id');
    const updated = tag(entry, 'updated');
    const linkMatch = /<link[^>]*href="([^"]+)"/.exec(entry);
    const permalink = linkMatch ? decodeEntities(linkMatch[1]) : '';

    if (!id && !permalink) continue;

    const matched = keywords.length === 0 ? [] : matchKeywords(`${title} ${content}`, keywords);
    if (keywords.length > 0 && matched.length === 0) continue;

    results.push({
      id: id || permalink,
      title,
      permalink,
      feed: feedTitle,
      at: updated || new Date().toISOString(),
      matched,
      products: extractProductUrls(content),
    });
  }

  return results;
}

/**
 * Fetch and parse one subreddit.
 *
 * Returns `{ rateLimited: true }` rather than throwing on a 429, because that
 * is an expected steady-state condition, not a failure.
 */
async function fetchSubreddit(subreddit, { keywords = [], timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new/.rss`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml, application/xml' },
    });

    if (response.status === 429) return { subreddit, rateLimited: true, entries: [] };
    if (!response.ok) {
      return { subreddit, error: `HTTP ${response.status}`, entries: [] };
    }

    const xml = await response.text();
    return { subreddit, entries: parseFeed(xml, { keywords }) };
  } catch (err) {
    return { subreddit, error: err.name === 'AbortError' ? 'timed out' : err.message, entries: [] };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  parseFeed,
  extractProductUrls,
  matchKeywords,
  fetchSubreddit,
  USER_AGENT,
};
