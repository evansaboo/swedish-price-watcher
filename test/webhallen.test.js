import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WEBHALLEN_API_HEADERS,
  WEBHALLEN_MAX_PAGES_PER_FEED,
  WEBHALLEN_PAGE_FUNCTION,
  WEBHALLEN_PAGE_SIZE,
  buildWebhallenFeedUrl,
  buildWebhallenPageUrl,
  compactWebhallenProductForTest,
  fetchWebhallenPages,
  mapWebhallenProduct,
  resolveWebhallenCategory,
  webhallenPagesFor,
} from '../src/sources/webhallen.js';
import {
  DEFAULT_WEBHALLEN_CONFIG,
  MIN_INTERVAL_MINUTES,
  normalizeWebhallenConfig,
  publicWebhallenConfig,
  validateWebhallenConfigPatch,
} from '../src/services/webhallenConfig.js';
import {
  MIN_DELAY_MS,
  WEBHALLEN_COST_MODEL,
  applyWebhallenPages,
  createEmptyWebhallenState,
  createWebhallenPoller,
  foldText,
  groupMatches,
  keywordMatchesTitle,
} from '../src/services/webhallenPoller.js';
import { computeCostGuard, computeNextDelayMs } from '../src/services/komplettDemoPoller.js';
import {
  WEBHALLEN_DEALS_SOURCE_ID,
  WEBHALLEN_OUTLET_SOURCE_ID,
  syncWebhallenListing,
  webhallenConditionLabel,
  webhallenRecordToObservation,
} from '../src/services/webhallenListing.js';
import { DiscordNotifier } from '../src/services/notifier.js';
import { SqliteStore, createDefaultState, reconcileStateWithSources } from '../src/lib/store.js';
import { mergeObservations } from '../src/services/dealEngine.js';
import { ProductCache } from '../src/services/productCache.js';
import { buildApp } from '../src/app.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const silentLogger = { error() {}, warn() {}, log() {}, info() {} };
const MONITORS = 'datorer-tillbehor-bildskarmar';
const LAPTOPS = 'datorer-tillbehor-barbara-datorer';
const GPUS = 'datorkomponenter-grafikkort-gpu';
const T0 = '2026-11-07T08:00:00.000Z';
const T1 = '2026-11-07T08:20:00.000Z';
const T2 = '2026-11-07T08:40:00.000Z';
const T3 = '2026-11-07T09:00:00.000Z';

// ── Fixtures ───────────────────────────────────────────────────

/** A raw product as Webhallen's productdiscovery API returns it. */
function whRaw(id, overrides = {}) {
  return {
    id,
    name: `Product ${id} (Fyndvara klass 1)`,
    mainTitle: `Product ${id}`,
    subTitle: '27" / OLED / 240Hz',
    image: `https://www.webhallen.com/images/product/${id}?trim`,
    categoryTree: 'Fyndvaror/Datorer & Tillbehör/Datortillbehör/Datorskärm Bildskärm',
    manufacturer: { id: 10, name: 'ASUS', takeoverUrl: null },
    price: { price: '2399.00', currency: 'SEK', vat: 479.8, type: null, endAt: null, maxQtyPerCustomer: 1 },
    regularPrice: { price: '3299.00', currency: 'SEK', vat: 659.8, type: null },
    lowestPrice: { price: '2999.00', currency: 'SEK' },
    stock: { web: 0, '2': 1, '992': 0 },
    isFyndware: true,
    fyndwareClass: { id: 1, name: 'Fyndvara klass 1', condition: 'Nyskick' },
    fyndwareOf: { id: 395584, name: 'Product Parent' },
    discontinued: false,
    ...overrides,
  };
}

/** A compact product as returned by the Apify page function. */
function compact(id, overrides = {}) {
  return {
    id: String(id),
    name: `Product ${id}`,
    mainTitle: `Product ${id}`,
    subTitle: '27" / IPS / 165Hz',
    image: `https://www.webhallen.com/images-ext/cdn-${id}?size=500x500`,
    categoryTree: 'Datorer & Tillbehör/Bildskärmar',
    manufacturer: 'LG',
    price: 2399,
    listPrice: 3299,
    priceType: 'campaign',
    webQty: 5,
    storeQty: 0,
    isFyndware: false,
    fyndwareClassId: null,
    fyndwareClassName: null,
    fyndwareCondition: null,
    fyndwareParentId: null,
    discontinued: false,
    ...overrides,
  };
}

function page(feed, products, { n = 1, total = products.length, pageSize = WEBHALLEN_PAGE_SIZE, ids } = {}) {
  return {
    feed,
    page: n,
    found: true,
    pageSize,
    total,
    products,
    ...(ids ? { productIds: ids } : {}),
  };
}

function cfg(overrides = {}) {
  return normalizeWebhallenConfig({
    enabled: true,
    groups: [{ id: 'g-mon', name: 'Monitors', categories: [MONITORS] }],
    ...overrides,
  });
}

