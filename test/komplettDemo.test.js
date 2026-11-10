import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KOMPLETT_DEMO_PAGE_FUNCTION,
  KOMPLETT_DEMO_SORT,
  buildKomplettDemoUrl,
  fetchKomplettDemoPages,
  isKomplettInStock,
  mapKomplettDemoProduct,
  resolveKomplettApifyToken,
} from '../src/sources/komplett.js';
import {
  DEFAULT_KOMPLETT_DEMO_CONFIG,
  KOMPLETT_DEMO_CATALOG,
  findUnknownCategoryIds,
  getKomplettDemoCategory,
  isMaskedWebhookUrl,
  maskWebhookUrl,
  normalizeKomplettDemoConfig,
  publicKomplettDemoConfig,
} from '../src/services/komplettDemoConfig.js';
import {
  MAX_BACKOFF_MS,
  MIN_DELAY_MS,
  applyKomplettDemoPages,
  computeCostGuard,
  computeNextDelayMs,
  createEmptyKomplettDemoState,
  createKomplettDemoPoller,
  estimateRunUsd,
} from '../src/services/komplettDemoPoller.js';
import { DiscordNotifier } from '../src/services/notifier.js';
import { SqliteStore, createDefaultState } from '../src/lib/store.js';
import { buildApp } from '../src/app.js';
import { ProductCache } from '../src/services/productCache.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const silentLogger = { error() {}, warn() {}, log() {}, info() {} };

const HEADSET = '9104';
const MICE = '9102';
const GPU = '10072';

function rawProduct(id, overrides = {}) {
  return {
    materialNumber: String(id),
    name: `Demo product ${id} -B-Grade`,
    url: `/product/${id}/demovaror/datorutrustning/demo-headset/demo-product-${id}`,
    manufacturerPartNumber: `MPN${id}`,
    description: 'A demo product',
    price: { listPriceNumber: 1000 },
    stock: { availabilityStatus: 'Stocked', availabilityQuantity: '1', availabilityText: '1 st i lager' },
    productImages: [{ url: 'product-media/b2c/en-us', fileName: `${id}.jpg` }],
    ...overrides,
  };
}

function page(categoryId, products, extra = {}) {
  return {
    categoryId,
    url: `https://www.komplett.se/category/${categoryId}/demovaror/x/y?sort=${KOMPLETT_DEMO_SORT}`,
    found: true,
    sort: KOMPLETT_DEMO_SORT,
    total: products.length,
    products,
    ...extra,
  };
}

function config(overrides = {}) {
  return normalizeKomplettDemoConfig({ enabled: true, categories: [HEADSET], ...overrides });
}

// ── Mapping and URLs ───────────────────────────────────────────

test('mapKomplettDemoProduct maps the embedded listing JSON', () => {
  const mapped = mapKomplettDemoProduct({
    materialNumber: '1345640',
    name: 'JBL LIVE 680NC Trådlösa on-ear hörlurar (sand) -B-Grade',
    url: '/product/1345640/demovaror/datorutrustning/demo-headset/jbl-live-680nc',
    manufacturerPartNumber: 'JBLLIVE680NCCPG',
    price: { listPriceNumber: 1031.6 },
    stock: { availabilityStatus: 'Stocked', availabilityQuantity: '1', availabilityText: '1 st i lager (1-3 dagar leveranstid)' },
    productImages: [{ url: 'product-media/b2c/en-us', fileName: '1345640.jpg' }],
  }, HEADSET);

  assert.equal(mapped.id, '1345640');
  assert.equal(mapped.url, 'https://www.komplett.se/product/1345640/demovaror/datorutrustning/demo-headset/jbl-live-680nc');
  assert.equal(mapped.imageUrl, 'https://www.komplett.se/img/p/400/1345640.jpg');
  assert.equal(mapped.priceSek, 1032);
  assert.equal(mapped.inStock, true);
  assert.equal(mapped.availabilityText, '1 st i lager (1-3 dagar leveranstid)');
  assert.equal(mapped.categoryId, HEADSET);
  assert.ok(!/b-?grade/i.test(mapped.productKey));

  assert.equal(mapKomplettDemoProduct({ name: 'no id', url: '/product/1' }), null);
  assert.equal(mapKomplettDemoProduct({ materialNumber: '1', url: '/product/1' }), null);
  assert.equal(mapKomplettDemoProduct({ materialNumber: '1', name: 'x', url: '/p/1', price: {} }).priceSek, null);
});

test('isKomplettInStock reads status and quantity', () => {
  assert.equal(isKomplettInStock({ availabilityStatus: 'Stocked', availabilityQuantity: '1' }), true);
  assert.equal(isKomplettInStock({ availabilityStatus: 'Stocked' }), true);
  assert.equal(isKomplettInStock({ availabilityStatus: 'NotStocked', availabilityQuantity: '0' }), false);
  assert.equal(isKomplettInStock({ availabilityStatus: 'Incoming', availabilityQuantity: '3' }), true);
  assert.equal(isKomplettInStock(null), false);
});

test('buildKomplettDemoUrl builds the newest-first listing URL', () => {
  const category = getKomplettDemoCategory(HEADSET);
  assert.equal(
    buildKomplettDemoUrl(category),
    'https://www.komplett.se/category/9104/demovaror/datorutrustning/demo-headset?sort=ReleaseDateDesc',
  );
  assert.equal(
    buildKomplettDemoUrl(getKomplettDemoCategory('12423')),
    'https://www.komplett.se/category/12423/demovaror/datorer/komplett-pc?sort=ReleaseDateDesc',
  );
});

