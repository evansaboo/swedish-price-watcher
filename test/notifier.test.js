import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultState } from '../src/lib/store.js';
import { DiscordNotifier } from '../src/services/notifier.js';

// The scan-time alert rules and the wishlist target-price ("favorite") alerts
// were removed on 2026-10-31 together with the multi-source scan. What is left
// of the notifier is covered here (webhook delivery and retries) and in
// hotlistNotifications / komplettDemo tests.

const MAIN_WEBHOOK = 'https://discord.example/webhook';

function makeNotifier(opts = {}) {
  return new DiscordNotifier({ webhookUrl: MAIN_WEBHOOK, cooldownHours: 24, ...opts });
}

const BASE_ITEM = {
  listingKey: 'elgiganten-hotlist:1000290',
  sourceId: 'elgiganten-hotlist',
  sourceLabel: 'Elgiganten Hotlist',
  title: 'DJI Osmo Mobile 8 outlet',
  url: 'https://www.elgiganten.se/product/1000290',
  category: 'Kamerahandtag',
  condition: 'outlet',
  latestPriceSek: 1949,
  referencePriceSek: 2490,
  availability: 'in_stock',
  firstSeenAt: '2026-04-17T09:30:00.000Z',
  imageUrl: 'https://next-media.elkjop.com/image/1000290.jpg'
};

test('the scan alert rules and wishlist target alerts are gone', () => {
  const notifier = makeNotifier();
  assert.equal(notifier.notifyScan, undefined);
  assert.equal(notifier.notifyAlertRules, undefined);
  assert.equal(notifier.notifyWishlistTargets, undefined);
  assert.equal(typeof notifier.notifyHotlist, 'function');
  assert.equal(typeof notifier.notifyKomplettDemo, 'function');
  assert.equal(notifier.notifyNvidiaStockDrop, undefined);
});

test('retries the Discord webhook after a 429 and still delivers', async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false, status: 429, statusText: 'Too Many Requests',
        headers: { get(name) { return name.toLowerCase() === 'retry-after' ? '0' : null; } }
      };
    }
    return { ok: true, status: 204, statusText: 'No Content', headers: { get() { return null; } } };
  };

  try {
    const state = createDefaultState();
    const notifier = makeNotifier({ webhookMaxRetries: 2 });
    // No hotlist webhook of its own, so it falls back to the app default.
    const summary = await notifier.notifyHotlist({ newItems: [{ ...BASE_ITEM }], state, webhookUrl: '' });

    assert.equal(calls, 2);
    assert.equal(summary.sent, 1);
    assert.equal(summary.failed, 0);
    assert.ok(state.notifications[`${BASE_ITEM.listingKey}:hotlist`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a Discord 429 that never clears is reported, not thrown', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false, status: 429, statusText: 'Too Many Requests',
    headers: { get(name) { return name.toLowerCase() === 'retry-after' ? '0' : null; } }
  });

  try {
    const state = createDefaultState();
    const notifier = makeNotifier({ webhookMaxRetries: 1 });
    const summary = await notifier.notifyHotlist({ newItems: [{ ...BASE_ITEM }], state, webhookUrl: '' });

    assert.equal(summary.sent, 0);
    assert.equal(summary.failed, 1);
    assert.match(summary.errors[0], /429/i);
    assert.equal(state.notifications[`${BASE_ITEM.listingKey}:hotlist`], undefined, 'no cooldown for an undelivered alert');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
