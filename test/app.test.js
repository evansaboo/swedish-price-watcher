import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../src/app.js';
import { createDefaultState } from '../src/lib/store.js';
import { ProductCache } from '../src/services/productCache.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

function buildTestCache(state) {
  const cache = new ProductCache();
  cache.rebuild(state);
  return cache;
}

test('returns simplified outlet products, filters and category stats', async () => {
  const state = createDefaultState();
  const now = Date.now();
  const hoursAgo = (h) => new Date(now - h * 3600_000).toISOString();
  state.items = {
    'elgiganten-outlet-latest:1000290': {
      listingKey: 'elgiganten-outlet-latest:1000290',
      sourceId: 'elgiganten-outlet-latest',
      sourceLabel: 'Elgiganten outlet latest',
      condition: 'outlet',
      category: 'Horlurar',
      title: 'Sony WH-1000XM5 outlet',
      url: 'https://www.elgiganten.se/product/outlet/1000290',
      latestPriceSek: 2790,
      referencePriceSek: 3990,
      marketValueSek: 3990,
      highestPriceSek: 3990,
      firstSeenAt: hoursAgo(1),
      lastSeenAt: '2026-04-17T10:00:00.000Z'
    },
    'elgiganten-outlet-latest:1000291': {
      listingKey: 'elgiganten-outlet-latest:1000291',
      sourceId: 'elgiganten-outlet-latest',
      sourceLabel: 'Elgiganten outlet latest',
      condition: 'outlet',
      category: 'TV',
      title: 'LG OLED C2 outlet',
      url: 'https://www.elgiganten.se/product/outlet/1000291',
      latestPriceSek: 9990,
      referencePriceSek: 12990,
      marketValueSek: 12990,
      highestPriceSek: 12990,
      firstSeenAt: hoursAgo(48),
      lastSeenAt: '2026-04-17T10:00:00.000Z'
    },
    'elgiganten-outlet-latest:1000292': {
      listingKey: 'elgiganten-outlet-latest:1000292',
      sourceId: 'elgiganten-outlet-latest',
      sourceLabel: 'Elgiganten outlet latest',
      condition: 'outlet',
      category: 'Horlurar',
      title: 'Outlet product without catalog match',
      url: 'https://www.elgiganten.se/product/outlet/1000292',
      latestPriceSek: 1490,
      referencePriceSek: null,
      marketValueSek: null,
      highestPriceSek: 1490,
      firstSeenAt: hoursAgo(48),
      lastSeenAt: '2026-04-17T10:00:00.000Z'
    }
  };
  // A stored favorite-category list from before 2026-10-31 is ignored.
  state.preferences.favoriteCategories = ['Horlurar'];

  const app = await buildApp({
    config: {
      publicDir,
      sources: []
    },
    store: {
      getState() {
        return state;
      },
      async save() {}
    },
    productCache: buildTestCache(state)
  });

  const productsResponse = await app.inject({
    method: 'GET',
    url: '/api/outlet-products?favoritesOnly=true'
  });
  const productsData = productsResponse.json();
  const products = productsData.items ?? productsData;

  assert.equal(productsResponse.statusCode, 200);
  assert.equal(products.length, 3, 'the retired favoritesOnly filter no longer narrows the list');
  assert.equal(products.some((product) => product.discountSek === 1200 && product.discountPercent === 30), true);

  const categoriesResponse = await app.inject({
    method: 'GET',
    url: '/api/outlet-categories'
  });
  const categories = categoriesResponse.json();

  const filteredResponse = await app.inject({
    method: 'GET',
    url: '/api/outlet-products?referenceOnly=true&minDiscountPercent=25&maxPriceSek=3000'
  });
  const newOnlyResponse = await app.inject({
    method: 'GET',
    url: '/api/outlet-products?newOnly=true'
  });

  assert.equal(categoriesResponse.statusCode, 200);
  assert.equal(categories.length, 2);
  assert.equal('favorite' in categories[0], false);
  assert.equal(filteredResponse.statusCode, 200);
  const filteredProducts = (filteredResponse.json().items ?? filteredResponse.json());
  assert.equal(filteredProducts.length, 1);
  assert.equal(filteredProducts[0].listingKey, 'elgiganten-outlet-latest:1000290');
  assert.equal(newOnlyResponse.statusCode, 200);
  const newOnlyProducts = (newOnlyResponse.json().items ?? newOnlyResponse.json());
  assert.equal(newOnlyProducts.length, 1);
  assert.equal(newOnlyProducts[0].listingKey, 'elgiganten-outlet-latest:1000290');

  await app.close();
});

