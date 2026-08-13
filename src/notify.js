'use strict';

const axios = require('axios');

const { config } = require('./config');
const { logger } = require('./utils');

function priceText(result) {
  return result.price != null ? `$${Number(result.price).toFixed(2)}` : 'price unknown';
}

function summary(result) {
  const name = result.product?.name || result.title || result.url;
  return `${name} is IN STOCK at ${result.siteLabel || result.site} (${priceText(result)})`;
}

async function postJson(url, payload, label) {
  try {
    await axios.post(url, payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });
    logger.debug('Notification delivered', { channel: label });
  } catch (error) {
    // A notifier failure must never take down the monitor.
    logger.error('Notification failed', { channel: label, error: error.message });
  }
}

const channels = [
  {
    name: 'discord',
    enabled: () => Boolean(config.notify.discordWebhookUrl),
    send: (result) =>
      postJson(
        config.notify.discordWebhookUrl,
        {
          content: `🔔 **${summary(result)}**\n${result.url}`,
        },
        'discord',
      ),
  },
  {
    name: 'slack',
    enabled: () => Boolean(config.notify.slackWebhookUrl),
    send: (result) =>
      postJson(
        config.notify.slackWebhookUrl,
        { text: `:bell: *${summary(result)}*\n${result.url}` },
        'slack',
      ),
  },
  {
    name: 'webhook',
    enabled: () => Boolean(config.notify.genericWebhookUrl),
    send: (result) =>
      postJson(
        config.notify.genericWebhookUrl,
        {
          event: 'restock',
          site: result.site,
          name: result.product?.name || result.title,
          url: result.url,
          price: result.price ?? null,
          detectedAt: result.checkedAt,
        },
        'webhook',
      ),
  },
];

/**
 * Fan out a restock event to every configured channel. Always logs, so the
 * event is recorded even with no webhooks set up.
 */
async function notifyRestock(result) {
  logger.success(`IN STOCK  ${summary(result)}`, {
    url: result.url,
    method: result.method,
  });

  if (config.notify.bell) process.stdout.write('\x07');

  const active = channels.filter((channel) => channel.enabled());
  await Promise.all(active.map((channel) => channel.send(result)));
}

module.exports = { notifyRestock, summary };