function apply(state, pages, config, nowIso, extra = {}) {
  return applyWebhallenPages({ state, pages, config, nowIso, ...extra });
}

// ── Extraction, category resolution, mapping, planning ─────────

test('resolveWebhallenCategory canonicalizes both campaign and Fyndvaror categoryTree paths', () => {
  const dealMon = resolveWebhallenCategory('Datorer & Tillbehör/Bildskärmar/Gamingskärm');
  const outletMon = resolveWebhallenCategory('Fyndvaror/Datorer & Tillbehör/Datortillbehör/Datorskärm Bildskärm');
  assert.equal(dealMon.id, MONITORS);
  assert.equal(outletMon.id, MONITORS, 'both feeds resolve to the same canonical category id');
  assert.equal(outletMon.name, 'Datorer & Tillbehör / Bildskärmar');
  assert.equal(outletMon.sectionId, 'datorer-tillbehor');

  const gpuDeal = resolveWebhallenCategory('Datorkomponenter/Grafikkort (GPU)/GeForce RTX 50-serien');
  const gpuOutlet = resolveWebhallenCategory('Fyndvaror/Datorkomponenter/Grafikkort (GPU)');
  assert.equal(gpuDeal.id, GPUS);
  assert.equal(gpuOutlet.id, GPUS);
  assert.equal(gpuDeal.name, 'Datorkomponenter / Grafikkort (GPU)');

  const laptopDeal = resolveWebhallenCategory('Datorer & Tillbehör/Laptop Bärbar dator/Gaming laptop');
  const laptopOutlet = resolveWebhallenCategory('Fyndvaror/Datorer & Tillbehör/Datorer/Bärbara');
  assert.equal(laptopDeal.id, LAPTOPS);
  assert.equal(laptopOutlet.id, LAPTOPS);

  const pcDeal = resolveWebhallenCategory('Datorer & Tillbehör/Stationär dator/Webhallen Config');
  const pcOutlet = resolveWebhallenCategory('Fyndvaror/Datorer & Tillbehör/Datorer/Stationära');
  assert.equal(pcDeal.id, pcOutlet.id);
  assert.equal(pcDeal.name, 'Datorer & Tillbehör / Stationära datorer');

  assert.equal(resolveWebhallenCategory('').id, null);
  assert.equal(resolveWebhallenCategory('Fyndvaror').id, null);
});

test('the page function returns compact products; page 1 enqueues extra pages with headers', async () => {
  const payload = {
    products: [
      whRaw(395586),
      whRaw(395587, { stock: { web: 3 }, isFyndware: true }),
      whRaw(999999, { isFyndware: false }), // filtered out on the outlet feed
    ],
    totalProductCount: 520,
    filteredProductCount: 520,
    categories: [{ id: 4684, name: 'Datorkomponenter' }, { id: 1, name: 'Datorer & Tillbehör' }],
  };
  // eslint-disable-next-line no-new-func
  const pageFunction = new Function(`${WEBHALLEN_PAGE_FUNCTION}; return pageFunction;`)();
  const enqueued = [];
  const userData = {
    feed: 'outlet',
    page: 1,
    apiBaseUrl: 'https://www.webhallen.com/api/productdiscovery/search/fyndware',
    headers: WEBHALLEN_API_HEADERS,
    pageSize: 250,
    plannedPages: 1,
    maxPages: 12,
  };
  const out = await pageFunction({
    body: JSON.stringify(payload),
    request: { url: buildWebhallenFeedUrl('outlet', 1), userData },
    response: { statusCode: 200 },
    enqueueRequest: async (request) => enqueued.push(request),
  });
  assert.equal(out.found, true);
  assert.equal(out.feed, 'outlet');
  assert.equal(out.total, 520);
  assert.equal(out.products.length, 2, 'non-fyndware item is skipped on outlet');
  assert.deepEqual(out.categories, [{ id: 4684, name: 'Datorkomponenter' }, { id: 1, name: 'Datorer & Tillbehör' }]);

  const p = out.products.find((x) => x.id === '395586');
  assert.deepEqual(
    {
      price: p.price,
      listPrice: p.listPrice,
      webQty: p.webQty,
      storeQty: p.storeQty,
      fyndwareCondition: p.fyndwareCondition,
      fyndwareParentId: p.fyndwareParentId,
    },
    {
      price: 2399,
      listPrice: 3299,
      webQty: 0,
      storeQty: 1,
      fyndwareCondition: 'Nyskick',
      fyndwareParentId: '395584',
    },
  );
  assert.deepEqual(enqueued.map((r) => r.userData.page), [2, 3]);
  assert.ok(enqueued.every((r) => r.url.includes('limit=250') && r.headers.region === 'se'));

  // Page 2 does not enqueue anything.
  enqueued.length = 0;
  const second = await pageFunction({
    json: payload,
    request: { url: buildWebhallenFeedUrl('outlet', 2), userData: { ...userData, page: 2 } },
    enqueueRequest: async (r) => enqueued.push(r),
  });
  assert.equal(second.categories, undefined);
  assert.equal(enqueued.length, 0);

  // Blocked / HTML challenge response is reported cleanly.
  const blocked = await pageFunction({
    body: '<html><title>Just a moment...</title></html>',
    request: { url: 'u', userData },
    $: () => ({ first: () => ({ text: () => 'Just a moment...' }) }),
  });
  assert.equal(blocked.found, false);
  assert.equal(blocked.title, 'Just a moment...');
});