test('the retired scan, scheduler, digest, source and favorites routes are gone', async () => {
  const state = createDefaultState();
  state.items['elgiganten-hotlist:1'] = {
    listingKey: 'elgiganten-hotlist:1', sourceId: 'elgiganten-hotlist', condition: 'outlet',
    title: 'x', url: 'https://www.elgiganten.se/product/1', latestPriceSek: 100
  };
  const app = await buildApp({
    config: { publicDir, sources: [] },
    store: { getState: () => state, async save() {}, async savePreferences() {} },
    productCache: buildTestCache(state)
  });

  const gone = [
    ['POST', '/api/run'],
    ['POST', '/api/cancel'],
    ['GET', '/api/scheduler'],
    ['PUT', '/api/scheduler'],
    ['GET', '/api/sources'],
    ['PATCH', '/api/sources/netonnet-outlet'],
    ['GET', '/api/notification-settings'],
    ['PUT', '/api/notification-settings'],
    ['GET', '/api/preferences'],
    ['PUT', '/api/preferences/favorite-categories'],
    ['PUT', '/api/wishlist/elgiganten-hotlist:1/target'],
    ['GET', '/api/hotlist/amazon-suggestions?q=rtx']
  ];
  for (const [method, url] of gone) {
    const response = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
    assert.equal(response.statusCode, 404, `${method} ${url} should be gone`);
  }

  // The wishlist bookmark itself stays (it never alerted on its own).
  const added = await app.inject({ method: 'POST', url: '/api/wishlist/elgiganten-hotlist:1' });
  assert.equal(added.statusCode, 200);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/wishlist' })).json(), { items: ['elgiganten-hotlist:1'] });

  await app.close();
});

test('/health, /api/version and /api/status still answer', async () => {
  const state = createDefaultState();
  const app = await buildApp({
    config: { publicDir, sources: [] },
    store: { getState: () => state },
    productCache: buildTestCache(state)
  });

  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().ok, true);
  assert.ok('sha' in health.json());

  assert.equal((await app.inject({ method: 'GET', url: '/api/version' })).statusCode, 200);

  const status = await app.inject({ method: 'GET', url: '/api/status' });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(Object.keys(status.json().counts).sort(), ['deals', 'listedProducts', 'trackedItems']);
  assert.equal('scheduler' in status.json(), false);

  await app.close();
});

test('a malformed hotlist webhook is rejected instead of silently clearing it', async () => {
  // Normalising an unrecognised URL to '' switches hotlist notifications off
  // while the UI shows an empty field and no explanation. A typo in a pasted
  // webhook must be an error. (Hit for real: a bad PUT wiped a live webhook.)
  const state = createDefaultState();
  let config = {
    enabled: true, intervalSeconds: 60, jitterPct: 20, minDiscountPct: 10,
    hitsPerGroup: 100, notifyPriceDrops: true,
    webhookUrl: 'https://discord.com/api/webhooks/1/original',
    groups: []
  };

  const app = await buildApp({
    config: { publicDir, sources: [] },
    store: { getState: () => state },
    productCache: buildTestCache(state),
    hotlist: {
      getConfig: () => config,
      getStatus: () => ({}),
      update: async (next) => { config = next; return next; }
    }
  });

  const rejected = await app.inject({
    method: 'PUT',
    url: '/api/hotlist',
    payload: { webhookUrl: 'https://evil.example.com/hook' }
  });

  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.json().message, /discord\.com\/api\/webhooks/);
  assert.equal(config.webhookUrl, 'https://discord.com/api/webhooks/1/original', 'existing webhook untouched');

  // Clearing it deliberately must still work.
  const cleared = await app.inject({
    method: 'PUT',
    url: '/api/hotlist',
    payload: { webhookUrl: '' }
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().config.webhookUrl, '');

  await app.close();
});
