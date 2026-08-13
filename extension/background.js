'use strict';

/**
 * Turns content-script events into desktop notifications, so you get pulled
 * back to the tab even when it isn't focused, and relays them to the local
 * dashboard when one is running.
 */

importScripts('bridge.js');

const LOUD = new Set([
  'in-stock', 'carted', 'challenge', 'dry-run', 'skipped',
  'ready-to-submit', 'placing-order', 'refused',
]);

const TITLES = {
  'in-stock': '🔔 IN STOCK',
  carted: '✅ Added to cart',
  'checkout-step': '→ Checkout',
  'ready-to-submit': '🛒 Ready to submit',
  'placing-order': '💳 PLACING ORDER',
  refused: '🛑 Refused to submit',
  challenge: '⚠️ Bot check hit',
  'dry-run': '🧪 Dry run',
  skipped: '⏭️ Skipped',
  'not-armed': 'Alert only',
};

chrome.runtime.onMessage.addListener((message, sender) => {
  const { kind, detail, site } = message || {};
  if (!kind) return;

  console.log(`[pokebot:${site}] ${kind}`, detail || '');
  relayEvent(message);

  if (!LOUD.has(kind)) return;

  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon128.png',
    title: TITLES[kind] || 'Pokebot',
    message: detail || kind,
    priority: 2,
    requireInteraction: ['in-stock', 'carted', 'ready-to-submit', 'placing-order', 'refused']
      .includes(kind),
  });

  // Pull the tab to the front so you can intervene or finish up.
  const PULL_FORWARD = ['carted', 'in-stock', 'ready-to-submit', 'placing-order', 'refused', 'challenge'];
  if (PULL_FORWARD.includes(kind) && sender.tab) {
    chrome.tabs.update(sender.tab.id, { active: true });
    chrome.windows.update(sender.tab.windowId, { focused: true, drawAttention: true });
  }
});