test('fetchKomplettDemoPages makes one actor run with one start URL per category', async () => {
  const calls = [];
  class StubClient {
    constructor({ token }) { this.token = token; }
    actor(name) {
      return {
        call: async (input, options) => {
          calls.push({ name, input, options, token: this.token });
          return { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1', usageTotalUsd: 0.0004, stats: { runTimeSecs: 5 } };
        },
      };
    }
    dataset(id) {
      assert.equal(id, 'ds-1');
      return { listItems: async () => ({ items: [page(HEADSET, [rawProduct(1)])] }) };
    }
  }

  const categories = [getKomplettDemoCategory(HEADSET), getKomplettDemoCategory(MICE)];
  const result = await fetchKomplettDemoPages({ categories, token: 't', ApifyClientClass: StubClient });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'apify/cheerio-scraper');
  assert.deepEqual(calls[0].input.proxyConfiguration, { useApifyProxy: true });
  assert.equal(calls[0].input.pageFunction, KOMPLETT_DEMO_PAGE_FUNCTION);
  assert.deepEqual(calls[0].input.startUrls.map((u) => u.userData.categoryId), [HEADSET, MICE]);
  assert.ok(calls[0].input.startUrls.every((u) => u.url.includes('sort=ReleaseDateDesc')));
  assert.equal(calls[0].options.memory, 256);
  assert.equal(result.run.usageTotalUsd, 0.0004);
  assert.equal(result.pages.length, 1);

  await assert.rejects(() => fetchKomplettDemoPages({ categories: [], token: 't', ApifyClientClass: StubClient }), /No Komplett demo categories/);
  await assert.rejects(() => fetchKomplettDemoPages({ categories, token: '', ApifyClientClass: StubClient }), /No Apify token/);
});

test('resolveKomplettApifyToken prioritizes APIFY_TOKEN_KOMPLETT over APIFY_TOKEN', () => {
  const origKomplett = process.env.APIFY_TOKEN_KOMPLETT;
  const origDefault = process.env.APIFY_TOKEN;
  try {
    delete process.env.APIFY_TOKEN_KOMPLETT;
    delete process.env.APIFY_TOKEN;
    assert.equal(resolveKomplettApifyToken(), '');

    process.env.APIFY_TOKEN = 'fallback-token';
    assert.equal(resolveKomplettApifyToken(), 'fallback-token');

    process.env.APIFY_TOKEN_KOMPLETT = 'komplett-token';
    assert.equal(resolveKomplettApifyToken(), 'komplett-token');
  } finally {
    if (origKomplett !== undefined) process.env.APIFY_TOKEN_KOMPLETT = origKomplett;
    else delete process.env.APIFY_TOKEN_KOMPLETT;
    if (origDefault !== undefined) process.env.APIFY_TOKEN = origDefault;
    else delete process.env.APIFY_TOKEN;
  }
});

test('the page function extracts a compact product list and the applied sort', async () => {
  const html = `<html><head><title>Demo headset | Komplett.se</title></head><body><script>
    {"products":[{"materialNumber":"2","name":"B","url":"/product/2/x","price":{"listPriceNumber":10,"listPrice":"10:-"},"stock":{"availabilityStatus":"Stocked","availabilityQuantity":"1","availabilityText":"1 st","stockIconColor":"green"},"productImages":[{"url":"u","fileName":"2.jpg","width":1},{"url":"u","fileName":"2_1.jpg"}],"energyLogo":{"a":[1]}}],
     "rangeFacets":[],"queryParameters":[{"key":"sort","value":"ReleaseDateDesc"}],"totalNumberOfResultsMatchingQuery":61,"numberOfResults":24,"pageNumber":0,"maxPageCount":3,"pageSize":24,"queryId":"q","sort":"ReleaseDateDesc"}
  </script></body></html>`;
  // eslint-disable-next-line no-new-func
  const pageFunction = new Function(`${KOMPLETT_DEMO_PAGE_FUNCTION}; return pageFunction;`)();
  const out = await pageFunction({
    body: html,
    request: { url: 'https://x/category/9104/a', userData: { categoryId: HEADSET } },
    response: { statusCode: 200 },
    $: () => ({ first: () => ({ text: () => 'Demo headset' }) }),
  });
  assert.equal(out.found, true);
  assert.equal(out.categoryId, HEADSET);
  assert.equal(out.sort, 'ReleaseDateDesc');
  assert.equal(out.total, 61);
  assert.equal(out.numberOfResults, 24);
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].productImages.length, 1);
  assert.equal(out.products[0].energyLogo, undefined);
  assert.equal(out.products[0].price.listPriceNumber, 10);

  const blocked = await pageFunction({
    body: '<html><title>Access Denied</title></html>',
    request: { url: 'https://x', userData: { categoryId: HEADSET } },
    response: { statusCode: 200 },
    $: () => ({ first: () => ({ text: () => 'Access Denied' }) }),
  });
  assert.equal(blocked.found, false);
  assert.equal(blocked.title, 'Access Denied');
});

// ── Diffing: seeding, alerts, dedupe ───────────────────────────

test('the first look at a category records it silently', () => {
  const state = createEmptyKomplettDemoState();
  const products = Array.from({ length: 24 }, (_, i) => rawProduct(2000 - i));
  const result = applyKomplettDemoPages({ state, pages: [page(HEADSET, products)], config: config(), nowIso: '2026-10-31T10:00:00.000Z' });

  assert.equal(result.alerts.length, 0);
  assert.equal(result.newCount, 24);
  assert.equal(Object.keys(state.products).length, 24);
  assert.ok(state.seededCategories[HEADSET]);
  assert.ok(Object.values(state.products).every((p) => p.seeded));
});

test('a product never seen before in a watched category alerts', () => {
  const state = createEmptyKomplettDemoState();
  applyKomplettDemoPages({ state, pages: [page(HEADSET, [rawProduct(100), rawProduct(99)])], config: config(), nowIso: '2026-10-31T10:00:00.000Z' });
  const result = applyKomplettDemoPages({
    state,
    pages: [page(HEADSET, [rawProduct(101, { price: { listPriceNumber: 1499 } }), rawProduct(100), rawProduct(99)])],
    config: config(),
    nowIso: '2026-10-31T10:10:00.000Z',
  });

  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].reason, 'new');
  assert.equal(result.alerts[0].product.id, '101');
  assert.equal(result.alerts[0].product.priceSek, 1499);
  assert.equal(result.alerts[0].categoryId, HEADSET);
  assert.equal(state.products['101'].seeded, false);
});

