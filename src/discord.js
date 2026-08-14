'use strict';

/**
 * Outbound Discord alerts.
 *
 * Posts through an incoming webhook, which needs no bot and no OAuth -- the
 * URL itself is the credential. Treat it like a password: anyone holding it
 * can post to that channel.
 */

/** Colours read at a glance in a busy channel. */
const COLOURS = {
  'in-stock': 0xf5a524, // amber - act now
  carted: 0x2ecc71, // green - it worked
  'placing-order': 0x2ecc71,
  'ready-to-submit': 0xf5a524,
  refused: 0xe74c3c, // red - it stopped on purpose
  challenge: 0xe74c3c,
  discovered: 0x5865f2, // blurple - informational
  'dry-run': 0x95a5a6,
};

const TITLES = {
  'in-stock': '🔔 In stock',
  carted: '✅ Added to cart',
  'placing-order': '💳 Placing order',
  'ready-to-submit': '🛒 Ready to submit',
  refused: '🛑 Refused to submit',
  challenge: '⚠️ Bot check hit',
  discovered: '👀 New product found',
  'dry-run': '🧪 Dry run',
};

/** Which events are worth a ping by default. Chatter kills a channel. */
const DEFAULT_EVENTS = [
  'in-stock',
  'carted',
  'placing-order',
  'ready-to-submit',
  'refused',
  'challenge',
  'discovered',
];

function buildEmbed({ kind, title, detail, url, site, source }) {
  const fields = [];
  if (site) fields.push({ name: 'Store', value: String(site), inline: true });
  if (source) fields.push({ name: 'Found via', value: String(source), inline: true });

  const embed = {
    title: TITLES[kind] || kind,
    color: COLOURS[kind] ?? 0x99aab5,
    description: [title, detail].filter(Boolean).join('\n').slice(0, 4000),
    timestamp: new Date().toISOString(),
  };

  if (fields.length) embed.fields = fields;
  // Only a real http(s) link may go in the embed url; Discord rejects others.
  if (url && /^https?:\/\//i.test(url)) embed.url = url;

  return embed;
}

/**
 * Post one alert.
 *
 * Never throws: an alerting failure must not interrupt a drop. Returns a
 * result object so the caller can log or back off.
 *
 * @returns {Promise<{ok: boolean, status?: number, retryAfterMs?: number, error?: string}>}
 */
async function postAlert(webhookUrl, event, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!webhookUrl) return { ok: false, error: 'no webhook configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    username: 'Pokebot',
    embeds: [buildEmbed(event)],
  };
  // A ping should be opt-in per event, not blanket -- @everyone on every
  // restock is how a channel gets muted.
  if (event.mention) body.content = event.mention;

  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.status === 429) {
      let retryAfterMs = 5000;
      try {
        const payload = await response.json();
        if (payload && payload.retry_after) retryAfterMs = Math.ceil(payload.retry_after * 1000);
      } catch {
        // Body wasn't JSON; the default stands.
      }
      return { ok: false, status: 429, retryAfterMs };
    }

    // Discord returns 204 with no body on success.
    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status };
    return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** A webhook URL, roughly validated before we try to use it. */
function isWebhookUrl(value) {
  return /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(
    String(value || '').trim(),
  );
}

module.exports = { postAlert, buildEmbed, isWebhookUrl, DEFAULT_EVENTS, TITLES, COLOURS };