test('mapWebhallenProduct builds URLs, images, PC spec titles, prices, discount and stock', () => {
  const outlet = mapWebhallenProduct(compactWebhallenProductForTest(whRaw(395586, {
    name: 'ASUS ROG Swift OLED PG27AQDM (Fyndvara klass 1)',
    mainTitle: 'ASUS ROG Swift OLED PG27AQDM',
    price: { price: '7490.00' },
    regularPrice: { price: '9990.00' },
    stock: { web: 0, '5': 1 },
    fyndwareOf: { id: 359001, name: 'ASUS ROG Swift OLED PG27AQDM' },
  })), 'outlet');
  assert.equal(outlet.url, 'https://www.webhallen.com/se/product/395586-ASUS-ROG-Swift-OLED-PG27AQDM');
  assert.equal(outlet.imageUrl, 'https://www.webhallen.com/images/product/359001?trim', 'uses parent product id for older fyndvaror photos');
  assert.equal(outlet.priceSek, 7490);
  assert.equal(outlet.listPriceSek, 9990);
  assert.equal(outlet.discountPct, 25);
  assert.equal(outlet.inWebStock, false);
  assert.equal(outlet.inStock, true, 'store stock counts');
  assert.equal(outlet.categoryId, MONITORS);
  assert.equal(outlet.sellingPoint, 'Fyndvara klass 1 — Nyskick');

  // Webhallen Config PC with specs in subTitle includes them in title so GPU/CPU keywords match.
  const configPc = mapWebhallenProduct(compact(393836, {
    name: 'Webhallen Config Ultra - a330',
    mainTitle: 'Webhallen Config Ultra - a330',
    subTitle: 'Ultra / R7 9800X3D / 32 GB / 2 TB / NVIDIA GeForce RTX 5080 / Windows 11 Home',
    categoryTree: 'Datorer & Tillbehör/Stationär dator/Webhallen Config',
    price: 29990,
    listPrice: 33990,
  }), 'deals');
  assert.match(configPc.title, /Webhallen Config Ultra - a330.*RTX 5080/);
  assert.equal(configPc.url, 'https://www.webhallen.com/se/product/393836-Webhallen-Config-Ultra-a330');
  assert.equal(configPc.imageUrl, 'https://www.webhallen.com/images-ext/cdn-393836?size=500x500');

  const deal = mapWebhallenProduct(compact(391000, { price: 1149, listPrice: 1149, webQty: 0, storeQty: 0 }), 'deals');
  assert.equal(deal.listPriceSek, null);
  assert.equal(deal.discountPct, 0);
  assert.equal(deal.inStock, false);
  assert.equal(mapWebhallenProduct(compact(1, { discontinued: true }), 'deals').inStock, false);
  assert.equal(mapWebhallenProduct({ id: '1' }, 'deals'), null);
  assert.equal(mapWebhallenProduct(compact(1), 'nope'), null);
});