test('a newly selected category seeds silently while seeded ones keep alerting', () => {
  const state = createEmptyKomplettDemoState();
  applyKomplettDemoPages({ state, pages: [page(HEADSET, [rawProduct(100)])], config: config(), nowIso: '2026-10-31T10:00:00.000Z' });
  const result = applyKomplettDemoPages({
    state,
    pages: [page(HEADSET, [rawProduct(101), rawProduct(100)]), page(MICE, [rawProduct(500), rawProduct(499)])],
    config: config({ categories: [HEADSET, MICE] }),
    nowIso: '2026-10-31T10:10:00.000Z',
  });
  assert.deepEqual(result.alerts.map((a) => a.product.id), ['101']);
  assert.ok(state.seededCategories[MICE]);

  // Deselecting forgets the seed, so re-selecting seeds silently again.
  applyKomplettDemoPages({ state, pages: [page(HEADSET, [rawProduct(101)])], config: config(), nowIso: '2026-10-31T10:20:00.000Z' });
  assert.equal(state.seededCategories[MICE], undefined);
  const reselected = applyKomplettDemoPages({
    state,
    pages: [page(HEADSET, [rawProduct(101)]), page(MICE, [rawProduct(501), rawProduct(500)])],
    config: config({ categories: [HEADSET, MICE] }),
    nowIso: '2026-10-31T10:30:00.000Z',
  });
  assert.equal(reselected.alerts.length, 0);
});

test('a product listed in two watched categories alerts once', () => {
  const state = createEmptyKomplettDemoState();
  const cfg = config({ categories: [HEADSET, MICE] });
  applyKomplettDemoPages({ state, pages: [page(HEADSET, [rawProduct(1)]), page(MICE, [rawProduct(2)])], config: cfg, nowIso: '2026-10-31T10:00:00.000Z' });
  const result = applyKomplettDemoPages({
    state,
    pages: [page(HEADSET, [rawProduct(3), rawProduct(1)]), page(MICE, [rawProduct(3), rawProduct(2)])],
    config: cfg,
    nowIso: '2026-10-31T10:10:00.000Z',
  });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.productCount, 3);
});

test('back in stock: explicit stock status and a sold unit reappearing', () => {
  const state = createEmptyKomplettDemoState();
  const cfg = config();
  const out = { availabilityStatus: 'NotStocked', availabilityQuantity: '0', availabilityText: 'Ej i lager' };
  applyKomplettDemoPages({ state, pages: [page(HEADSET, [rawProduct(10, { stock: out }), rawProduct(9)])], config: cfg, nowIso: '2026-10-31T10:00:00.000Z' });

  const back = applyKomplettDemoPages({ state, pages: [page(HEADSET, [rawProduct(10), rawProduct(9)])], config: cfg, nowIso: '2026-10-31T10:10:00.000Z' });
  assert.deepEqual(back.alerts.map((a) => [a.reason, a.product.id]), [['back-in-stock', '10']]);

  // Product 9 drops off a not-full page (sold). One miss isn't enough; two is.
  applyKomplettDemoPages({ state, pages: [page(HEADSET, [rawProduct(10)])], config: cfg, nowIso: '2026-10-31T10:20:00.000Z' });
  assert.equal(state.products['9'].missingSince, null);
  applyKomplettDemoPages({ state, pages: [page(HEADSET, [rawProduct(10)])], config: cfg, nowIso: '2026-10-31T10:30:00.000Z' });
  assert.equal(state.products['9'].missingSince, '2026-10-31T10:30:00.000Z');

  const reappeared = applyKomplettDemoPages({ state, pages: [page(HEADSET, [rawProduct(10), rawProduct(9)])], config: cfg, nowIso: '2026-10-31T10:40:00.000Z' });
  assert.deepEqual(reappeared.alerts.map((a) => [a.reason, a.product.id]), [['back-in-stock', '9']]);

  // Disabled by setting.
  const off = config({ notifyBackInStock: false });
  applyKomplettDemoPages({ state, pages: [page(HEADSET, [rawProduct(10, { stock: out }), rawProduct(9)])], config: off, nowIso: '2026-10-31T10:50:00.000Z' });
  const none = applyKomplettDemoPages({ state, pages: [page(HEADSET, [rawProduct(10), rawProduct(9)])], config: off, nowIso: '2026-10-31T11:00:00.000Z' });
  assert.equal(none.alerts.length, 0);
});

test('a product pushed off a full page by newer ones is not treated as sold', () => {
  const state = createEmptyKomplettDemoState();
  const cfg = config();
  const firstPage = Array.from({ length: 24 }, (_, i) => rawProduct(1000 - i));
  const full = { total: 61, numberOfResults: 24 };
  applyKomplettDemoPages({ state, pages: [page(HEADSET, firstPage, full)], config: cfg, nowIso: '2026-10-31T10:00:00.000Z' });
  // Two newer products push 977 and 978 off page 1.
  const shifted = [rawProduct(1002), rawProduct(1001), ...firstPage.slice(0, 22)];
  for (const nowIso of ['2026-10-31T10:10:00.000Z', '2026-10-31T10:20:00.000Z', '2026-10-31T10:30:00.000Z']) {
    applyKomplettDemoPages({ state, pages: [page(HEADSET, shifted, full)], config: cfg, nowIso });
  }
  assert.equal(state.products['977'].missingSince, null);
  assert.equal(state.products['978'].missingSince, null);

  // A product in the middle of the page vanishing is a sale.
  const sold = shifted.filter((p) => p.materialNumber !== '990');
  for (const nowIso of ['2026-10-31T10:40:00.000Z', '2026-10-31T10:50:00.000Z']) {
    applyKomplettDemoPages({ state, pages: [page(HEADSET, sold, { total: 60, numberOfResults: 23 })], config: cfg, nowIso });
  }
  assert.ok(state.products['990'].missingSince);
});

