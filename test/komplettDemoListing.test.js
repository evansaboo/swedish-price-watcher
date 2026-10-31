import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../src/app.js';
import { SqliteStore, createDefaultState, reconcileStateWithSources } from '../src/lib/store.js';
import { mergeObservations } from '../src/services/dealEngine.js';
import { normalizeKomplettDemoConfig } from '../src/services/komplettDemoConfig.js';
import {
  KOMPLETT_DEMO_CONDITION_LABEL,
  KOMPLETT_DEMO_SOURCE_ID,
  KOMPLETT_DEMO_SOURCE_LABEL,
  komplettDemoRecordToObservation,
  listableKomplettDemoRecords,
  syncKomplettDemoListing
} from '../src/services/komplettDemoListing.js';
import { createKomplettDemoPoller } from '../src/services/komplettDemoPoller.js';
import { ProductCache } from '../src/services/productCache.js';
import { KOMPLETT_DEMO_SORT } from '../src/sources/komplett.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const silentLogger = { error() {}, warn() {}, log() {}, info() {} };

const GPU = '10072';
const MOBO = '10071';
const SOURCE = { id: KOMPLETT_DEMO_SOURCE_ID, label: KOMPLETT_DEMO_SOURCE_LABEL };

function record(id, overrides = {}) {
  return {
    id: String(id),
    title: `ASUS GeForce RTX 30${id} TUF OC -B-Grade`,
    url: `https://www.komplett.se/product/${id}/demovaror/datorutrustning/demo-grafikkort/x`,
    imageUrl: `https://www.komplett.se/product-media/b2c/en-us/${id}.jpg`,
    priceSek: 7224,
    basePriceSek: 7224,
    inStock: true,
    availabilityText: '1 st i lager (1-3 dagar leveranstid)',
    categoryId: GPU,
    firstSeenAt: '2026-10-31T20:28:56.553Z',
    lastSeenAt: '2026-10-31T22:22:30.700Z',
    seeded: true,
    missingSince: null,
    misses: 0,
    ...overrides
  };
}

function watcherState(records) {
  return { products: Object.fromEntries(records.map((r) => [r.id, r])) };
}

const cfg = (categories = [GPU, MOBO]) => normalizeKomplettDemoConfig({ enabled: true, categories });

function hotlistObservation(id, overrides = {}) {
  return {
    sourceId: 'elgiganten-hotlist',
    sourceLabel: 'Elgiganten Hotlist',
    externalId: String(id),
    title: `Gigabyte RTX 5070 Fyndvara ${id}`,
    url: `https://www.elgiganten.se/product/outlet/${id}`,
    category: 'Grafikkort',
    condition: 'outlet',
    conditionLabel: 'Fyndvara',
    priceSek: 5990,
    referencePriceSek: 7490,
    availability: 'in_stock',
    seenAt: '2026-10-31T22:00:00.000Z',
    ...overrides
  };
}

function rebuild(state) {
  const cache = new ProductCache();
  cache.rebuild(state, new Map([[KOMPLETT_DEMO_SOURCE_ID, KOMPLETT_DEMO_SOURCE_LABEL]]));
  return cache;
}

// ── Mapping ─────────────────────────────────────────────────────

test('a watcher record becomes a listing observation with source, category, price, stock, image and condition', () => {
  const obs = komplettDemoRecordToObservation(record(70), SOURCE);
  assert.equal(obs.sourceId, 'komplett-demo');
  assert.equal(obs.sourceLabel, 'Komplett demo');
  assert.equal(obs.externalId, '70');
  assert.equal(obs.category, 'Grafikkort');
  assert.equal(obs.priceSek, 7224);
  assert.equal(obs.availability, 'in_stock');
  assert.equal(obs.imageUrl, 'https://www.komplett.se/product-media/b2c/en-us/70.jpg');
  assert.equal(obs.condition, 'outlet');
  assert.equal(obs.conditionLabel, KOMPLETT_DEMO_CONDITION_LABEL);
  assert.match(obs.conditionLabel, /B-grade/);
  assert.equal(obs.url, record(70).url);
  assert.equal(obs.seenAt, record(70).lastSeenAt);

  assert.equal(komplettDemoRecordToObservation(record(71, { inStock: false }), SOURCE).availability, 'out_of_stock');
});

test('only listed, priced products of selected categories are listable', () => {
  const records = [
    record(1),
    record(2, { missingSince: '2026-10-31T23:00:00.000Z' }),
    record(3, { categoryId: '9104' }), // not selected
    record(4, { priceSek: null }),
    record(5, { categoryId: MOBO })
  ];
  assert.deepEqual(listableKomplettDemoRecords(watcherState(records), cfg()).map((r) => r.id), ['1', '5']);
});

// ── Listing integration ─────────────────────────────────────────

