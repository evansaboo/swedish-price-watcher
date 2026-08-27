import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordNotifier } from '../src/services/notifier.js';
import { normalizeHotlistConfig, ensureHotlistConfig, normalizeWebhookUrl } from '../src/services/hotlistConfig.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123/abc';
const OTHER_WEBHOOK = 'https://discord.com/api/webhooks/999/zzz';
const HOTLIST_SOURCE = 'elgiganten-hotlist';

function makeItem(overrides = {}) {
  return {
    listingKey: 'k1',
    sourceId: HOTLIST_SOURCE,
    sourceLabel: 'Elgiganten Hotlist',
    title: 'iPhone 17 Pro Max 256GB',
    category: 'Mobiltelefoner',
    priceSek: 9000,
    referencePriceSek: 12000,
    url: 'https://www.elgiganten.se/product/1',
    seenAt: new Date().toISOString(),
    firstSeenAt: new Date().toISOString(),
    ...overrides
  };
}

/** Captures deliveries instead of hitting Discord. */
function makeNotifier(extra = {}) {
  const notifier = new DiscordNotifier({
    webhookUrl: '',
    cooldownHours: 6,
    hotlistSourceId: HOTLIST_SOURCE,
    ...extra
  });
  const delivered = [];
  notifier.postWebhook = async (url, payload) => { delivered.push({ url, payload }); };
  // #deliverAlert is private; intercept the public send path it relies on.
  notifier.sendWebhook = notifier.postWebhook;
  return { notifier, delivered };
}

test('hotlist config carries its own webhook', () => {
  const config = normalizeHotlistConfig({ webhookUrl: WEBHOOK, groups: [] });
  assert.equal(config.webhookUrl, WEBHOOK);
  assert.equal(config.notifyPriceDrops, true, 'price drops on by default');
});

test('only real Discord webhook URLs are accepted', () => {
  // Anything that slipped through would be POSTed to on every poll.
  assert.equal(normalizeWebhookUrl('https://discord.com/api/webhooks/1/x'), 'https://discord.com/api/webhooks/1/x');
  assert.equal(normalizeWebhookUrl('https://discordapp.com/api/webhooks/1/x'), 'https://discordapp.com/api/webhooks/1/x');
  assert.equal(normalizeWebhookUrl('https://evil.example.com/webhook'), '');
  assert.equal(normalizeWebhookUrl('http://discord.com/api/webhooks/1/x'), '', 'plain http rejected');
  assert.equal(normalizeWebhookUrl(''), '');
  assert.equal(normalizeWebhookUrl(null), '');
});

test('alert rules never match hotlist items', async () => {
  const { notifier } = makeNotifier();
  const state = { items: {}, notifications: {} };

  // A generic keyword rule that would previously have caught this hotlist
  // find and routed it to an unrelated channel.
  const summary = await notifier.notifyAlertRules({
    newItems: [makeItem()],
    priceDrops: [],
    state,
    alertRules: [{
      id: 'r1',
      label: 'Iphone',
      enabled: true,
      keywords: ['iphone'],
      categories: [],
      webhooks: [OTHER_WEBHOOK],
      filteredSources: ['tradera-sold'],
      sourceFilterMode: 'exclude'
    }]
  });

  assert.equal(summary.sent, 0, 'hotlist find must not reach an alert rule');
});

test('alert rules still match non-hotlist items', async () => {
  const { notifier } = makeNotifier();
  const state = { items: {}, notifications: {} };
  let attempted = 0;
  notifier.notifyAlertRules = notifier.notifyAlertRules.bind(notifier);

  const item = makeItem({ sourceId: 'elgiganten-outlet', listingKey: 'k2' });
  // Fail the delivery deliberately: we only care that the rule *matched* and
  // tried, not that Discord accepted it.
  const original = globalThis.fetch;
  globalThis.fetch = async () => { attempted++; return { ok: true, status: 204, text: async () => '' }; };
  try {
    await notifier.notifyAlertRules({
      newItems: [item],
      priceDrops: [],
      state,
      alertRules: [{
        id: 'r1', label: 'Iphone', enabled: true,
        keywords: ['iphone'], categories: [], webhooks: [OTHER_WEBHOOK],
        filteredSources: [], sourceFilterMode: 'exclude'
      }]
    });
  } finally {
    globalThis.fetch = original;
  }

  assert.ok(attempted > 0, 'a non-hotlist item must still be delivered by rules');
});

test('hotlist price drops are filtered out of alert rules too', async () => {
  const { notifier } = makeNotifier();
  const state = {
    items: { k1: makeItem() },
    notifications: {}
  };

  const summary = await notifier.notifyAlertRules({
    newItems: [],
    priceDrops: [{ listingKey: 'k1', dropPercent: 30, sourceId: HOTLIST_SOURCE }],
    state,
    alertRules: [{
      id: 'r1', label: 'Iphone', enabled: true,
      keywords: ['iphone'], categories: [], webhooks: [OTHER_WEBHOOK],
      filteredSources: [], sourceFilterMode: 'exclude', notifyPriceDrops: true
    }]
  });

  assert.equal(summary.sent, 0);
});

test('hotlist refuses to send without its own webhook', async () => {
  const { notifier } = makeNotifier();
  const state = { items: {}, notifications: {} };

  const summary = await notifier.notifyHotlist({
    newItems: [makeItem()],
    state,
    webhookUrl: ''
  });

  assert.equal(summary.reason, 'no-webhook');
  assert.equal(summary.sent, 0);
  assert.equal(summary.skipped, 1, 'the find is reported as skipped, not silently dropped');
});

test('a legacy hotlist-scoped alert rule hands its webhook to the hotlist', () => {
  // Before the split, the only way to route hotlist finds was a rule scoped to
  // the hotlist source. Dropping it would have silently killed working alerts.
  const preferences = {
    hotlist: normalizeHotlistConfig({ groups: [] }),
    notificationSettings: {
      alertRules: [{
        id: 'r-ssd',
        label: 'Hotlist - Intern SSD',
        filteredSources: [HOTLIST_SOURCE],
        sourceFilterMode: 'include',
        webhooks: [WEBHOOK]
      }]
    }
  };

  ensureHotlistConfig(preferences, { id: HOTLIST_SOURCE });
  assert.equal(preferences.hotlist.webhookUrl, WEBHOOK);
});

test('an explicit hotlist webhook is not overwritten by a legacy rule', () => {
  const preferences = {
    hotlist: normalizeHotlistConfig({ webhookUrl: WEBHOOK, groups: [] }),
    notificationSettings: {
      alertRules: [{
        id: 'r-ssd',
        filteredSources: [HOTLIST_SOURCE],
        sourceFilterMode: 'include',
        webhooks: [OTHER_WEBHOOK]
      }]
    }
  };

  ensureHotlistConfig(preferences, { id: HOTLIST_SOURCE });
  assert.equal(preferences.hotlist.webhookUrl, WEBHOOK, 'user choice wins');
});

test('a broadly-scoped rule is not treated as a hotlist rule', () => {
  const preferences = {
    hotlist: normalizeHotlistConfig({ groups: [] }),
    notificationSettings: {
      alertRules: [{
        id: 'r-gpu',
        // Includes the hotlist but also other sources — not a dedicated
        // hotlist route, so adopting its webhook would be wrong.
        filteredSources: [HOTLIST_SOURCE, 'elgiganten-outlet'],
        sourceFilterMode: 'include',
        webhooks: [OTHER_WEBHOOK]
      }]
    }
  };

  ensureHotlistConfig(preferences, { id: HOTLIST_SOURCE });
  assert.equal(preferences.hotlist.webhookUrl, '');
});
