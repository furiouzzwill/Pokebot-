'use strict';

/**
 * Drop links posted in your own Discord.
 *
 * If your group already shares finds in a channel, that is usually faster and
 * more relevant than any public feed -- someone posts the link the moment they
 * see it. This polls the channel over the REST API and turns any Walmart or
 * Target product link into a watchlist candidate.
 *
 * Polling rather than a Gateway websocket: a few seconds of latency is
 * acceptable here, and it avoids carrying a heartbeat/resume implementation
 * for one read-only feature.
 *
 * Needs a bot token, the bot invited to your server, and Read Messages +
 * Read Message History on the channel. Message Content is a privileged intent
 * for Gateway use but is not required to read messages over REST.
 */

const { extractProductUrls, matchKeywords } = require('./reddit');

const API = 'https://discord.com/api/v10';

/**
 * Fetch recent messages from a channel.
 *
 * @param {string} afterId  only messages newer than this snowflake; on the
 *   first run pass nothing and only the latest few are taken, so an old
 *   backlog isn't replayed as fresh finds.
 */
async function fetchMessages(
  token,
  channelId,
  { afterId = null, limit = 25, fetchImpl = fetch, timeoutMs = 15000 } = {},
) {
  if (!token) return { error: 'no bot token', messages: [] };
  if (!channelId) return { error: 'no channel id', messages: [] };

  const params = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 100)) });
  if (afterId) params.set('after', afterId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${API}/channels/${channelId}/messages?${params}`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bot ${token}`,
        'User-Agent': 'pokebot (personal drop alerter, 0.1)',
      },
    });

    if (response.status === 429) {
      let retryAfterMs = 5000;
      try {
        const payload = await response.json();
        if (payload?.retry_after) retryAfterMs = Math.ceil(payload.retry_after * 1000);
      } catch {
        // Default stands.
      }
      return { rateLimited: true, retryAfterMs, messages: [] };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        error:
          response.status === 401
            ? 'bot token rejected'
            : 'bot cannot read that channel (needs Read Messages + Read Message History)',
        messages: [],
      };
    }

    if (!response.ok) return { error: `HTTP ${response.status}`, messages: [] };

    const messages = await response.json();
    return { messages: Array.isArray(messages) ? messages : [] };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'timed out' : err.message, messages: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn raw messages into candidates.
 *
 * Embeds matter as much as message text: a link pasted on its own is often
 * unfurled by Discord, and other alert bots post links inside embed fields
 * rather than in the body.
 */
function parseMessages(messages, { keywords = [], ignoreBots = false } = {}) {
  const candidates = [];

  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    // Other stock bots are usually the most valuable posters in a channel, so
    // they're included unless explicitly excluded.
    if (ignoreBots && message.author?.bot) continue;

    const embedText = (message.embeds || [])
      .map((embed) =>
        [
          embed.title,
          embed.description,
          embed.url,
          ...(embed.fields || []).map((f) => `${f.name} ${f.value}`),
        ]
          .filter(Boolean)
          .join(' '),
      )
      .join(' ');

    const text = `${message.content || ''} ${embedText}`.trim();
    if (text === '') continue;

    const matched = keywords.length === 0 ? [] : matchKeywords(text, keywords);
    const products = extractProductUrls(text);

    // A message with a product link is useful even without a keyword hit --
    // someone posting a Target Pokemon URL is the signal, whatever they typed.
    if (keywords.length > 0 && matched.length === 0 && products.length === 0) continue;

    const author = message.author?.username || 'someone';

    if (products.length > 0) {
      for (const product of products) {
        candidates.push({
          kind: 'product',
          key: product.url,
          url: product.url,
          site: product.site,
          title: text.replace(/\s+/g, ' ').slice(0, 140) || product.url,
          author,
          messageId: message.id,
          matched,
        });
      }
    } else {
      candidates.push({
        kind: 'announcement',
        key: `discord:${message.id}`,
        url: '',
        title: text.replace(/\s+/g, ' ').slice(0, 200),
        author,
        messageId: message.id,
        matched,
      });
    }
  }

  return candidates;
}

/** Highest snowflake in a batch, for the next poll's `after` cursor. */
function newestId(messages) {
  let newest = null;
  for (const message of messages || []) {
    const id = message?.id;
    if (!id) continue;
    // Snowflakes are numeric strings; compare by length then lexically so
    // this stays correct past Number.MAX_SAFE_INTEGER.
    if (newest === null || id.length > newest.length || (id.length === newest.length && id > newest)) {
      newest = id;
    }
  }
  return newest;
}

module.exports = { fetchMessages, parseMessages, newestId, API };
