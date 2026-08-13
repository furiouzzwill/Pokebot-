'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');

/**
 * Hard floor on polling. Sub-second polling of a retailer you don't run is
 * abusive traffic and the fastest way to get your IP blocked, so the interval
 * is clamped here rather than left to config.
 */
const MIN_POLL_INTERVAL_MS = 5000;

function num(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function str(value, fallback) {
  const trimmed = (value || '').trim();
  return trimmed === '' ? fallback : trimmed;
}

const requestedInterval = num(process.env.POLL_INTERVAL_MS, 30000);
const pollIntervalMs = Math.max(requestedInterval, MIN_POLL_INTERVAL_MS);

const config = {
  root: ROOT,

  poll: {
    intervalMs: pollIntervalMs,
    // Surfaced so the CLI can tell the user their value was raised.
    requestedIntervalMs: requestedInterval,
    clamped: requestedInterval < MIN_POLL_INTERVAL_MS,
    minIntervalMs: MIN_POLL_INTERVAL_MS,
    jitterMs: Math.max(0, num(process.env.POLL_JITTER_MS, 5000)),
    timeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 15000),
    maxConsecutiveErrors: num(process.env.MAX_CONSECUTIVE_ERRORS, 5),
    // Backoff applied after maxConsecutiveErrors, then doubled up to the cap.
    errorBackoffMs: 60000,
    maxErrorBackoffMs: 15 * 60 * 1000,
  },

  http: {
    // A single honest, current desktop UA. Not rotated: rotating identities is
    // for evading blocks, and this tool has no business evading anything.
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    acceptLanguage: 'en-US,en;q=0.9',
  },

  notify: {
    discordWebhookUrl: str(process.env.DISCORD_WEBHOOK_URL, ''),
    slackWebhookUrl: str(process.env.SLACK_WEBHOOK_URL, ''),
    genericWebhookUrl: str(process.env.GENERIC_WEBHOOK_URL, ''),
    bell: bool(process.env.NOTIFY_BELL, true),
    renotifyMs: num(process.env.RENOTIFY_MINUTES, 0) * 60 * 1000,
  },

  log: {
    level: str(process.env.LOG_LEVEL, 'info'),
    dir: path.resolve(ROOT, str(process.env.LOG_DIR, 'logs')),
    toFile: bool(process.env.LOG_TO_FILE, true),
  },

  productsFile: path.resolve(ROOT, 'config', 'products.json'),
};

/**
 * Read and validate the product watchlist.
 * @returns {Array<{name: string, url: string, enabled: boolean}>}
 */
function loadProducts(file = config.productsFile) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Product list not found at ${file}`);
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Product list at ${file} is not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Product list at ${file} must be a JSON array`);
  }

  return parsed.map((entry, i) => {
    if (!entry || typeof entry.url !== 'string' || entry.url.trim() === '') {
      throw new Error(`Product at index ${i} is missing a "url"`);
    }
    return {
      name: str(entry.name, entry.url),
      url: entry.url.trim(),
      enabled: entry.enabled !== false,
    };
  });
}

module.exports = { config, loadProducts, MIN_POLL_INTERVAL_MS };
