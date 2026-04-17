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

    assert.equal(summary.favoriteCategoryEvents.sent, 2);
    assert.equal(summary.favoriteCategoryEvents.newListingEvents, 1);
    assert.equal(summary.favoriteCategoryEvents.priceDropEvents, 1);
    assert.equal(summary.newListings.sent, 0);
    assert.equal(payloads.length, 2);
    assert.match(payloads[0].content, /favorite category update/i);
    assert.match(payloads[1].content, /price drop/i);
    assert.ok(state.notifications['elgiganten-outlet-latest:1000400:favorite-new:2790']);
    assert.ok(state.notifications['elgiganten-outlet-latest:1000401:favorite-drop:2490:2290']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