test('Komplett demo products join the listing next to hotlist items, searchable and filterable', async () => {
  const state = createDefaultState();
  mergeObservations(state, [hotlistObservation(1), hotlistObservation(2, { title: 'Samsung 990 PRO 2TB Fyndvara', category: 'Intern SSD' })]);

  const result = syncKomplettDemoListing({
    state,
    watcherState: watcherState([record(70), record(80, { title: 'MSI B850M Mortar -B-Grade', categoryId: MOBO, inStock: false })]),
    config: cfg(),
    source: SOURCE
  });
  assert.equal(result.listed, 2);
  assert.equal(result.newCount, 2);
  assert.deepEqual(result.newKeys.sort(), ['komplett-demo:70', 'komplett-demo:80']);
  assert.deepEqual(result.deletedKeys, []);

  const item = state.items['komplett-demo:70'];
  assert.equal(item.firstSeenAt, '2026-10-31T20:28:56.553Z', 'keeps the date the watcher first saw it');
  assert.equal(item.lastSeenAt, '2026-10-31T22:22:30.700Z');

  const productCache = rebuild(state);
  const app = await buildApp({
    config: { publicDir, sources: [{ id: KOMPLETT_DEMO_SOURCE_ID, label: KOMPLETT_DEMO_SOURCE_LABEL }] },
    store: { getState: () => state },
    productCache
  });

  const all = (await app.inject({ method: 'GET', url: '/api/outlet-products?pageSize=100' })).json();
  assert.equal(all.total, 4);
  assert.deepEqual([...new Set(all.items.map((p) => p.sourceId))].sort(), ['elgiganten-hotlist', 'komplett-demo']);

  const komplett = (await app.inject({ method: 'GET', url: '/api/outlet-products?store=komplett-demo' })).json();
  assert.equal(komplett.total, 2);
  const gpu = komplett.items.find((p) => p.listingKey === 'komplett-demo:70');
  assert.equal(gpu.sourceLabel, 'Komplett demo');
  assert.equal(gpu.category, 'Grafikkort');
  assert.equal(gpu.currentPriceSek, 7224);
  assert.equal(gpu.availability, 'in_stock');
  assert.equal(gpu.conditionLabel, 'B-grade / demo');
  assert.equal(gpu.imageUrl, record(70).imageUrl);
  assert.equal(gpu.url, record(70).url);
  assert.equal(komplett.items.find((p) => p.listingKey === 'komplett-demo:80').availability, 'out_of_stock');

  // Search reaches both stores; the category filter merges the two shops' GPUs.
  const search = (await app.inject({ method: 'GET', url: '/api/outlet-products?search=rtx' })).json();
  assert.deepEqual(search.items.map((p) => p.sourceId).sort(), ['elgiganten-hotlist', 'komplett-demo']);
  const gpus = (await app.inject({ method: 'GET', url: '/api/outlet-products?category=grafikkort' })).json();
  assert.equal(gpus.total, 2);
  const demoCondition = (await app.inject({ method: 'GET', url: '/api/outlet-products?campaign=b-grade%20%2F%20demo' })).json();
  assert.equal(demoCondition.total, 2);

  const stores = (await app.inject({ method: 'GET', url: '/api/outlet-sources' })).json();
  assert.deepEqual(stores.find((s) => s.id === 'komplett-demo'), { id: 'komplett-demo', label: 'Komplett demo', count: 2 });

  // Out of the main listing endpoints, the outbound redirect works too.
  const out = await app.inject({ method: 'GET', url: '/api/out/komplett-demo:70' });
  assert.equal(out.statusCode, 302);
  assert.equal(out.headers.location, record(70).url);

  await app.close();
});

test('gone and deselected products drop out of the listing; their history is archived', () => {
  const state = createDefaultState();
  syncKomplettDemoListing({
    state,
    watcherState: watcherState([record(1), record(2), record(3, { categoryId: MOBO })]),
    config: cfg(),
    source: SOURCE
  });
  // A later price change, so there is history worth keeping.
  syncKomplettDemoListing({
    state,
    watcherState: watcherState([record(1, { priceSek: 6999, lastSeenAt: '2026-11-01T08:00:00.000Z' }), record(2), record(3, { categoryId: MOBO })]),
    config: cfg(),
    source: SOURCE
  });
  assert.equal(state.items['komplett-demo:1'].latestPriceSek, 6999);
  assert.equal(state.items['komplett-demo:1'].history.length, 2);

  const result = syncKomplettDemoListing({
    state,
    watcherState: watcherState([
      record(1, { missingSince: '2026-11-01T09:00:00.000Z' }),
      record(2),
      record(3, { categoryId: MOBO })
    ]),
    config: cfg([GPU]), // motherboards deselected
    source: SOURCE,
    getItemHistory: () => [{ priceSek: 7224, seenAt: '2026-10-31T22:22:30.700Z' }]
  });

  assert.deepEqual(result.deletedKeys.sort(), ['komplett-demo:1', 'komplett-demo:3']);
  assert.deepEqual(Object.keys(state.items), ['komplett-demo:2']);
  assert.equal(state.itemHistory['komplett-demo:1'].history.length, 2, 'in-memory history archived');
  assert.equal(state.itemHistory['komplett-demo:3'].history.length, 1, 'persisted history archived when memory is empty');

  // If the watcher sees it again, it comes back with its history.
  syncKomplettDemoListing({ state, watcherState: watcherState([record(1), record(2)]), config: cfg(), source: SOURCE });
  assert.ok(state.items['komplett-demo:1']);
  assert.ok(state.items['komplett-demo:1'].history.length >= 2);
});