test('an empty or inconsistent page never marks products as sold', () => {
  // Seen live: Komplett reported "numberOfResults":1 but rendered "products":[].
  const state = createEmptyKomplettDemoState();
  const cfg = config();
  applyKomplettDemoPages({ state, pages: [page(HEADSET, [rawProduct(5), rawProduct(4)])], config: cfg, nowIso: '2026-10-31T10:00:00.000Z' });
  const glitches = [
    page(HEADSET, [], { total: 2, numberOfResults: 2 }),
    page(HEADSET, [rawProduct(5)], { total: 2, numberOfResults: 2 }),
  ];
  let last;
  for (const [i, glitch] of [...glitches, ...glitches].entries()) {
    last = applyKomplettDemoPages({ state, pages: [glitch], config: cfg, nowIso: `2026-10-31T11:0${i}:00.000Z` });
  }
  assert.equal(state.products['4'].missingSince, null);
  assert.ok(last.warnings.some((w) => /lists 2 product\(s\) but only rendered 1/.test(w)));
  const back = applyKomplettDemoPages({ state, pages: [page(HEADSET, [rawProduct(5), rawProduct(4)])], config: cfg, nowIso: '2026-10-31T12:00:00.000Z' });
  assert.equal(back.alerts.length, 0);
});

test('price-drop alerts respect the threshold and are off at 0', () => {
  const at = (price) => [page(HEADSET, [rawProduct(10, { price: { listPriceNumber: price } })])];
  const state = createEmptyKomplettDemoState();
  const cfg = config({ notifyPriceDropPercent: 10 });
  applyKomplettDemoPages({ state, pages: at(1000), config: cfg, nowIso: '2026-10-31T10:00:00.000Z' });

  assert.equal(applyKomplettDemoPages({ state, pages: at(950), config: cfg, nowIso: '2026-10-31T10:10:00.000Z' }).alerts.length, 0);
  // Small drops accumulate against the baseline: 1000 → 950 → 900 is 10%.
  const drop = applyKomplettDemoPages({ state, pages: at(900), config: cfg, nowIso: '2026-10-31T10:20:00.000Z' });
  assert.equal(drop.alerts.length, 1);
  assert.equal(drop.alerts[0].reason, 'price-drop');
  assert.equal(drop.alerts[0].previousPriceSek, 1000);
  assert.equal(drop.alerts[0].dropPercent, 10);
  // The baseline moved to 900, so the same price doesn't re-alert.
  assert.equal(applyKomplettDemoPages({ state, pages: at(900), config: cfg, nowIso: '2026-10-31T10:30:00.000Z' }).alerts.length, 0);

  const offState = createEmptyKomplettDemoState();
  const off = config({ notifyPriceDropPercent: 0 });
  applyKomplettDemoPages({ state: offState, pages: at(1000), config: off, nowIso: '2026-10-31T10:00:00.000Z' });
  assert.equal(applyKomplettDemoPages({ state: offState, pages: at(100), config: off, nowIso: '2026-10-31T10:10:00.000Z' }).alerts.length, 0);
});

test('failed or blocked category pages are reported and not seeded', () => {
  const state = createEmptyKomplettDemoState();
  const result = applyKomplettDemoPages({
    state,
    pages: [page(HEADSET, [rawProduct(1)]), { categoryId: MICE, found: false, title: 'Access Denied', products: [] }],
    config: config({ categories: [HEADSET, MICE, GPU] }),
    nowIso: '2026-10-31T10:00:00.000Z',
  });
  assert.deepEqual(result.okCategories, [HEADSET]);
  assert.deepEqual(result.failedCategories.sort(), [GPU, MICE].sort());
  assert.equal(state.seededCategories[MICE], undefined);
  assert.match(state.categoryStats[MICE].lastError, /Access Denied/);
  assert.match(state.categoryStats[GPU].lastError, /not fetched/);
  assert.ok(result.warnings.some((w) => /2 categories failed/.test(w)));
});

// ── Timing and cost guard ──────────────────────────────────────

test('delays stay within the jitter, floor and backoff bounds', () => {
  const cfg = config({ intervalMinutes: 10, jitterPct: 40 });
  const min = computeNextDelayMs({ config: cfg, random: () => 0 });
  const max = computeNextDelayMs({ config: cfg, random: () => 1 });
  assert.equal(min, 6 * 60_000);
  assert.equal(max, 14 * 60_000);

  // The 30-second floor holds even with maximum negative jitter.
  const fast = config({ intervalMinutes: 0.5, jitterPct: 50 });
  assert.equal(computeNextDelayMs({ config: fast, random: () => 0 }), MIN_DELAY_MS);
  assert.equal(normalizeKomplettDemoConfig({ intervalMinutes: 0.1 }).intervalMinutes, 0.5);

  // Exponential backoff, capped at 60 minutes.
  const noJitter = config({ intervalMinutes: 10, jitterPct: 0 });
  assert.equal(computeNextDelayMs({ config: noJitter, consecutiveFailures: 1 }), 20 * 60_000);
  assert.equal(computeNextDelayMs({ config: noJitter, consecutiveFailures: 2 }), 40 * 60_000);
  assert.equal(computeNextDelayMs({ config: noJitter, consecutiveFailures: 3 }), MAX_BACKOFF_MS);
  assert.equal(computeNextDelayMs({ config: noJitter, consecutiveFailures: 20 }), MAX_BACKOFF_MS);
  assert.ok(computeNextDelayMs({ config: cfg, consecutiveFailures: 9, random: () => 1 }) <= MAX_BACKOFF_MS);

  // A cost-guard interval wins over the base interval.
  assert.equal(computeNextDelayMs({ config: noJitter, costGuardIntervalMs: 90 * 60_000 }), 90 * 60_000);
});

