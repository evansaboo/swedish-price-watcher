import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultState } from '../src/lib/store.js';
import { DiscordNotifier } from '../src/services/notifier.js';

const MAIN_WEBHOOK = 'https://discord.example/webhook';
const KW_WEBHOOK = 'https://discord.example/keywords';

function makeNotifier(opts = {}) {
  return new DiscordNotifier({ webhookUrl: MAIN_WEBHOOK, cooldownHours: 24, ...opts });
}

const BASE_ITEM = {
  listingKey: 'elgiganten-outlet:1000290',
  sourceId: 'elgiganten-outlet',
  sourceLabel: 'Elgiganten Outlet',
  title: 'DJI Osmo Mobile 8 outlet',
  url: 'https://www.elgiganten.se/product/1000290',
  category: 'Kamerahandtag',
  condition: 'outlet',
  latestPriceSek: 1949,
  referencePriceSek: 2490,
  availability: '25+',
  firstSeenAt: '2026-04-17T09:30:00.000Z',
  imageUrl: 'https://next-media.elkjop.com/image/1000290.jpg'
};

test('alert rule with no constraints sends a notification for any new item', async () => {
  const payloads = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return { ok: true, status: 204, statusText: 'No Content' };
  };

  try {
    const state = createDefaultState();
    const notifier = makeNotifier();
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [BASE_ITEM, { ...BASE_ITEM, listingKey: 'elgiganten-outlet:1000291', title: 'Sony WH-1000XM5 outlet', latestPriceSek: 2990, referencePriceSek: null }],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [
          { id: 'rule-any', label: 'All deals', enabled: true, keywords: [], categories: [], webhooks: [MAIN_WEBHOOK] }
        ]
      },
      state
    });

    assert.equal(summary.sent, 2);
    assert.equal(summary.failed, 0);
    assert.equal(payloads.length, 2);
    assert.match(payloads[0].content, /All deals/i);
    assert.ok(state.notifications['elgiganten-outlet:1000290:rule:rule-any']);
    assert.ok(state.notifications['elgiganten-outlet:1000291:rule:rule-any']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('alert rule with category filter only notifies matching category items', async () => {
  const payloads = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return { ok: true, status: 204, statusText: 'No Content' };
  };

  try {
    const state = createDefaultState();
    const notifier = makeNotifier();
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [
        { ...BASE_ITEM, listingKey: 'src:h1', title: 'Sony WH-1000XM5 outlet', category: 'Horlurar', latestPriceSek: 2790, referencePriceSek: 3990 },
        { ...BASE_ITEM, listingKey: 'src:h2', title: 'No-match item', category: 'Kamerahandtag', latestPriceSek: 999 }
      ],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [
          { id: 'rule-headphones', label: 'Headphones', enabled: true, keywords: [], categories: ['Horlurar'], webhooks: [MAIN_WEBHOOK] }
        ]
      },
      state
    });

    assert.equal(summary.sent, 1);
    assert.equal(payloads.length, 1);
    assert.match(payloads[0].embeds[0].title, /Sony/i);
    assert.ok(state.notifications['src:h1:rule:rule-headphones']);
    assert.equal(state.notifications['src:h2:rule:rule-headphones'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retries Discord webhook after 429 and still delivers notification', async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, _init) => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false, status: 429, statusText: 'Too Many Requests',
        headers: { get(name) { return name.toLowerCase() === 'retry-after' ? '0' : null; } }
      };
    }
    return {
      ok: true, status: 204, statusText: 'No Content',
      headers: { get() { return null; } }
    };
  };

  try {
    const state = createDefaultState();
    const notifier = makeNotifier({ webhookMaxRetries: 2 });
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [{ ...BASE_ITEM, listingKey: 'src:retry-1' }],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [{ id: 'rule-r', label: 'Retry test', enabled: true, keywords: [], categories: [], webhooks: [MAIN_WEBHOOK] }]
      },
      state
    });

    assert.equal(calls, 2);
    assert.equal(summary.sent, 1);
    assert.equal(summary.failed, 0);
    assert.ok(state.notifications['src:retry-1:rule:rule-r']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('alert rule with keyword filter only notifies matching items', async () => {
  const payloads = [];
  const urls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    urls.push(url);
    payloads.push(JSON.parse(init.body));
    return { ok: true, status: 204, statusText: 'No Content' };
  };

  try {
    const state = createDefaultState();
    const notifier = makeNotifier();
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [
        { ...BASE_ITEM, listingKey: 'wh:9001', title: 'NVIDIA RTX 5070 Ti outlet', category: 'Grafikkort', latestPriceSek: 7999, referencePriceSek: 10999 },
        { ...BASE_ITEM, listingKey: 'wh:9002', title: 'Sony WH-1000XM5 outlet', category: 'Horlurar', latestPriceSek: 2990, referencePriceSek: null }
      ],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [
          { id: 'rule-gpu', label: 'GPU Deals', enabled: true, keywords: ['RTX 5070'], categories: [], webhooks: [KW_WEBHOOK] }
        ]
      },
      state
    });

    assert.equal(summary.sent, 1, 'One keyword match sent');
    assert.equal(summary.failed, 0);
    assert.ok(urls.some((u) => u === KW_WEBHOOK), 'Posted to keyword webhook');
    const kwPayload = payloads.find((p) => /GPU Deals/i.test(p.content));
    assert.ok(kwPayload, 'Keyword alert payload found');
    assert.match(kwPayload.embeds[0].title, /RTX 5070/i);
    assert.ok(state.notifications['wh:9001:rule:rule-gpu'], 'Notification key stored');
    assert.equal(state.notifications['wh:9002:rule:rule-gpu'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Discord 429 does not fail whole notification summary', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false, status: 429, statusText: 'Too Many Requests',
    headers: { get(name) { return name.toLowerCase() === 'retry-after' ? '0' : null; } }
  });

  try {
    const state = createDefaultState();
    const notifier = makeNotifier({ webhookMaxRetries: 1 });
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [{ ...BASE_ITEM, listingKey: 'src:fail-1' }],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [{ id: 'rule-f', label: 'Fail test', enabled: true, keywords: [], categories: [], webhooks: [MAIN_WEBHOOK] }]
      },
      state
    });

    assert.equal(summary.sent, 0);
    assert.equal(summary.failed, 1);
    assert.ok(Array.isArray(summary.errors));
    assert.match(summary.errors[0], /429/i);
    assert.equal(state.notifications['src:fail-1:rule:rule-f'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('minDiscountPercent threshold skips items below the minimum discount', async () => {
  const payloads = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return { ok: true, status: 204, statusText: 'No Content' };
  };

  try {
    const state = createDefaultState();
    const notifier = makeNotifier();
    await notifier.notifyScan({
      deals: [],
      newItems: [
        // 50% off (1000 ref, 500 price) — should match ≥20%
        { ...BASE_ITEM, listingKey: 'src:big-discount', title: 'Big discount item', latestPriceSek: 500, referencePriceSek: 1000 },
        // 5% off — should NOT match ≥20%
        { ...BASE_ITEM, listingKey: 'src:tiny-discount', title: 'Tiny discount item', latestPriceSek: 950, referencePriceSek: 1000 }
      ],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [{ id: 'rule-discount', label: 'Min 20% off', enabled: true, keywords: [], categories: [], minDiscountPercent: 20, webhooks: [MAIN_WEBHOOK] }]
      },
      state
    });

    assert.equal(payloads.length, 1);
    assert.match(payloads[0].embeds[0].title, /Big discount/i);
    assert.ok(state.notifications['src:big-discount:rule:rule-discount']);
    assert.equal(state.notifications['src:tiny-discount:rule:rule-discount'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('disabled alert rule is skipped', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 204 }; };

  try {
    const state = createDefaultState();
    const notifier = makeNotifier();
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [{ ...BASE_ITEM }],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [{ id: 'rule-off', label: 'Off', enabled: false, keywords: [], categories: [], webhooks: [MAIN_WEBHOOK] }]
      },
      state
    });

    assert.equal(called, false, 'Should not post to Discord for disabled rule');
    assert.equal(summary.sent, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('notificationsEnabled false skips all rules', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 204 }; };

  try {
    const state = createDefaultState();
    const notifier = makeNotifier();
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [{ ...BASE_ITEM }],
      sources: [],
      notificationSettings: {
        notificationsEnabled: false,
        alertRules: [{ id: 'rule-skip', label: 'Skip', enabled: true, keywords: [], categories: [], webhooks: [MAIN_WEBHOOK] }]
      },
      state
    });

    assert.equal(called, false);
    assert.equal(summary.reason, 'notifications-disabled');
    assert.equal(summary.sent, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});



