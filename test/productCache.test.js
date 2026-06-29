import test from 'node:test';
import assert from 'node:assert/strict';

import { ProductCache } from '../src/services/productCache.js';
import { createDefaultState } from '../src/lib/store.js';

function makeState() {
  const state = createDefaultState();
  state.items = {
    'src-a:1': {
      listingKey: 'src-a:1', sourceId: 'src-a', sourceLabel: 'Store A', title: 'RTX 5070 Gaming',
      category: 'Grafikkort', condition: 'outlet', latestPriceSek: 7000, referencePriceSek: 10000,
      firstSeenAt: '2026-06-01T00:00:00.000Z', lastSeenAt: '2026-06-12T00:00:00.000Z', history: []
    },
    'src-a:2': {
      listingKey: 'src-a:2', sourceId: 'src-a', sourceLabel: 'Store A', title: 'Sony hörlurar',
      category: 'Ljud', condition: 'outlet', latestPriceSek: 1500,
      firstSeenAt: '2026-06-01T00:00:00.000Z', lastSeenAt: '2026-06-12T00:00:00.000Z', history: []
    },
    'src-b:3': {
      listingKey: 'src-b:3', sourceId: 'src-b', sourceLabel: 'Store B', title: 'MacBook Air',
      category: 'Datorer', condition: 'used', latestPriceSek: 9000, referencePriceSek: 12000,
      firstSeenAt: '2026-06-01T00:00:00.000Z', lastSeenAt: '2026-06-12T00:00:00.000Z', history: []
    }
  };
  return state;
}

function buildCache() {
  const cache = new ProductCache();
  cache.rebuild(makeState(), new Map());
  return cache;
}

const NO_FAVS = new Set();

test('query returns defaults for unparseable page/pageSize (NaN guard)', () => {
  const cache = buildCache();
  const result = cache.query({ page: NaN, pageSize: NaN }, NO_FAVS, null, new Set());
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 50);
  assert.equal(result.items.length, 3);
  assert.equal(result.totalPages, 1);
});

test('query filters by store and computes aggregates', () => {
  const cache = buildCache();
  const result = cache.query({ store: 'src-a' }, NO_FAVS, null, new Set());
  assert.equal(result.total, 2);
  assert.equal(result.aggregates.matched, 1, 'one src-a item has a reference price');
});

test('query on unknown category returns empty result shape', () => {
  const cache = buildCache();
  const result = cache.query({ category: 'does-not-exist' }, NO_FAVS, null, new Set());
  assert.equal(result.total, 0);
  assert.deepEqual(result.items, []);
  assert.equal(result.totalPages, 1);
});

test('exportRows returns the full filtered set without pagination', () => {
  const cache = buildCache();
  const rows = cache.exportRows({ sortBy: 'currentPriceSek', sortDir: 'asc' }, NO_FAVS, null, new Set());
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, 'Sony hörlurar', 'sorted by price ascending');
  assert.ok(Array.isArray(rows));
});

test('exportRows honours filters', () => {
  const cache = buildCache();
  const rows = cache.exportRows({ search: 'macbook' }, NO_FAVS, null, new Set());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].listingKey, 'src-b:3');
});

test('discount fields are computed from reference price', () => {
  const cache = buildCache();
  const rows = cache.exportRows({ search: 'rtx' }, NO_FAVS, null, new Set());
  assert.equal(rows[0].discountSek, 3000);
  assert.equal(rows[0].discountPercent, 30);
});