test('the cost guard stretches the interval to fit the monthly cap', () => {
  const nowMs = Date.UTC(2026, 9, 16, 0, 0, 0); // 16 days left in October
  const cheap = computeCostGuard({
    usage: { month: '2026-10', usd: 0.05, runs: 100, urls: 300 },
    config: config({ intervalMinutes: 10, maxMonthlyUsd: 4 }),
    urlCount: 3,
    nowMs,
  });
  assert.equal(cheap.stretched, false);
  assert.equal(cheap.intervalMs, 10 * 60_000);
  assert.ok(cheap.projectedMonthUsd < 4);

  const tight = computeCostGuard({
    usage: { month: '2026-10', usd: 3.5, runs: 4000, urls: 12000 },
    config: config({ intervalMinutes: 10, maxMonthlyUsd: 4 }),
    urlCount: 3,
    nowMs,
  });
  assert.equal(tight.stretched, true);
  assert.equal(tight.exhausted, false);
  assert.ok(tight.intervalMs > 10 * 60_000);
  assert.ok(tight.projectedMonthUsd <= 4.0001, `projected ${tight.projectedMonthUsd}`);

  const spent = computeCostGuard({
    usage: { month: '2026-10', usd: 4, runs: 4000, urls: 12000 },
    config: config({ maxMonthlyUsd: 4 }),
    urlCount: 3,
    nowMs,
  });
  assert.equal(spent.exhausted, true);

  // Last month's spend doesn't count.
  const rolled = computeCostGuard({
    usage: { month: '2026-09', usd: 10, runs: 1, urls: 1 },
    config: config({ maxMonthlyUsd: 4 }),
    urlCount: 3,
    nowMs,
  });
  assert.equal(rolled.spentUsd, 0);
  assert.equal(rolled.stretched, false);

  // Estimates calibrate to real runs once there are a few.
  assert.ok(estimateRunUsd({ runs: 10, urls: 30, usd: 0.02 }, 3) > estimateRunUsd({ runs: 0, urls: 0, usd: 0 }, 3));
});

// ── Config validation ──────────────────────────────────────────

test('config defaults, clamping and category validation', () => {
  const defaults = normalizeKomplettDemoConfig({});
  assert.deepEqual(defaults, { ...DEFAULT_KOMPLETT_DEMO_CONFIG, categories: [] });
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.intervalMinutes, 10);
  assert.equal(defaults.jitterPct, 40);
  assert.equal(defaults.notifyPriceDropPercent, 0);
  assert.equal(defaults.notifyBackInStock, true);
  assert.equal(defaults.maxMonthlyUsd, 4);

  const cfg = normalizeKomplettDemoConfig({
    enabled: 'yes',
    categories: [MICE, '99999', HEADSET, HEADSET, 'drop table'],
    intervalMinutes: 100000,
    jitterPct: -5,
    notifyPriceDropPercent: 150,
    maxMonthlyUsd: 'abc',
    discordWebhookUrl: 'https://evil.example.com/hook',
  });
  assert.deepEqual(cfg.categories, [HEADSET, MICE]); // catalog order, unknown dropped
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.intervalMinutes, 240);
  assert.equal(cfg.jitterPct, 0);
  assert.equal(cfg.notifyPriceDropPercent, 90);
  assert.equal(cfg.maxMonthlyUsd, 4);
  assert.equal(cfg.discordWebhookUrl, '');

  assert.deepEqual(findUnknownCategoryIds([HEADSET, '99999']), ['99999']);

  // Partial updates keep the rest of the current config.
  const current = normalizeKomplettDemoConfig({ enabled: true, categories: [GPU], intervalMinutes: 20 });
  const merged = normalizeKomplettDemoConfig({ jitterPct: 10 }, current);
  assert.deepEqual(merged.categories, [GPU]);
  assert.equal(merged.intervalMinutes, 20);
  assert.equal(merged.enabled, true);

  const catalogIds = KOMPLETT_DEMO_CATALOG.flatMap((g) => g.categories.map((c) => c.id));
  assert.equal(catalogIds.length, 24);
  assert.equal(new Set(catalogIds).size, 24);
});

test('the webhook is masked for the dashboard', () => {
  const url = 'https://discord.com/api/webhooks/123456/secret-token';
  const masked = maskWebhookUrl(url);
  assert.ok(!masked.includes('secret-token'));
  assert.ok(masked.startsWith('https://discord.com/api/webhooks/123456/'));
  assert.ok(isMaskedWebhookUrl(masked));
  const pub = publicKomplettDemoConfig({ discordWebhookUrl: url });
  assert.equal(pub.discordWebhookConfigured, true);
  assert.ok(!JSON.stringify(pub).includes('secret-token'));
  assert.equal(publicKomplettDemoConfig({}).discordWebhookConfigured, false);
});

// ── Poller ─────────────────────────────────────────────────────

