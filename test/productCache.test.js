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
