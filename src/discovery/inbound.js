'use strict';

/**
 * Turn whatever an alert service sent -- a bare product link, a whole SMS
 * body, or a tracking/short link -- into a Walmart or Target product URL.
 *
 * Alert services (TrackaLacker and the like) often wrap the retailer link in
 * their own click-tracking redirect. Those redirects are followed here, but
 * only up to the point where the next hop is the retailer: the retailer page
 * itself is never fetched, because both retailers refuse plain HTTP clients
 * and the extension is what opens it, in your real session.
 */

const { extractProductUrls } = require('./reddit');
const { resolveSite } = require('../sites');

const MAX_HOPS = 5;
const HOP_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 256 * 1024;

function isRetailer(url) {
  try {
    resolveSite(url);
    return true;
  } catch {
    return false;
  }
}

function productFrom(url) {
  const found = extractProductUrls(url);
  return found.length > 0 ? found[0] : null;
}

/** Every http(s) URL in a block of text, trailing prose punctuation trimmed. */
function urlsIn(text) {
  return (String(text || '').match(/https?:\/\/[^\s"'<>)]+/g) || []).map((raw) =>
    raw.replace(/[.,;:!?)\]]+$/, ''),
  );
}

/**
 * Follow one non-retailer link until it points at a retailer product.
 * @returns {Promise<{url,site}|null>}
 */
async function followRedirects(start, fetchImpl) {
  let current = start;

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const direct = productFrom(current);
    if (direct) return direct;
    // A retailer page that isn't a product (a search, the homepage) is a dead
    // end, and fetching it would only earn a bot check.
    if (isRetailer(current)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HOP_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(current, { redirect: 'manual', signal: controller.signal });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }

    const location = response.headers?.get?.('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }

    // Some trackers answer 200 with a page that redirects in JavaScript or a
    // meta refresh; the destination is in the body either way.
    if (response.ok) {
      const body = (await response.text()).slice(0, MAX_BODY_BYTES).replace(/\\\//g, '/');
      const inBody = extractProductUrls(body);
      return inBody.length > 0 ? inBody[0] : null;
    }
    return null;
  }
  return null;
}

/**
 * @param {string} text  a URL, or a whole message containing one
 * @returns {Promise<{url: string, site: string} | {error: string}>}
 */
async function resolveAlertLink(text, { fetchImpl = fetch } = {}) {
  const direct = extractProductUrls(String(text || ''));
  if (direct.length > 0) return direct[0];

  const others = urlsIn(text).filter((url) => !isRetailer(url));
  if (others.length === 0) {
    return { error: 'No Walmart or Target product link found in what was sent' };
  }

  for (const url of others) {
    const found = await followRedirects(url, fetchImpl);
    if (found) return found;
  }
  return { error: 'The link did not lead to a Walmart or Target product page' };
}

module.exports = { resolveAlertLink };