function makeClock(startMs = Date.UTC(2026, 9, 31, 10, 0, 0)) {
  let nowMs = startMs;
  let nextId = 1;
  const timers = new Map();
  const delays = [];
  return {
    now: () => nowMs,
    delays,
    setTimeoutFn(fn, delay) {
      const id = nextId++;
      delays.push(delay);
      timers.set(id, { fn, at: nowMs + delay });
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
    async advance(ms) {
      const target = nowMs + ms;
      for (let guard = 0; guard < 50; guard++) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        nowMs = timer.at;
        timer.fn();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      nowMs = target;
    },
  };
}

function makeHarness({ cfg = config(), responses, persistence, notifier, fetchRunUsage, clock = makeClock() } = {}) {
  const fetchCalls = [];
  let config_ = cfg;
  const queue = [...(responses ?? [])];
  const sentAlerts = [];
  const fakeNotifier = notifier ?? {
    async notifyKomplettDemo({ alerts }) {
      sentAlerts.push(...alerts);
      return { sent: alerts.length, failed: 0, skipped: 0, delivered: alerts.map(() => true) };
    },
  };
  const poller = createKomplettDemoPoller({
    getConfig: () => config_,
    notifier: fakeNotifier,
    persistence,
    fetchPages: async ({ categories }) => {
      fetchCalls.push(categories.map((c) => c.id));
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    fetchRunUsage: fetchRunUsage ?? (async () => null),
    logger: silentLogger,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    random: () => 0.5,
    now: clock.now,
  });
  return {
    poller, clock, fetchCalls, sentAlerts, queue,
    setConfig(next) { config_ = next; },
  };
}

const runResponse = (pages, usd = 0.0004, id = `run-${Math.random()}`) => ({
  run: { id, status: 'SUCCEEDED', usageTotalUsd: usd },
  pages,
});

test('the poller seeds, then alerts, and tracks spend', async () => {
  const h = makeHarness({
    responses: [
      runResponse([page(HEADSET, [rawProduct(100), rawProduct(99)])], 0.0004, 'r1'),
      runResponse([page(HEADSET, [rawProduct(101), rawProduct(100), rawProduct(99)])], 0.0005, 'r2'),
    ],
  });

  const first = await h.poller.pollNow();
  assert.equal(first.alertCount, 0);
  assert.equal(h.sentAlerts.length, 0);

  const second = await h.poller.pollNow();
  assert.equal(second.alertCount, 1);
  assert.equal(h.sentAlerts[0].product.id, '101');

  const status = h.poller.getStatus();
  assert.equal(status.costGuard.runs, 2);
  assert.ok(Math.abs(status.costGuard.spentUsd - 0.0009) < 1e-9);
  assert.equal(status.recentAlerts[0].id, '101');
  assert.equal(status.recentAlerts[0].delivered, true);
  assert.equal(status.categories[0].seeded, true);
  assert.equal(status.latestFinds[0].id, '101');
});

test('the poller re-reads the settled cost of the previous run', async () => {
  const h = makeHarness({
    responses: [
      runResponse([page(HEADSET, [rawProduct(1)])], 0.0003, 'r1'),
      runResponse([page(HEADSET, [rawProduct(1)])], 0.0003, 'r2'),
    ],
    fetchRunUsage: async ({ runId }) => (runId === 'r1' ? 0.0005 : null),
  });
  await h.poller.pollNow();
  await h.poller.pollNow();
  assert.ok(Math.abs(h.poller.getStatus().costGuard.spentUsd - 0.0008) < 1e-9);
});

test('a blocked run fails and backs off; the cost is still counted', async () => {
  const clock = makeClock();
  const h = makeHarness({
    clock,
    cfg: config({ jitterPct: 0 }),
    responses: [
      runResponse([{ categoryId: HEADSET, found: false, products: [] }], 0.0004),
      new Error('Apify API unreachable'),
      runResponse([page(HEADSET, [rawProduct(1)])]),
    ],
  });
  h.poller.start();
  await clock.advance(60_000); // initial delay is 15–45 s
  assert.equal(h.fetchCalls.length, 1);
  let status = h.poller.getStatus();
  assert.match(status.lastError, /No category page returned product data/);
  assert.equal(status.consecutiveFailures, 1);
  assert.equal(status.costGuard.runs, 1);
  assert.equal(clock.delays.at(-1), 20 * 60_000);

  await clock.advance(20 * 60_000);
  assert.equal(h.fetchCalls.length, 2);
  assert.equal(h.poller.getStatus().consecutiveFailures, 2);
  assert.equal(clock.delays.at(-1), 40 * 60_000);

  await clock.advance(40 * 60_000);
  status = h.poller.getStatus();
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.lastError, null);
  assert.equal(clock.delays.at(-1), 10 * 60_000);
  h.poller.stop();
});

test('the poller does not run when disabled or without categories, and skips when the budget is spent', async () => {
  const clock = makeClock();
  const h = makeHarness({ clock, cfg: config({ enabled: false }), responses: [] });
  h.poller.start();
  await clock.advance(3 * 60 * 60_000);
  assert.equal(h.fetchCalls.length, 0);

  h.setConfig(config({ categories: [] }));
  await clock.advance(3 * 60 * 60_000);
  assert.equal(h.fetchCalls.length, 0);
  await assert.rejects(() => h.poller.pollNow(), /Select at least one/);
  h.poller.stop();

  const persisted = createEmptyKomplettDemoState();
  persisted.usage = { month: '2026-10', usd: 4.5, runs: 9000, urls: 27000 };
  const broke = makeHarness({ clock: makeClock(), persistence: { load: () => persisted, save() {} }, responses: [] });
  broke.poller.start();
  await broke.clock.advance(3 * 60 * 60_000);
  assert.equal(broke.fetchCalls.length, 0);
  const status = broke.poller.getStatus();
  assert.equal(status.costGuard.exhausted, true);
  assert.equal(status.lastSkipReason, 'budget-exhausted');
  broke.poller.stop();
});

test('a manual check while disabled records silently', async () => {
  const h = makeHarness({
    cfg: config({ enabled: false }),
    responses: [
      runResponse([page(HEADSET, [rawProduct(1)])]),
      runResponse([page(HEADSET, [rawProduct(2), rawProduct(1)])]),
    ],
  });
  await h.poller.pollNow();
  await h.poller.pollNow();
  assert.equal(h.sentAlerts.length, 0);
});

test('failed Discord deliveries are retried on the next poll', async () => {
  let fail = true;
  const delivered = [];
  const notifier = {
    async notifyKomplettDemo({ alerts }) {
      if (fail) return { sent: 0, failed: alerts.length, skipped: 0, delivered: alerts.map(() => false), errors: ['503'] };
      delivered.push(...alerts.map((a) => a.product.id));
      return { sent: alerts.length, failed: 0, skipped: 0, delivered: alerts.map(() => true) };
    },
  };
  const h = makeHarness({
    notifier,
    responses: [
      runResponse([page(HEADSET, [rawProduct(1)])]),
      runResponse([page(HEADSET, [rawProduct(2), rawProduct(1)])]),
      runResponse([page(HEADSET, [rawProduct(2), rawProduct(1)])]),
    ],
  });
  await h.poller.pollNow();
  await h.poller.pollNow();
  assert.equal(h.poller.getStatus().pendingAlerts, 1);
  fail = false;
  await h.poller.pollNow();
  assert.deepEqual(delivered, ['2']);
  assert.equal(h.poller.getStatus().pendingAlerts, 0);
});

test('state persists across a restart so nothing re-alerts', async () => {
  let saved = null;
  const persistence = {
    load: () => (saved ? JSON.parse(saved) : null),
    save: (value) => { saved = JSON.stringify(value); },
  };
  const before = makeHarness({
    persistence,
    responses: [
      runResponse([page(HEADSET, [rawProduct(100)])], 0.0004, 'r1'),
      runResponse([page(HEADSET, [rawProduct(101), rawProduct(100)])], 0.0004, 'r2'),
    ],
  });
  await before.poller.pollNow();
  await before.poller.pollNow();
  assert.equal(before.sentAlerts.length, 1);

  // "Restart": a brand-new poller reading the same persisted record.
  const after = makeHarness({
    persistence,
    responses: [runResponse([page(HEADSET, [rawProduct(102), rawProduct(101), rawProduct(100)])], 0.0004, 'r3')],
  });
  const status = after.poller.getStatus();
  assert.equal(status.categories[0].seeded, true);
  assert.equal(status.costGuard.runs, 2);
  assert.equal(status.recentAlerts.length, 1);

  await after.poller.pollNow();
  assert.deepEqual(after.sentAlerts.map((a) => a.product.id), ['102']);
});

test('after a restart the first poll waits for the remainder of the interval', async () => {
  const clock = makeClock();
  const persisted = createEmptyKomplettDemoState();
  persisted.lastRun = { at: new Date(clock.now() - 4 * 60_000).toISOString(), ok: true };
  const h = makeHarness({ clock, cfg: config({ jitterPct: 0 }), persistence: { load: () => persisted, save() {} }, responses: [] });
  h.poller.start();
  assert.equal(clock.delays[0], 6 * 60_000);
  h.poller.stop();
});

test('SqliteStore keeps the watcher record in its own row', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spw-kd-test-'));
  const dbPath = path.join(dir, 'store.db');
  const store = new SqliteStore(dbPath);
  await store.load();
  assert.equal(store.loadRecord('komplett-demo'), null);
  store.saveRecord('komplett-demo', { products: { 1: { id: '1' } } });
  await store.save({ skipItems: true }); // a full save must not clobber it
  assert.throws(() => store.saveRecord('stats', {}), /reserved/);

  const reloaded = new SqliteStore(dbPath);
  await reloaded.load();
  assert.deepEqual(reloaded.loadRecord('komplett-demo'), { products: { 1: { id: '1' } } });
  assert.equal(reloaded.getState().stats.products, undefined);
});