test('seeded products reach the listing without any Discord alert', async () => {
  const state = createDefaultState();
  const sent = [];
  const notifier = {
    async notifyKomplettDemo({ alerts }) {
      sent.push(...alerts);
      return { sent: alerts.length, failed: 0, skipped: 0, delivered: alerts.map(() => true) };
    }
  };
  const config = cfg([GPU]);
  const raw = (id) => ({
    materialNumber: String(id),
    name: `Demo GPU ${id} -B-Grade`,
    url: `/product/${id}/demovaror/datorutrustning/demo-grafikkort/demo-gpu-${id}`,
    price: { listPriceNumber: 4000 + id },
    stock: { availabilityStatus: 'Stocked', availabilityQuantity: '1', availabilityText: '1 st i lager' },
    productImages: [{ url: 'product-media/b2c/en-us', fileName: `${id}.jpg` }]
  });
  const pages = (ids) => ({
    run: { id: `run-${ids.join('-')}`, status: 'SUCCEEDED', usageTotalUsd: 0.0004 },
    pages: [{ categoryId: GPU, url: `https://www.komplett.se/category/${GPU}/x?sort=${KOMPLETT_DEMO_SORT}`, found: true, sort: KOMPLETT_DEMO_SORT, total: ids.length, products: ids.map(raw) }]
  });
  const responses = [pages([2, 1]), pages([3, 2, 1])];

  const poller = createKomplettDemoPoller({
    getConfig: () => config,
    notifier,
    fetchPages: async () => responses.shift(),
    fetchRunUsage: async () => null,
    logger: silentLogger,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    random: () => 0.5,
    // Same wiring as src/index.js.
    onStateChange: (ws) => syncKomplettDemoListing({ state, watcherState: ws, config, source: SOURCE })
  });

  await poller.pollNow();
  assert.equal(sent.length, 0, 'the seeding run is silent');
  assert.deepEqual(Object.keys(state.items).sort(), ['komplett-demo:1', 'komplett-demo:2']);

  await poller.pollNow();
  assert.deepEqual(sent.map((a) => a.product.id), ['3'], 'only the genuinely new product alerts, and only once');
  assert.equal(Object.keys(state.items).length, 3);
  poller.stop();
});

// ── Startup backfill ────────────────────────────────────────────

test('startup backfills the listing from the saved komplett-demo record', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kd-listing-'));
  const dbPath = path.join(dir, 'store.db');
  try {
    // Before the deploy: production has a seeded watcher record and items of
    // an archived source, but no komplett-demo rows in the listing yet.
    const before = new SqliteStore(dbPath);
    await before.load();
    mergeObservations(before.getState(), [hotlistObservation(1), hotlistObservation(9, { sourceId: 'netonnet-outlet', sourceLabel: 'NetOnNet' })]);
    await before.save();
    before.saveRecord('komplett-demo', watcherState([record(70), record(71), record(80, { categoryId: MOBO })]));

    // Startup, in src/index.js order.
    const store = new SqliteStore(dbPath);
    await store.load();
    reconcileStateWithSources(store.getState(), ['elgiganten-hotlist', 'komplett-demo']);
    const state = store.getState();
    const poller = createKomplettDemoPoller({
      getConfig: () => cfg(),
      persistence: { load: () => store.loadRecord('komplett-demo'), save: (v) => store.saveRecord('komplett-demo', v) },
      logger: silentLogger,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {}
    });
    const result = syncKomplettDemoListing({
      state,
      watcherState: poller.getState(),
      config: cfg(),
      source: SOURCE,
      getItemHistory: (key) => store.getItemHistory(key)
    });
    store.flushItems(result.changedKeys, result.deletedKeys);

    assert.equal(result.listed, 3);
    const cache = rebuild(state);
    assert.equal(cache.query({ store: 'komplett-demo' }).total, 3);
    assert.equal(cache.query({}).total, 4, 'hotlist + Komplett demo; the archived NetOnNet row stays hidden');

    // The backfill is persisted, and a second startup changes nothing.
    const again = new SqliteStore(dbPath);
    await again.load();
    reconcileStateWithSources(again.getState(), ['elgiganten-hotlist', 'komplett-demo']);
    assert.equal(Object.keys(again.getState().items).filter((k) => k.startsWith('komplett-demo:')).length, 3);
    const second = syncKomplettDemoListing({ state: again.getState(), watcherState: poller.getState(), config: cfg(), source: SOURCE });
    assert.equal(second.newCount, 0);
    assert.deepEqual(second.deletedKeys, []);
    poller.stop();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