test('alert rule with both keywords AND categories requires both to match (AND logic)', async () => {
  const payloads = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return { ok: true, status: 204, statusText: 'No Content' };
  };

  try {
    const state = createDefaultState();
    const notifier = makeNotifier();
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [
        // matches keyword AND category → should notify
        { ...BASE_ITEM, listingKey: 'src:match', title: 'ASUS RTX 4070 Outlet OC 12GB', category: 'Grafikkort', latestPriceSek: 4999 },
        // matches category but NOT keyword → should NOT notify
        { ...BASE_ITEM, listingKey: 'src:cat-only', title: 'ASUS RX 7900 XTX Outlet', category: 'Grafikkort', latestPriceSek: 6999 },
        // matches keyword but NOT category → should NOT notify
        { ...BASE_ITEM, listingKey: 'src:kw-only', title: 'ASUS RTX 4070 Headset Bundle', category: 'Horlurar', latestPriceSek: 2999 }
      ],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [{ id: 'rule-and', label: 'GPU Alert', enabled: true, keywords: ['RTX 4070'], categories: ['Grafikkort'], webhooks: [MAIN_WEBHOOK] }]
      },
      state
    });

    assert.equal(summary.sent, 1, 'Only the item matching both keyword and category should be notified');
    assert.match(payloads[0].embeds[0].title, /RTX 4070/i);
    assert.ok(state.notifications['src:match:rule:rule-and'], 'Match stored');
    assert.equal(state.notifications['src:cat-only:rule:rule-and'], undefined, 'Category-only match must be skipped');
    assert.equal(state.notifications['src:kw-only:rule:rule-and'], undefined, 'Keyword-only match must be skipped');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('alert rule with categories does not match products with no category', async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 204 }; };

  try {
    const state = createDefaultState();
    const notifier = makeNotifier();
    await notifier.notifyScan({
      deals: [],
      newItems: [{ ...BASE_ITEM, listingKey: 'src:nocat', category: '', latestPriceSek: 999 }],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [{ id: 'rule-cat-guard', label: 'Cat guard', enabled: true, keywords: [], categories: ['Grafikkort'], webhooks: [MAIN_WEBHOOK] }]
      },
      state
    });

    assert.equal(called, false, 'Product with empty category must not match a category rule');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sourceFilterMode=exclude skips items from listed sources (backward compat with excludedSources)', async () => {
  const payloads = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return { ok: true, status: 204, statusText: 'No Content' };
  };

  try {
    const state = createDefaultState();
    const notifier = makeNotifier();
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [
        { ...BASE_ITEM, listingKey: 'elg:1', sourceId: 'elgiganten-outlet', title: 'Sony WH-1000XM5', latestPriceSek: 2490 },
        { ...BASE_ITEM, listingKey: 'wh:1', sourceId: 'webhallen-fyndware', title: 'Sony WH-1000XM5 fyndware', latestPriceSek: 2390 },
        { ...BASE_ITEM, listingKey: 'nn:1', sourceId: 'netonnet-outlet', title: 'Sony WH-1000XM5 outlet', latestPriceSek: 2590 }
      ],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [{
          id: 'rule-excl',
          label: 'Sony Headphones',
          enabled: true,
          keywords: ['Sony'],
          categories: [],
          // old excludedSources field — should be auto-migrated to exclude mode
          excludedSources: ['elgiganten-outlet', 'netonnet-outlet'],
          webhooks: [MAIN_WEBHOOK]
        }]
      },
      state
    });

    assert.equal(summary.sent, 1, 'Only the non-excluded source should notify');
    assert.match(payloads[0].embeds[0].title, /fyndware/i, 'Webhallen item notified');
    assert.ok(state.notifications['wh:1:rule:rule-excl'], 'Webhallen notification stored');
    assert.equal(state.notifications['elg:1:rule:rule-excl'], undefined, 'Elgiganten must be excluded');
    assert.equal(state.notifications['nn:1:rule:rule-excl'], undefined, 'NetOnNet must be excluded');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('alert rule fires on price drops meeting the minimum drop percent', async () => {
  const payloads = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return { ok: true, status: 204, statusText: 'No Content' };
  };

  try {
    const state = createDefaultState();
    state.items['src:drop-1'] = { ...BASE_ITEM, listingKey: 'src:drop-1', latestPriceSek: 1500 };
    state.items['src:drop-2'] = { ...BASE_ITEM, listingKey: 'src:drop-2', title: 'Tiny drop item', latestPriceSek: 1930 };

    const notifier = makeNotifier();
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [],
      priceDrops: [
        // 25% drop — should notify
        { listingKey: 'src:drop-1', sourceId: 'elgiganten-outlet', sourceLabel: 'Elgiganten Outlet', title: BASE_ITEM.title, url: BASE_ITEM.url, category: BASE_ITEM.category, condition: 'outlet', previousPriceSek: 2000, newPriceSek: 1500, dropSek: 500, dropPercent: 25, seenAt: '2026-06-12T08:00:00.000Z' },
        // 1% drop — below default 5% threshold
        { listingKey: 'src:drop-2', sourceId: 'elgiganten-outlet', sourceLabel: 'Elgiganten Outlet', title: 'Tiny drop item', url: BASE_ITEM.url, category: BASE_ITEM.category, condition: 'outlet', previousPriceSek: 1949, newPriceSek: 1930, dropSek: 19, dropPercent: 1, seenAt: '2026-06-12T08:00:00.000Z' }
      ],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [{ id: 'rule-drop', label: 'Drops', enabled: true, keywords: [], categories: [], webhooks: [MAIN_WEBHOOK] }]
      },
      state
    });

    assert.equal(summary.sent, 1, 'Only the ≥5% drop should notify');
    assert.match(payloads[0].content, /price drop/i);
    assert.match(payloads[0].embeds[0].fields[0].value, /2[\s ]?000/, 'Was-price shown');
    assert.ok(state.notifications['src:drop-1:rule:rule-drop:drop']);
    assert.equal(state.notifications['src:drop-2:rule:rule-drop:drop'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('price drop alerts respect notifyPriceDrops=false and rule constraints', async () => {
  const payloads = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return { ok: true, status: 204, statusText: 'No Content' };
  };

  try {
    const state = createDefaultState();
    state.items['src:drop-gpu'] = { ...BASE_ITEM, listingKey: 'src:drop-gpu', title: 'RTX 5070 Gaming OC', category: 'Grafikkort', latestPriceSek: 6999 };

    const drop = { listingKey: 'src:drop-gpu', sourceId: 'elgiganten-outlet', sourceLabel: 'Elgiganten Outlet', title: 'RTX 5070 Gaming OC', url: BASE_ITEM.url, category: 'Grafikkort', condition: 'outlet', previousPriceSek: 8999, newPriceSek: 6999, dropSek: 2000, dropPercent: 22, seenAt: '2026-06-12T08:00:00.000Z' };

    const notifier = makeNotifier();
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [],
      priceDrops: [drop],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [
          // disabled drops — must not fire
          { id: 'rule-no-drops', label: 'No drops', enabled: true, keywords: [], categories: [], notifyPriceDrops: false, webhooks: [MAIN_WEBHOOK] },
          // keyword mismatch — must not fire
          { id: 'rule-other-kw', label: 'Other', enabled: true, keywords: ['macbook'], categories: [], webhooks: [MAIN_WEBHOOK] },
          // keyword match — fires
          { id: 'rule-gpu-drop', label: 'GPU drops', enabled: true, keywords: ['rtx 5070'], categories: [], webhooks: [MAIN_WEBHOOK] }
        ]
      },
      state
    });

    assert.equal(summary.sent, 1);
    assert.equal(payloads.length, 1);
    assert.match(payloads[0].content, /GPU drops/i);
    assert.ok(state.notifications['src:drop-gpu:rule:rule-gpu-drop:drop']);
    assert.equal(state.notifications['src:drop-gpu:rule:rule-no-drops:drop'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('price drop alerts honour the cooldown per item and rule', async () => {
  const payloads = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return { ok: true, status: 204, statusText: 'No Content' };
  };

  try {
    const state = createDefaultState();
    state.items['src:drop-cd'] = { ...BASE_ITEM, listingKey: 'src:drop-cd', latestPriceSek: 1500 };
    // Sent 1 hour ago with a 24h cooldown — must be skipped
    state.notifications['src:drop-cd:rule:rule-cd:drop'] = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const notifier = makeNotifier();
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [],
      priceDrops: [
        { listingKey: 'src:drop-cd', sourceId: 'elgiganten-outlet', sourceLabel: 'Elgiganten Outlet', title: BASE_ITEM.title, url: BASE_ITEM.url, category: BASE_ITEM.category, condition: 'outlet', previousPriceSek: 2000, newPriceSek: 1500, dropSek: 500, dropPercent: 25, seenAt: '2026-06-12T08:00:00.000Z' }
      ],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [{ id: 'rule-cd', label: 'Cooldown', enabled: true, keywords: [], categories: [], webhooks: [MAIN_WEBHOOK] }]
      },
      state
    });

    assert.equal(summary.sent, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(payloads.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sourceFilterMode=include only notifies from listed sources', async () => {
  const payloads = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return { ok: true, status: 204, statusText: 'No Content' };
  };

  try {
    const state = createDefaultState();
    const notifier = makeNotifier();
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [
        { ...BASE_ITEM, listingKey: 'elg:1', sourceId: 'elgiganten-outlet', title: 'RTX 4070', latestPriceSek: 4500 },
        { ...BASE_ITEM, listingKey: 'wh:1', sourceId: 'webhallen-fyndware', title: 'RTX 4070 fyndware', latestPriceSek: 4400 },
        { ...BASE_ITEM, listingKey: 'nn:1', sourceId: 'netonnet-outlet', title: 'RTX 4070 outlet', latestPriceSek: 4600 }
      ],
      sources: [],
      notificationSettings: {
        notificationsEnabled: true,
        alertRules: [{
          id: 'rule-incl',
          label: 'GPU - Webhallen only',
          enabled: true,
          keywords: ['RTX'],
          categories: [],
          filteredSources: ['webhallen-fyndware'],
          sourceFilterMode: 'include',
          webhooks: [MAIN_WEBHOOK]
        }]
      },
      state
    });

    assert.equal(summary.sent, 1, 'Only the included source should notify');
    assert.match(payloads[0].embeds[0].title, /fyndware/i, 'Webhallen item notified');
    assert.ok(state.notifications['wh:1:rule:rule-incl'], 'Webhallen notification stored');
    assert.equal(state.notifications['elg:1:rule:rule-incl'], undefined, 'Elgiganten not in include list');
    assert.equal(state.notifications['nn:1:rule:rule-incl'], undefined, 'NetOnNet not in include list');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