test('cross-store annotation marks cheapest store across matched products', () => {
  const state = createDefaultState();
  state.items = {
    'store-a:gpu': {
      listingKey: 'store-a:gpu', sourceId: 'store-a', sourceLabel: 'Store A', title: 'ASUS RTX 4070 Dual',
      category: 'Grafikkort', condition: 'outlet', latestPriceSek: 7000,
      manufacturerArticleNumber: 'DUAL-RTX4070-O12G',
      firstSeenAt: '2026-06-01T00:00:00.000Z', lastSeenAt: '2026-06-12T00:00:00.000Z', history: []
    },
    'store-b:gpu': {
      listingKey: 'store-b:gpu', sourceId: 'store-b', sourceLabel: 'Store B', title: 'RTX 4070 Dual OC-utgåva',
      category: 'Grafikkort', condition: 'outlet', latestPriceSek: 6500,
      manufacturerArticleNumber: 'DUAL-RTX4070-O12G',
      firstSeenAt: '2026-06-01T00:00:00.000Z', lastSeenAt: '2026-06-12T00:00:00.000Z', history: []
    },
    'store-a:solo': {
      listingKey: 'store-a:solo', sourceId: 'store-a', sourceLabel: 'Store A', title: 'Unik produkt',
      category: 'Ljud', condition: 'outlet', latestPriceSek: 999,
      firstSeenAt: '2026-06-01T00:00:00.000Z', lastSeenAt: '2026-06-12T00:00:00.000Z', history: []
    }
  };

  const cache = new ProductCache();
  cache.rebuild(state, new Map());

  const byKey = new Map(cache.products.map(p => [p.listingKey, p]));
  const a = byKey.get('store-a:gpu');
  const b = byKey.get('store-b:gpu');
  const solo = byKey.get('store-a:solo');

  assert.ok(a.crossStore, 'matched product gets crossStore info');
  assert.equal(a.crossStore.isCheapest, false);
  assert.equal(a.crossStore.bestPriceSek, 6500);
  assert.equal(a.crossStore.bestSourceLabel, 'Store B');
  assert.equal(b.crossStore.isCheapest, true);
  assert.equal(b.crossStore.stores, 2);
  assert.equal(solo.crossStore, undefined, 'unmatched product has no crossStore');
});

test('queryFlips values outlet items against Blocket used medians', () => {
  const state = createDefaultState();
  state.items = {
    'elg:1': {
      listingKey: 'elg:1', sourceId: 'elgiganten-outlet', sourceLabel: 'Elgiganten', title: 'ASUS TUF RTX 4070 Ti 12GB',
      category: 'Grafikkort', condition: 'outlet', latestPriceSek: 6000,
      firstSeenAt: '2026-06-01T00:00:00.000Z', lastSeenAt: '2026-06-12T00:00:00.000Z', history: []
    },
    'blo:1': {
      listingKey: 'blo:1', sourceId: 'blocket-electronics', sourceLabel: 'Blocket', title: 'RTX 4070 Ti Gigabyte',
      condition: 'used', latestPriceSek: 8500, history: []
    },
    'blo:2': {
      listingKey: 'blo:2', sourceId: 'blocket-electronics', sourceLabel: 'Blocket', title: 'MSI RTX 4070 Ti',
      condition: 'used', latestPriceSek: 9000, history: []
    },
    'blo:3': {
      listingKey: 'blo:3', sourceId: 'blocket-electronics', sourceLabel: 'Blocket', title: 'RTX 4070 Ti Ventus',
      condition: 'used', latestPriceSek: 9500, history: []
    }
  };

  const cache = new ProductCache({ minSampleCount: 3, flatFeeSek: 0, resaleAdjustFactor: 1 });
  cache.rebuild(state, new Map());

  const result = cache.queryFlips({});
  assert.equal(result.total, 1, 'one profitable flip');
  const flip = result.items[0];
  assert.equal(flip.listingKey, 'elg:1');
  assert.equal(flip.resaleMedianSek, 9000);
  assert.equal(flip.netProfitSek, 3000);
  assert.equal(flip.sampleCount, 3);
  assert.deepEqual(result.demandCategories, ['Graphics cards']);
  assert.equal(result.aggregates.bestProfitSek, 3000);
});

test('queryFlips honours demandCategory and minRoi filters', () => {
  const state = createDefaultState();
  state.items = {
    'elg:1': { listingKey: 'elg:1', sourceId: 's', sourceLabel: 'S', title: 'RTX 4070 Ti', condition: 'outlet', latestPriceSek: 6000, history: [] },
    'b1': { listingKey: 'b1', sourceId: 'blo', sourceLabel: 'Blocket', title: 'RTX 4070 Ti', condition: 'used', latestPriceSek: 8500, history: [] },
    'b2': { listingKey: 'b2', sourceId: 'blo', sourceLabel: 'Blocket', title: 'RTX 4070 Ti', condition: 'used', latestPriceSek: 9000, history: [] },
    'b3': { listingKey: 'b3', sourceId: 'blo', sourceLabel: 'Blocket', title: 'RTX 4070 Ti', condition: 'used', latestPriceSek: 9500, history: [] }
  };
  const cache = new ProductCache({ minSampleCount: 3 });
  cache.rebuild(state, new Map());

  assert.equal(cache.queryFlips({ demandCategory: 'Apple — iPhone' }).total, 0);
  assert.equal(cache.queryFlips({ demandCategory: 'Graphics cards' }).total, 1);
  assert.equal(cache.queryFlips({ minRoiPercent: 999 }).total, 0);
});
