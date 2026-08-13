'use strict';

/**
 * Turns content-script events into desktop notifications, so you get pulled
 * back to the tab even when it isn't focused.
 */

const LOUD = new Set(['in-stock', 'carted', 'challenge', 'dry-run', 'skipped']);

const TITLES = {
  'in-stock': '🔔 IN STOCK',
  carted: '✅ Added to cart',
  challenge: '⚠️ Bot check hit',
  'dry-run': '🧪 Dry run',
  skipped: '⏭️ Skipped',
  'not-armed': 'Alert only',
};

chrome.runtime.onMessage.addListener((message, sender) => {
  const { kind, detail, site } = message || {};
  if (!kind) return;

  console.log(`[pokebot:${site}] ${kind}`, detail || '');

  if (!LOUD.has(kind)) return;

  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon128.png',
    title: TITLES[kind] || 'Pokebot',
    message: detail || kind,
    priority: 2,
    requireInteraction: kind === 'in-stock' || kind === 'carted',
  });

  // Pull the tab to the front so you can finish checkout.
  if ((kind === 'carted' || kind === 'in-stock') && sender.tab) {
    chrome.tabs.update(sender.tab.id, { active: true });
    chrome.windows.update(sender.tab.windowId, { focused: true, drawAttention: true });
  }
});