// ── Discord ────────────────────────────────────────────────────

test('notifyKomplettDemo posts B-grade embeds in batches without mentions', async () => {
  const originalFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 204, headers: { get: () => null } };
  };
  try {
    const notifier = new DiscordNotifier({ webhookUrl: 'https://discord.com/api/webhooks/1/global', cooldownHours: 1 });
    const product = mapKomplettDemoProduct(rawProduct(7, { price: { listPriceNumber: 900 } }), HEADSET);
    const single = await notifier.notifyKomplettDemo({
      alerts: [{ reason: 'price-drop', product, categoryId: HEADSET, previousPriceSek: 1000, dropPercent: 10 }],
      webhookUrl: '',
    });
    assert.equal(single.sent, 1);
    assert.deepEqual(single.delivered, [true]);
    assert.equal(posts[0].url, 'https://discord.com/api/webhooks/1/global', 'falls back to the global webhook');
    const body = posts[0].body;
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.ok(!/@everyone|@here/.test(JSON.stringify(body)));
    assert.match(body.content, /Komplett demo.*price drop 10%/);
    const embed = body.embeds[0];
    assert.equal(embed.url, product.url);
    assert.equal(embed.image.url, product.imageUrl);
    assert.ok(embed.fields.some((f) => f.name === 'Condition' && /B-grade/.test(f.value)));
    assert.ok(embed.fields.some((f) => f.name === 'Category' && /Headset/.test(f.value)));
    assert.ok(embed.fields.some((f) => f.name === 'Stock' && f.value === '1 st i lager'));
    assert.match(embed.description, /Price drop 10%/);

    posts.length = 0;
    const many = Array.from({ length: 12 }, (_, i) => ({
      reason: 'new', product: mapKomplettDemoProduct(rawProduct(100 + i), HEADSET), categoryId: HEADSET,
    }));
    const batched = await notifier.notifyKomplettDemo({ alerts: many, webhookUrl: 'https://discord.com/api/webhooks/2/own' });
    assert.equal(batched.sent, 12);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.embeds.length, 10);
    assert.equal(posts[1].body.embeds.length, 2);
    assert.equal(posts[0].url, 'https://discord.com/api/webhooks/2/own');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const noWebhook = new DiscordNotifier({ webhookUrl: '', cooldownHours: 1 });
  const skipped = await noWebhook.notifyKomplettDemo({ alerts: [{ reason: 'new', product: { id: '1' }, categoryId: HEADSET }] });
  assert.equal(skipped.reason, 'no-webhook');
  assert.deepEqual(skipped.delivered, [false]);
});

// ── Routes ─────────────────────────────────────────────────────

