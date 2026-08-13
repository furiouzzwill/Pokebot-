'use strict';

const axios = require('axios');

const { config } = require('./config');

/**
 * Fetch a product page as HTML.
 *
 * Deliberately plain: one honest user agent, standard headers, no proxy
 * rotation or fingerprint spoofing. If a retailer blocks this, the answer is
 * to poll less often or use their official API -- not to disguise the client.
 */
async function fetchHtml(url, { timeoutMs = config.poll.timeoutMs, signal } = {}) {
  const started = Date.now();

  const response = await axios.get(String(url), {
    timeout: timeoutMs,
    signal,
    maxRedirects: 5,
    responseType: 'text',
    // Let non-2xx through so the caller can distinguish 404 from 503/429.
    validateStatus: () => true,
    transformResponse: [(body) => body],
    headers: {
      'User-Agent': config.http.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': config.http.acceptLanguage,
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  const elapsedMs = Date.now() - started;
  const { status, headers } = response;

  if (status === 429 || status === 503) {
    const retryAfter = Number.parseInt(headers['retry-after'], 10);
    const err = new Error(`Rate limited by origin (HTTP ${status})`);
    err.code = 'RATE_LIMITED';
    err.retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : null;
    err.httpStatus = status;
    throw err;
  }

  if (status >= 400) {
    const err = new Error(`HTTP ${status} fetching product page`);
    err.code = 'HTTP_ERROR';
    err.httpStatus = status;
    throw err;
  }

  return { html: String(response.data ?? ''), status, elapsedMs };
}

module.exports = { fetchHtml };
