import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultState } from '../src/lib/store.js';
import { DiscordNotifier } from '../src/services/notifier.js';

test('batches new listing notifications for Discord', async () => {
  const payloads = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));

    return {
      ok: true,
      status: 204,
      statusText: 'No Content'
    };
  };

  try {
    const state = createDefaultState();
    const notifier = new DiscordNotifier({
      webhookUrl: 'https://discord.example/webhook',
      cooldownHours: 24
    });
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [
        {
          listingKey: 'elgiganten-outlet-latest:1000290',
          sourceId: 'elgiganten-outlet-latest',
          sourceLabel: 'Elgiganten outlet latest',
          title: 'DJI Osmo Mobile 8 outlet',
          url: 'https://www.elgiganten.se/product/1000290',
          category: 'Kamerahandtag',
          condition: 'outlet',
          latestPriceSek: 1949,
          referencePriceSek: 2490,
          marketValueSek: 2490,
          availability: '25+',
          firstSeenAt: '2026-04-17T09:30:00.000Z',
          imageUrl: 'https://next-media.elkjop.com/image/1000290.jpg'
        },
        {
          listingKey: 'elgiganten-outlet-latest:1000291',
          sourceId: 'elgiganten-outlet-latest',
          sourceLabel: 'Elgiganten outlet latest',
          title: 'Sony WH-1000XM5 outlet',
          url: 'https://www.elgiganten.se/product/1000291',
          category: 'Horlurar',
          condition: 'outlet',
          latestPriceSek: 2990,
          availability: '2 kvar',
          firstSeenAt: '2026-04-17T09:31:00.000Z',
          imageUrl: null
        }
      ],
      sources: [
        {
          id: 'elgiganten-outlet-latest',
          label: 'Elgiganten outlet latest',
          enabled: true,
          notificationMode: 'new-listings',
          notificationBatchSize: 5
        }
      ],
      state
    });

    assert.equal(summary.sent, 2);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.newListings.messages, 1);
    assert.equal(payloads.length, 1);
    assert.match(payloads[0].content, /2 new outlet listings/i);
    assert.equal(payloads[0].embeds.length, 2);
    assert.ok(payloads[0].embeds[0].fields.some((field) => field.name === 'Initial'));
    assert.ok(payloads[0].embeds[0].fields.some((field) => field.name === 'Discount %' && /%|n\/a/i.test(field.value)));
    assert.equal(payloads[0].embeds[0].fields.some((field) => field.name === 'Availability'), false);
    assert.ok(state.notifications['elgiganten-outlet-latest:1000290:new-listing']);
    assert.ok(state.notifications['elgiganten-outlet-latest:1000291:new-listing']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sends favorite-category alerts for new discounted items and price drops', async () => {
  const payloads = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));

    return {
      ok: true,
      status: 204,
      statusText: 'No Content'
    };
  };

  try {
    const state = createDefaultState();
    state.preferences.favoriteCategories = ['Horlurar'];

    const notifier = new DiscordNotifier({
      webhookUrl: 'https://discord.example/webhook',
      cooldownHours: 24
    });
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [
        {
          listingKey: 'elgiganten-outlet-latest:1000400',
          sourceId: 'elgiganten-outlet-latest',
          sourceLabel: 'Elgiganten outlet latest',
          title: 'Sony WH-1000XM5 outlet',
          url: 'https://www.elgiganten.se/product/outlet/1000400',
          category: 'Horlurar',
          condition: 'outlet',
          latestPriceSek: 2790,
          referencePriceSek: 3990,
          marketValueSek: 3990,
          availability: '2 kvar',
          firstSeenAt: '2026-04-17T09:31:00.000Z',
          imageUrl: null
        },
        {
          listingKey: 'elgiganten-outlet-latest:1000402',
          sourceId: 'elgiganten-outlet-latest',
          sourceLabel: 'Elgiganten outlet latest',
          title: 'Outlet item without catalog match',
          url: 'https://www.elgiganten.se/product/outlet/1000402',
          category: 'Horlurar',
          condition: 'outlet',
          latestPriceSek: 1790,
          referencePriceSek: null,
          marketValueSek: null,
          availability: '2 kvar',
          firstSeenAt: '2026-04-17T09:32:00.000Z',
          imageUrl: null
        }
      ],
      priceDrops: [
        {
          listingKey: 'elgiganten-outlet-latest:1000401',
          sourceId: 'elgiganten-outlet-latest',
          sourceLabel: 'Elgiganten outlet latest',
          title: 'Bose QC outlet',
          url: 'https://www.elgiganten.se/product/outlet/1000401',
          category: 'Horlurar',
          condition: 'outlet',
          previousPriceSek: 2490,
          newPriceSek: 2290,
          dropSek: 200,
          dropPercent: 8,
          seenAt: '2026-04-17T10:00:00.000Z'
        }
      ],
      sources: [
        {
          id: 'elgiganten-outlet-latest',
          label: 'Elgiganten outlet latest',
          enabled: true,
          notificationMode: 'favorite-events'
        }
      ],
      state
    });

    assert.equal(summary.favoriteCategoryEvents.sent, 3); // 2 new listings + 1 price drop
    assert.equal(summary.favoriteCategoryEvents.newListingEvents, 2); // both items included (with or without discount)
    assert.equal(summary.favoriteCategoryEvents.priceDropEvents, 1);
    assert.equal(summary.newListings.sent, 0);
    assert.equal(payloads.length, 3);
    assert.match(payloads[0].content, /favorite category/i);
    assert.match(payloads[1].content, /favorite category/i);
    assert.match(payloads[2].content, /price drop/i);
    assert.ok(state.notifications['elgiganten-outlet-latest:1000400:favorite-new:2790']);
    assert.ok(state.notifications['elgiganten-outlet-latest:1000402:favorite-new:1790']);
    assert.ok(state.notifications['elgiganten-outlet-latest:1000401:favorite-drop:2490:2290']);
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
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          get(name) {
            return name.toLowerCase() === 'retry-after' ? '0' : null;
          }
        }
      };
    }

    return {
      ok: true,
      status: 204,
      statusText: 'No Content',
      headers: {
        get() {
          return null;
        }
      }
    };
  };

  try {
    const state = createDefaultState();
    const notifier = new DiscordNotifier({
      webhookUrl: 'https://discord.example/webhook',
      cooldownHours: 24,
      webhookMaxRetries: 2
    });
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [
        {
          listingKey: 'elgiganten-outlet-latest:1000500',
          sourceId: 'elgiganten-outlet-latest',
          sourceLabel: 'Elgiganten outlet latest',
          title: 'Outlet retry test item',
          url: 'https://www.elgiganten.se/product/outlet/1000500',
          category: 'Horlurar',
          condition: 'outlet',
          latestPriceSek: 1490,
          referencePriceSek: 2490,
          marketValueSek: 2490,
          availability: '2 kvar',
          firstSeenAt: '2026-04-17T09:31:00.000Z',
          imageUrl: null
        }
      ],
      sources: [
        {
          id: 'elgiganten-outlet-latest',
          label: 'Elgiganten outlet latest',
          enabled: true,
          notificationMode: 'new-listings'
        }
      ],
      state
    });

    assert.equal(calls, 2);
    assert.equal(summary.newListings.sent, 1);
    assert.equal(summary.newListings.failed, 0);
    assert.equal(summary.failed, 0);
    assert.ok(state.notifications['elgiganten-outlet-latest:1000500:new-listing']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('notifyKeywordMatches sends alert when new item title matches an enabled keyword', async () => {
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
    const notifier = new DiscordNotifier({ webhookUrl: 'https://discord.example/main', cooldownHours: 24 });
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [
        {
          listingKey: 'webhallen:9001',
          sourceId: 'webhallen-fyndware',
          sourceLabel: 'Webhallen',
          title: 'NVIDIA RTX 5070 Ti outlet',
          url: 'https://webhallen.com/product/9001',
          category: 'Grafikkort',
          condition: 'outlet',
          latestPriceSek: 7999,
          referencePriceSek: 10999,
          firstSeenAt: '2026-04-19T12:00:00.000Z',
          imageUrl: null
        },
        {
          listingKey: 'webhallen:9002',
          sourceId: 'webhallen-fyndware',
          sourceLabel: 'Webhallen',
          title: 'Sony WH-1000XM5 outlet',
          url: 'https://webhallen.com/product/9002',
          category: 'Horlurar',
          condition: 'outlet',
          latestPriceSek: 2990,
          firstSeenAt: '2026-04-19T12:01:00.000Z',
          imageUrl: null
        }
      ],
      sources: [{ id: 'webhallen-fyndware', label: 'Webhallen', enabled: true }],
      state,
      notificationSettings: {
        keywordWebhook: 'https://discord.example/keywords',
        keywords: [
          { id: 'kw1', keyword: 'RTX 5070', enabled: true },
          { id: 'kw2', keyword: 'Xbox', enabled: true },   // no match
          { id: 'kw3', keyword: 'Sony', enabled: false }   // disabled, should not fire
        ],
        categoryWebhooks: []
      }
    });

    assert.equal(summary.keywordMatches.sent, 1, 'One keyword match sent');
    assert.equal(summary.keywordMatches.skipped, 0);
    assert.equal(summary.keywordMatches.failed, 0);

    // Keyword webhook URL used for the match
    assert.ok(urls.some((u) => u === 'https://discord.example/keywords'), 'Posted to keyword webhook');
    const kwPayload = payloads.find((p) => /keyword alert/i.test(p.content));
    assert.ok(kwPayload, 'Keyword alert payload found');
    assert.match(kwPayload.content, /RTX 5070/i);
    assert.ok(state.notifications['webhallen:9001:keyword:rtx 5070'], 'Notification key stored');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('notifyAmazingDeals routes to category webhook when pattern matches', async () => {
  const postUrls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, _init) => {
    postUrls.push(url);
    return { ok: true, status: 204, statusText: 'No Content' };
  };

  try {
    const state = createDefaultState();
    const notifier = new DiscordNotifier({ webhookUrl: 'https://discord.example/main', cooldownHours: 24 });

    await notifier.notifyAmazingDeals(
      [
        {
          listingKey: 'elgiganten:gpu1',
          sourceId: 'elgiganten-outlet',
          title: 'RTX 4080 Outlet',
          category: 'Grafikkort (GPU)',
          condition: 'outlet',
          currentPriceSek: 5999,
          comparisonPriceSek: 9999,
          discountPercent: 40,
          profitSek: 3000,
          score: 95,
          reasons: ['big-discount'],
          amazingDeal: true,
          imageUrl: null,
          url: 'https://elgiganten.se/...'
        }
      ],
      state,
      null, // allowedSourceIds
      [{ id: 'cw1', pattern: 'grafikkort', label: 'GPU', webhook: 'https://discord.example/gpu-channel' }]
    );

    assert.ok(postUrls.includes('https://discord.example/gpu-channel'), 'Routed to GPU category webhook');
    assert.ok(!postUrls.includes('https://discord.example/main'), 'Did not post to main webhook');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Discord 429 does not fail whole notification summary', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    headers: {
      get(name) {
        return name.toLowerCase() === 'retry-after' ? '0' : null;
      }
    }
  });

  try {
    const state = createDefaultState();
    const notifier = new DiscordNotifier({
      webhookUrl: 'https://discord.example/webhook',
      cooldownHours: 24,
      webhookMaxRetries: 1
    });
    const summary = await notifier.notifyScan({
      deals: [],
      newItems: [
        {
          listingKey: 'elgiganten-outlet-latest:1000600',
          sourceId: 'elgiganten-outlet-latest',
          sourceLabel: 'Elgiganten outlet latest',
          title: 'Outlet failure test item',
          url: 'https://www.elgiganten.se/product/outlet/1000600',
          category: 'Horlurar',
          condition: 'outlet',
          latestPriceSek: 1690,
          referencePriceSek: 2490,
          marketValueSek: 2490,
          availability: '2 kvar',
          firstSeenAt: '2026-04-17T09:31:00.000Z',
          imageUrl: null
        }
      ],
      sources: [
        {
          id: 'elgiganten-outlet-latest',
          label: 'Elgiganten outlet latest',
          enabled: true,
          notificationMode: 'new-listings'
        }
      ],
      state
    });

    assert.equal(summary.sent, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.newListings.failed, 1);
    assert.ok(Array.isArray(summary.errors));
    assert.match(summary.errors[0], /429/i);
    assert.equal(state.notifications['elgiganten-outlet-latest:1000600:new-listing'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