test('Komplett demo routes: config, validation, masked webhook, poll', async () => {
  const state = createDefaultState();
  const cache = new ProductCache();
  cache.rebuild(state);
  let stored = normalizeKomplettDemoConfig({ discordWebhookUrl: 'https://discord.com/api/webhooks/9/keep-me' });
  let polls = 0;

  const app = await buildApp({
    config: { publicDir, sources: [] },
    store: { getState: () => state },
    productCache: cache,
    scanState: { running: false, lastError: null },
    triggerScan: async () => ({}),
    komplettDemo: {
      getConfig: () => stored,
      update: async (next) => { stored = next; return next; },
      getStatus: () => ({ enabled: stored.enabled, costGuard: {} }),
      pollNow: async () => { polls += 1; return { count: 3 }; },
    },
  });

  const overview = await app.inject({ method: 'GET', url: '/api/komplett-demo' });
  assert.equal(overview.statusCode, 200);
  const body = overview.json();
  assert.equal(body.catalog.length, KOMPLETT_DEMO_CATALOG.length);
  assert.ok(body.catalog[0].categories[0].url.includes('sort=ReleaseDateDesc'));
  assert.ok(!JSON.stringify(body).includes('keep-me'));
  assert.equal(body.config.discordWebhookConfigured, true);

  const bad = await app.inject({ method: 'POST', url: '/api/komplett-demo/config', payload: { categories: [HEADSET, '424242'] } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /424242/);

  const badHook = await app.inject({ method: 'POST', url: '/api/komplett-demo/config', payload: { discordWebhookUrl: 'https://evil.example.com/x' } });
  assert.equal(badHook.statusCode, 400);

  // Posting the masked value back keeps the stored webhook.
  const saved = await app.inject({
    method: 'POST',
    url: '/api/komplett-demo/config',
    payload: { enabled: true, categories: [MICE, HEADSET], intervalMinutes: 15, discordWebhookUrl: body.config.discordWebhookUrl },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(stored.categories, [HEADSET, MICE]);
  assert.equal(stored.intervalMinutes, 15);
  assert.equal(stored.discordWebhookUrl, 'https://discord.com/api/webhooks/9/keep-me');

  // A partial update keeps everything else; clearing the webhook works.
  await app.inject({ method: 'PUT', url: '/api/komplett-demo', payload: { discordWebhookUrl: '' } });
  assert.equal(stored.discordWebhookUrl, '');
  assert.deepEqual(stored.categories, [HEADSET, MICE]);

  const poll = await app.inject({ method: 'POST', url: '/api/komplett-demo/poll' });
  assert.equal(poll.statusCode, 200);
  assert.equal(poll.json().result.count, 3);
  assert.equal(polls, 1);

  const statusRes = await app.inject({ method: 'GET', url: '/api/komplett-demo/status' });
  assert.equal(statusRes.json().enabled, true);
  const catalogRes = await app.inject({ method: 'GET', url: '/api/komplett-demo/catalog' });
  assert.equal(catalogRes.json().length, 7);

  await app.close();
});

test('legacy categories migrate to watch groups and normal deals + B-grade feeds work together', () => {
  const migrated = normalizeKomplettDemoConfig({
    enabled: true,
    categories: ['10072', '10071', '12423'],
    intervalMinutes: 5,
    jitterPct: 40,
    notifyPriceDropPercent: 2,
    notifyBackInStock: true,
    maxMonthlyUsd: 4,
  });
  assert.deepEqual(migrated.feeds, { deals: true, outlet: true });
  assert.deepEqual(migrated.categories, ['10072', '10071', '12423']);
  assert.equal(migrated.groups.length, 3);
  assert.deepEqual(
    migrated.groups.map((g) => ({ id: g.id, name: g.name, feeds: g.feeds, categories: g.categories })),
    [
      { id: 'kg-cat-10072', name: 'Grafikkort', feeds: 'both', categories: ['10072'] },
      { id: 'kg-cat-10071', name: 'Moderkort', feeds: 'both', categories: ['10071'] },
      { id: 'kg-cat-12423', name: 'Komplett-PC', feeds: 'both', categories: ['12423'] },
    ],
  );

  // Simulate upgrading a live state that already seeded B-grade categories.
  const state = createEmptyKomplettDemoState();
  state.seededCategories = { '10072': '2026-10-31T20:00:00.000Z' };
  state.seededFeeds = { outlet: '2026-10-31T20:00:00.000Z' };
  state.seededGroups = { 'kg-cat-10072': { outlet: '2026-10-31T20:00:00.000Z' } };

  const dealGpu = {
    materialNumber: '1310001',
    name: 'ASUS Prime GeForce RTX 5070 Ti OC',
    url: '/product/1310001/datorutrustning/datorkomponenter/grafikkort/asus-prime-geforce-rtx-5070-ti-oc',
    price: { listPriceNumber: 9990, discountNumber: 1500 },
    stock: { availabilityStatus: 'Stocked', availabilityQuantity: '5', availabilityText: '5 st i lager' },
    productImages: [{ url: 'product-media/b2c/en-us', fileName: '1310001.jpg' }],
  };
  const unrelatedMouse = {
    materialNumber: '1310099',
    name: 'Logitech G Pro X Superlight 2',
    url: '/product/1310099/gaming/gaming-utrustning/gamingmus/logitech-g-pro-x-superlight-2',
    price: { listPriceNumber: 1290, discountNumber: 300 },
    stock: { availabilityStatus: 'Stocked', availabilityQuantity: '10', availabilityText: '10 st i lager' },
    productImages: [],
  };

  // First poll after upgrade: deals feed seeds silently, while outlet is already seeded.
  const first = applyKomplettDemoPages({
    state,
    pages: [
      page('10072', [rawProduct(2001, { url: '/product/2001/demovaror/datorutrustning/demo-grafikkort/rtx-5080-demo' })]),
      { categoryId: 'deals-datorutrustning', feed: 'deals', found: true, sort: KOMPLETT_DEMO_SORT, total: 2, products: [dealGpu, unrelatedMouse] },
    ],
    config: migrated,
    nowIso: '2026-11-08T10:00:00.000Z',
  });
  // Only the new B-grade GPU alerts on the first run; the normal deal GPU seeds silently, and the mouse is ignored.
  assert.deepEqual(first.alerts.map((a) => [a.feed, a.product.id]), [['outlet', '2001']]);
  assert.equal(state.products['1310001'].feed, 'deals');
  assert.equal(state.products['1310001'].listPriceSek, 11490);
  assert.equal(state.products['1310001'].discountPct, 13);
  assert.equal(state.products['1310099'], undefined);

  // Second poll: a new normal deal GPU now alerts!
  const dealGpu2 = {
    ...dealGpu,
    materialNumber: '1310002',
    name: 'MSI GeForce RTX 5080 Gaming Trio OC',
    url: '/product/1310002/datorutrustning/datorkomponenter/grafikkort/msi-geforce-rtx-5080',
    price: { listPriceNumber: 13990, discountNumber: 2000 },
  };
  const second = applyKomplettDemoPages({
    state,
    pages: [
      page('10072', [rawProduct(2001, { url: '/product/2001/demovaror/datorutrustning/demo-grafikkort/rtx-5080-demo' })]),
      { categoryId: 'deals-datorutrustning', feed: 'deals', found: true, sort: KOMPLETT_DEMO_SORT, total: 2, products: [dealGpu2, dealGpu] },
    ],
    config: migrated,
    nowIso: '2026-11-08T10:05:00.000Z',
  });
  assert.deepEqual(second.alerts.map((a) => [a.feed, a.product.id]), [['deals', '1310002']]);
});