test('page planning covers the feed size, clamped; one Apify run fetches every page via proxy', async () => {
  assert.equal(webhallenPagesFor(null), 1);
  assert.equal(webhallenPagesFor(250), 1);
  assert.equal(webhallenPagesFor(251), 2);
  assert.equal(webhallenPagesFor(809), 4);
  assert.equal(webhallenPagesFor(1474), 6);
  assert.equal(webhallenPagesFor(100_000), WEBHALLEN_MAX_PAGES_PER_FEED);
  assert.equal(buildWebhallenPageUrl('deals'), 'https://www.webhallen.com/se/campaigns');
  assert.equal(buildWebhallenPageUrl('outlet'), 'https://www.webhallen.com/se/category/s53-Fyndvaror');
  assert.match(buildWebhallenFeedUrl('deals', 1), /\/api\/productdiscovery\/campaigns\?page=1&pageNo=1&limit=250/);
  assert.match(buildWebhallenFeedUrl('outlet', 3), /\/api\/productdiscovery\/search\/fyndware\?page=3&pageNo=3&limit=250/);

  const calls = [];
  class StubClient {
    constructor({ token }) { this.token = token; }
    actor(name) {
      return {
        call: async (input, options) => {
          calls.push({ name, input, options });
          return { id: 'r1', status: 'SUCCEEDED', usageTotalUsd: 0.001, defaultDatasetId: 'd1' };
        },
      };
    }
    dataset() { return { listItems: async () => ({ items: [{ feed: 'deals', page: 1, found: true, products: [] }] }) }; }
  }
  const result = await fetchWebhallenPages({
    feeds: [{ id: 'outlet', pages: 6 }, { id: 'deals', pages: 4 }],
    token: 't',
    ApifyClientClass: StubClient,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'apify/cheerio-scraper');
  assert.deepEqual(calls[0].input.proxyConfiguration, { useApifyProxy: true });
  assert.deepEqual(calls[0].input.additionalMimeTypes, ['application/json']);
  assert.equal(calls[0].options.memory, 256);
  assert.equal(calls[0].input.pageFunction, WEBHALLEN_PAGE_FUNCTION);
  assert.equal(calls[0].input.startUrls.length, 10);
  assert.ok(calls[0].input.startUrls.every((u) => u.url.startsWith('https://www.webhallen.com/api/productdiscovery/') && u.headers.region === 'se'));
  assert.deepEqual(calls[0].input.startUrls.filter((u) => u.userData.feed === 'outlet').map((u) => u.userData.page), [1, 2, 3, 4, 5, 6]);
  assert.equal(result.run.usageTotalUsd, 0.001);
  assert.equal(result.pages.length, 1);

  await assert.rejects(() => fetchWebhallenPages({ feeds: [], token: 't', ApifyClientClass: StubClient }), /No Webhallen feeds/);
  await assert.rejects(() => fetchWebhallenPages({ feeds: [{ id: 'deals', pages: 1 }], token: '', ApifyClientClass: StubClient }), /No Apify token/);

  // Proxy-first fetch ($0 cost) and automatic Apify fallback on proxy failure:
  const proxyUrls = [];
  const proxyResult = await fetchWebhallenPages({
    feeds: [{ id: 'outlet', pages: 1 }],
    token: 't',
    proxyUrl: 'socks5://u:p@127.0.0.1:1080',
    proxyFetch: async (url) => {
      proxyUrls.push(url);
      const isPage1 = url.includes('page=1');
      return {
        statusCode: 200,
        ok: true,
        url,
        loadedUrl: url,
        body: JSON.stringify({
          products: [whRaw(isPage1 ? 395586 : 395587)],
          filteredProductCount: 260,
          categories: [{ id: 1, name: 'Datorer & Tillbehör' }],
        }),
      };
    },
    ApifyClientClass: StubClient,
  });
  assert.equal(proxyResult.run.status, 'PROXY');
  assert.equal(proxyResult.run.usageTotalUsd, 0);
  assert.equal(proxyResult.pages.length, 2, 'page 1 discovers page 2 and fetches both via proxy');
  assert.equal(calls.length, 1, 'Apify was not called when proxy succeeded');

  // When proxy fails, falls back to Apify automatically:
  const fallbackResult = await fetchWebhallenPages({
    feeds: [{ id: 'deals', pages: 1 }],
    token: 't',
    proxyUrl: 'socks5://u:p@127.0.0.1:1080',
    proxyFetch: async () => { throw new Error('proxy unreachable'); },
    logger: silentLogger,
    ApifyClientClass: StubClient,
  });
  assert.equal(fallbackResult.run.status, 'SUCCEEDED');
  assert.equal(calls.length, 2, 'fell back to Apify when proxy threw');
});

// ── Matching ───────────────────────────────────────────────────

test('groups match on feed, keywords, category or top-level section, and value filters', () => {
  assert.equal(foldText('Skärm ÖVERSIKT Ål'), 'skarm oversikt al');
  assert.ok(keywordMatchesTitle('rtx 5090', 'ASUS ROG Astral GeForce RTX™ 5090 OC'));

  const product = mapWebhallenProduct(compact('395586', {
    name: 'LG 27GR95QE OLED skärm',
    categoryTree: 'Fyndvaror/Datorer & Tillbehör/Datortillbehör/Datorskärm Bildskärm',
    listPrice: 10000,
    price: 7000,
    webQty: 0,
    storeQty: 1,
  }), 'outlet');
  const group = (overrides) => normalizeWebhallenConfig({ groups: [{ id: 'g', name: 'G', ...overrides }] }).groups[0];

  assert.ok(groupMatches(group({ keywords: ['oled'] }), product));
  assert.ok(groupMatches(group({ categories: [MONITORS, LAPTOPS] }), product));
  assert.ok(groupMatches(group({ categories: ['datorer-tillbehor'] }), product), 'matches top-level section id too');
  assert.ok(!groupMatches(group({ categories: [LAPTOPS] }), product));
  assert.ok(!groupMatches(group({ categories: [MONITORS], keywords: ['qd'] }), product), 'categories AND keywords');
  assert.ok(groupMatches(group({ keywords: ['oled'], feeds: 'outlet' }), product));
  assert.ok(!groupMatches(group({ keywords: ['oled'], feeds: 'deals' }), product));
  assert.ok(groupMatches(group({ keywords: ['oled'], minDiscountPct: 30 }), product));
  assert.ok(!groupMatches(group({ keywords: ['oled'], minDiscountPct: 31 }), product));
  assert.ok(groupMatches(group({ minDiscountPct: 25 }), product));
  assert.ok(groupMatches(group({ keywords: ['oled'], maxPriceSek: 7000 }), product));
  assert.ok(!groupMatches(group({ keywords: ['oled'], maxPriceSek: 6999 }), product));
  assert.ok(groupMatches(group({ keywords: ['oled'], inStockOnly: true }), product));
  assert.ok(!groupMatches(group({ keywords: ['oled'], inStockOnly: true }), { ...product, inStock: false }));
  assert.ok(!groupMatches(group({}), product));
  assert.ok(!groupMatches(group({ keywords: ['oled'], enabled: false }), product));
});

// ── Diffing: seeding, alerts, dedupe, gone ─────────────────────

test('the first check records everything silently and builds the category catalog', () => {
  const state = createEmptyWebhallenState();
  const out = apply(state, [
    page('deals', [compact(1), compact(2)]),
    page('outlet', [compact('395586', { webQty: 0, storeQty: 1, categoryTree: 'Fyndvaror/Datorer & Tillbehör/Datortillbehör/Datorskärm Bildskärm' })]),
  ], cfg(), T0);
  assert.equal(out.alerts.length, 0);
  assert.equal(out.newCount, 3);
  assert.deepEqual(out.okFeeds, ['deals', 'outlet']);
  assert.deepEqual(out.feedCounts, { deals: 2, outlet: 1 });
  assert.ok(state.seededFeeds.deals && state.seededFeeds.outlet);
  assert.ok(state.seededGroups['g-mon'].deals && state.seededGroups['g-mon'].outlet);
  assert.ok(Object.values(state.products).every((r) => r.seeded));
  assert.equal(state.catalog[MONITORS].name, 'Datorer & Tillbehör / Bildskärmar');
  assert.deepEqual(state.catalog[MONITORS].counts, { deals: 2, outlet: 1 });
});

test('new, price-drop and back-in-stock alerts fire for matching items', () => {
  const state = createEmptyWebhallenState();
  const config = cfg({ notifyPriceDropPercent: 5 });
  const laptopTree = 'Datorer & Tillbehör/Laptop Bärbar dator';
  apply(state, [page('deals', [
    compact(1, { price: 2000, listPrice: 3000 }),
    compact(2, { webQty: 0 }),
    compact(3, { categoryTree: laptopTree }),
  ])], config, T0);

  const out = apply(state, [page('deals', [
    compact(1, { price: 1850, listPrice: 3000 }), // −7.5% from 2000
    compact(2, { webQty: 4 }), // back in stock
    compact(3, { categoryTree: laptopTree, price: 100 }), // not a monitor: no alert
    compact(4), // new monitor
    compact(5, { categoryTree: laptopTree }), // new laptop: no alert
  ])], config, T1);
  const byId = Object.fromEntries(out.alerts.map((a) => [a.product.id, a]));
  assert.deepEqual(Object.keys(byId).sort(), ['1', '2', '4']);
  assert.equal(byId['4'].reason, 'new');
  assert.deepEqual(byId['4'].groupNames, ['Monitors']);
  assert.equal(byId['1'].reason, 'price-drop');
  assert.equal(byId['1'].previousPriceSek, 2000);
  assert.equal(byId['1'].dropPercent, 7.5);
  assert.equal(byId['2'].reason, 'back-in-stock');

  // Small further drop doesn't alert, then accumulates past 5%.
  const small = apply(state, [page('deals', [compact(1, { price: 1800, listPrice: 3000 }), compact(2, { webQty: 4 }), compact(3, { categoryTree: laptopTree }), compact(4), compact(5, { categoryTree: laptopTree })])], config, T2);
  assert.equal(small.alerts.length, 0);
  const more = apply(state, [page('deals', [compact(1, { price: 1750, listPrice: 3000 }), compact(2, { webQty: 4 }), compact(3, { categoryTree: laptopTree }), compact(4), compact(5, { categoryTree: laptopTree })])], config, T3);
  assert.equal(more.alerts.length, 1);
  assert.equal(more.alerts[0].previousPriceSek, 1850);
});

test('a product matching several groups gets one alert naming them all', () => {
  const state = createEmptyWebhallenState();
  const config = cfg({
    groups: [
      { id: 'a', name: 'Monitors', categories: [MONITORS] },
      { id: 'b', name: 'OLED', keywords: ['oled'] },
      { id: 'c', name: 'Laptops', categories: [LAPTOPS] },
    ],
  });
  apply(state, [page('deals', [compact(1)])], config, T0);
  const out = apply(state, [page('deals', [compact(1), compact(2, { name: 'Samsung OLED G8' })])], config, T1);
  assert.equal(out.alerts.length, 1);
  assert.deepEqual(out.alerts[0].groupNames, ['Monitors', 'OLED']);
  assert.deepEqual(out.alerts[0].groupIds, ['a', 'b']);
});

test('new groups, groups that gain a feed and new feeds seed silently', () => {
  const state = createEmptyWebhallenState();
  let config = cfg({ feeds: { deals: true, outlet: false }, groups: [] });
  apply(state, [page('deals', [compact(1)])], config, T0);

  config = cfg({ feeds: { deals: true, outlet: false }, groups: [{ id: 'g', name: 'Mon', categories: [MONITORS], feeds: 'deals' }] });
  const first = apply(state, [page('deals', [compact(1), compact(2)])], config, T1);
  assert.equal(first.alerts.length, 0);
  const second = apply(state, [page('deals', [compact(1), compact(2), compact(3)])], config, T2);
  assert.deepEqual(second.alerts.map((a) => a.product.id), ['3']);

  config = cfg({ groups: [{ id: 'g', name: 'Mon', categories: [MONITORS], feeds: 'both' }] });
  const outlet = apply(state, [page('deals', [compact(1), compact(2), compact(3)]), page('outlet', [compact('395586')])], config, T3);
  assert.equal(outlet.alerts.length, 0);
  assert.ok(state.seededFeeds.outlet);
});

test('an item is gone after two complete sweeps without it, and alerts when it returns in stock', () => {
  const state = createEmptyWebhallenState();
  const config = cfg();
  apply(state, [page('deals', [compact(1), compact(2)])], config, T0);

  apply(state, [page('deals', [compact(1)])], config, T1);
  assert.equal(state.products['deals:2'].misses, 1);
  assert.equal(state.products['deals:2'].missingSince, null);

  // Incomplete sweep (page 2 of 2 missing) does not count as a miss.
  apply(state, [page('deals', [compact(1)], { total: 300, pageSize: 250 })], config, T1);
  assert.equal(state.feedStats.deals.complete, false);
  assert.equal(state.products['deals:2'].misses, 1);

  apply(state, [page('deals', [compact(1)])], config, T2);
  assert.equal(state.products['deals:2'].missingSince, T2);

  const back = apply(state, [page('deals', [compact(1), compact(2)])], config, T3);
  assert.equal(back.alerts.length, 1);
  assert.equal(back.alerts[0].reason, 'back-in-stock');
  assert.equal(state.products['deals:2'].missingSince, null);
});

// ── Cost guard, interval floor, config ─────────────────────────

test('delays, cost guard and config validation', () => {
  const defaults = normalizeWebhallenConfig({});
  assert.equal(defaults.enabled, false);
  assert.deepEqual(defaults.feeds, { deals: true, outlet: true });
  assert.equal(defaults.intervalMinutes, 20);
  assert.equal(defaults.jitterPct, 40);
  assert.equal(defaults.maxMonthlyUsd, 1.5);
  assert.equal(defaults.notifyBackInStock, true);
  assert.deepEqual(DEFAULT_WEBHALLEN_CONFIG.feeds, { deals: true, outlet: true });

  const clamped = normalizeWebhallenConfig({ intervalMinutes: 0.1, jitterPct: 40 });
  assert.equal(clamped.intervalMinutes, MIN_INTERVAL_MINUTES);
  assert.equal(computeNextDelayMs({ config: clamped, random: () => 0, minDelayMs: MIN_DELAY_MS }), MIN_DELAY_MS);

  const nowMs = Date.UTC(2026, 10, 1, 0, 0, 0);
  const guard = computeCostGuard({ usage: null, config: defaults, urlCount: 10, nowMs, costModel: WEBHALLEN_COST_MODEL });
  assert.equal(guard.maxMonthlyUsd, 1.5);
  assert.ok(guard.projectedMonthUsd <= 1.5 + 1e-9);

  assert.equal(validateWebhallenConfigPatch({ enabled: true }), null);
  assert.match(validateWebhallenConfigPatch([]), /object/);
  assert.match(validateWebhallenConfigPatch({ feeds: { kampanj: true } }), /Unknown Webhallen feed/);
  assert.match(validateWebhallenConfigPatch({ groups: [{ categories: ['!bad!'] }] }), /!bad!/);

  const pub = publicWebhallenConfig({ discordWebhookUrl: 'https://discord.com/api/webhooks/1/secret-token' });
  assert.ok(!JSON.stringify(pub).includes('secret-token'));
  assert.equal(pub.discordWebhookConfigured, true);
});

// ── Poller & persistence ───────────────────────────────────────

function makeHarness({ config = cfg(), responses = [], persistence, now = (() => { let t = Date.parse(T0); return () => (t += 1000); })() } = {}) {
  const queue = [...responses];
  const sent = [];
  const fetchCalls = [];
  let current = config;
  const poller = createWebhallenPoller({
    getConfig: () => current,
    notifier: {
      async notifyWebhallen({ alerts }) {
        sent.push(...alerts);
        return { sent: alerts.length, failed: 0, skipped: 0, delivered: alerts.map(() => true) };
      },
    },
    persistence,
    fetchPages: async ({ feeds }) => {
      fetchCalls.push(feeds);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    fetchRunUsage: async () => null,
    logger: silentLogger,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    random: () => 0.5,
    now,
  });
  return { poller, sent, fetchCalls, setConfig: (next) => { current = next; } };
}

const run = (pages, usd = 0.0005, id = `run-${Math.random()}`) => ({ run: { id, status: 'SUCCEEDED', usageTotalUsd: usd }, pages });

test('the poller plans pages from the last sweep, seeds, alerts and persists across restarts', async () => {
  let saved = null;
  const persistence = { load: () => (saved ? JSON.parse(saved) : null), save: (value) => { saved = JSON.stringify(value); } };
  const h = makeHarness({
    persistence,
    responses: [
      run([page('deals', [compact(1)], { total: 520 }), page('outlet', [compact('395586')])], 0.0005, 'r1'),
      run([page('deals', [compact(1)], { total: 521 }), page('deals', [compact(2)], { n: 2, total: 521 }), page('deals', [compact(3)], { n: 3, total: 521 }), page('outlet', [compact('395586')])], 0.0006, 'r2'),
    ],
  });
  const first = await h.poller.pollNow();
  assert.equal(first.alertCount, 0);
  assert.deepEqual(h.fetchCalls[0], [{ id: 'deals', pages: 1 }, { id: 'outlet', pages: 1 }]);

  const second = await h.poller.pollNow();
  assert.deepEqual(h.fetchCalls[1], [{ id: 'deals', pages: 3 }, { id: 'outlet', pages: 1 }], 'ceil(520/250) = 3 pages');
  assert.equal(second.alertCount, 2);
  assert.deepEqual(h.sent.map((a) => a.product.id).sort(), ['2', '3']);

  const after = makeHarness({
    persistence,
    responses: [run([page('deals', [compact(1), compact(2), compact(3), compact(4)]), page('outlet', [compact('395586')])])],
  });
  await after.poller.pollNow();
  assert.deepEqual(after.sent.map((a) => a.product.id), ['4']);
});

// ── Discord ────────────────────────────────────────────────────

test('notifyWebhallen posts labelled embeds with image URLs, in batches, without mentions', async () => {
  const originalFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, init) => {
    posts.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 204, headers: { get: () => null } };
  };
  try {
    const notifier = new DiscordNotifier({ webhookUrl: 'https://discord.com/api/webhooks/1/global', cooldownHours: 1 });
    const outlet = mapWebhallenProduct(compactWebhallenProductForTest(whRaw(395586, {
      name: 'ASUS ROG Swift OLED (Fyndvara klass 1)',
      mainTitle: 'ASUS ROG Swift OLED',
      price: { price: '7490.00' },
      regularPrice: { price: '9990.00' },
      stock: { web: 0, '2': 1 },
      fyndwareOf: { id: 359001 },
    })), 'outlet');
    const res = await notifier.notifyWebhallen({
      alerts: [{ reason: 'new', product: outlet, feed: 'outlet', groupNames: ['Monitors'] }],
      webhookUrl: '',
    });
    assert.deepEqual(res.delivered, [true]);
    const body = posts[0].body;
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.match(body.content, /Webhallen outlet.*new find/);
    const embed = body.embeds[0];
    assert.equal(embed.title, 'ASUS ROG Swift OLED (Fyndvara klass 1)');
    assert.equal(embed.url, 'https://www.webhallen.com/se/product/395586-ASUS-ROG-Swift-OLED');
    assert.equal(embed.image.url, 'https://www.webhallen.com/images/product/359001?trim');
    const field = (name) => embed.fields.find((f) => f.name === name)?.value;
    assert.equal(field('Feed'), 'Fyndvaror');
    assert.match(field('Condition'), /Fyndvara klass 1 — Nyskick/);
    assert.match(field('Stock'), /1 in store/);
    assert.equal(field('Category'), 'Datorer & Tillbehör / Bildskärmar');
    assert.equal(field('Watch group'), 'Monitors');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Listing & Routes ───────────────────────────────────────────

test('Webhallen items join the listing as two stores, and routes + UI tab work end to end', async () => {
  assert.equal(webhallenConditionLabel('Fyndvara klass 1 — Nyskick'), 'Fyndvara klass 1');
  assert.equal(webhallenConditionLabel('Fyndvara klass 2 — Gott skick'), 'Fyndvara klass 2');
  assert.equal(webhallenConditionLabel('Fyndvara klass 3 — Använt skick'), 'Fyndvara klass 3');
  assert.equal(webhallenConditionLabel(''), 'Fyndvara');

  const watcher = createEmptyWebhallenState();
  applyWebhallenPages({
    state: watcher,
    pages: [
      page('deals', [compact(391001, { name: 'ASUS Prime B650', categoryTree: 'Datorkomponenter/Moderkort', listPrice: 2090, price: 1490, webQty: 15 })]),
      page('outlet', [compactWebhallenProductForTest(whRaw(395586, { name: 'LG UltraGear 27 OLED (Fyndvara klass 1)', mainTitle: 'LG UltraGear 27 OLED' }))]),
    ],
    config: cfg(),
    nowIso: T0,
  });

  const state = createDefaultState();
  // Ensure old archived webhallen-fyndware rows stay hidden when reconciled.
  mergeObservations(state, [{
    sourceId: 'webhallen-fyndware', sourceLabel: 'Webhallen Fyndvaror (archived)', externalId: 'old1', title: 'Old',
    url: 'https://www.webhallen.com/se/product/1', priceSek: 100, condition: 'outlet', seenAt: T0,
  }]);
  reconcileStateWithSources(state, [WEBHALLEN_DEALS_SOURCE_ID, WEBHALLEN_OUTLET_SOURCE_ID]);

  const result = syncWebhallenListing({ state, watcherState: watcher, config: cfg() });
  assert.equal(result.listed, 2);
  assert.deepEqual(result.newKeys.sort(), ['webhallen-deals:391001', 'webhallen-outlet:395586']);

  const obs = webhallenRecordToObservation(watcher.products['outlet:395586'], { catalog: watcher.catalog });
  assert.equal(obs.category, 'Datorer & Tillbehör / Bildskärmar');
  assert.equal(obs.condition, 'outlet');
  assert.equal(obs.conditionLabel, 'Fyndvara klass 1');
  assert.equal(obs.referencePriceSek, 3299);
  assert.equal(obs.availability, 'few_left');

  const cache = new ProductCache();
  cache.rebuild(state, new Map([[WEBHALLEN_DEALS_SOURCE_ID, 'Webhallen deals'], [WEBHALLEN_OUTLET_SOURCE_ID, 'Webhallen outlet']]));

  let stored = normalizeWebhallenConfig({ discordWebhookUrl: 'https://discord.com/api/webhooks/9/keep-me' });
  let polls = 0;
  const catalog = [{ id: MONITORS, name: 'Datorer & Tillbehör / Bildskärmar', count: 5, counts: { deals: 2, outlet: 3 } }];
  const app = await buildApp({
    config: { publicDir, sources: [] },
    store: { getState: () => state },
    productCache: cache,
    webhallen: {
      getConfig: () => stored,
      update: async (next) => { stored = next; return next; },
      getStatus: () => ({ enabled: stored.enabled, costGuard: {} }),
      getCatalog: () => catalog,
      pollNow: async () => { polls += 1; return { count: 2283 }; },
    },
  });

  const all = (await app.inject({ method: 'GET', url: '/api/outlet-products?pageSize=100' })).json();
  assert.equal(all.total, 2, 'archived webhallen-fyndware item stays hidden');
  const stores = (await app.inject({ method: 'GET', url: '/api/outlet-sources' })).json();
  assert.deepEqual(stores.map((s) => s.id).sort(), ['webhallen-deals', 'webhallen-outlet']);

  const overview = (await app.inject({ method: 'GET', url: '/api/webhallen' })).json();
  assert.deepEqual(overview.catalog, catalog);
  assert.ok(!JSON.stringify(overview).includes('keep-me'));
  assert.equal(overview.config.discordWebhookConfigured, true);

  assert.equal((await app.inject({ method: 'POST', url: '/api/webhallen/config', payload: { groups: [{ categories: ['!bad!'] }] } })).statusCode, 400);
  const saved = await app.inject({
    method: 'POST',
    url: '/api/webhallen/config',
    payload: {
      enabled: true,
      intervalMinutes: 25,
      discordWebhookUrl: overview.config.discordWebhookUrl,
      groups: [{ id: 'g1', name: 'Monitors', feeds: 'outlet', keywords: ['OLED'], categories: [MONITORS], inStockOnly: true }],
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(stored.intervalMinutes, 25);
  assert.equal(stored.discordWebhookUrl, 'https://discord.com/api/webhooks/9/keep-me');
  assert.deepEqual(stored.groups[0].categories, [MONITORS]);

  const poll = await app.inject({ method: 'POST', url: '/api/webhallen/poll' });
  assert.equal(poll.json().result.count, 2283);
  assert.equal(polls, 1);

  const html = (await app.inject({ method: 'GET', url: '/' })).body;
  assert.match(html, /panel="webhallen"/);
  assert.match(html, /id="tab-webhallen"/);

  await app.close();
});
