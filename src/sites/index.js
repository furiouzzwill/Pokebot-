'use strict';

const walmart = require('./walmart');
const target = require('./target');

const ADAPTERS = [walmart, target];

/**
 * Pick the adapter for a product URL.
 * @throws when the host isn't one this project supports.
 */
function resolveSite(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported protocol "${url.protocol}" in ${rawUrl}`);
  }

  const adapter = ADAPTERS.find((site) => site.matches(url));
  if (!adapter) {
    const supported = ADAPTERS.map((s) => s.label).join(', ');
    throw new Error(`No adapter for ${url.hostname}. Supported sites: ${supported}`);
  }

  return { adapter, url };
}

module.exports = { resolveSite, ADAPTERS };
