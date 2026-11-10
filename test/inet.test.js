import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INET_MAX_PAGES_PER_FEED,
  INET_PAGE_FUNCTION,
  buildInetFeedUrl,
  extractInetHydrateForTest,
  fetchInetPages,
  inetPagesFor,
  mapInetProduct,
  resolveInetApifyToken,
} from '../src/sources/inet.js';
import {
  DEFAULT_INET_CONFIG,
  MIN_INTERVAL_MINUTES,
  normalizeInetConfig,
  publicInetConfig,
  validateInetConfigPatch,
} from '../src/services/inetConfig.js';
import {
  FULL_SWEEP_INTERVAL_MS,
  INET_COST_MODEL,
  MIN_DELAY_MS,
  applyInetPages,
  createEmptyInetState,
  createInetPoller,
  foldText,
  groupMatches,
  keywordMatchesTitle,
} from '../src/services/inetPoller.js';
import { computeCostGuard, computeNextDelayMs } from '../src/services/komplettDemoPoller.js';
import {
  INET_DEALS_SOURCE_ID,
  INET_OUTLET_SOURCE_ID,
  inetConditionLabel,
  inetRecordToObservation,
  syncInetListing,
} from '../src/services/inetListing.js';
import { DiscordNotifier } from '../src/services/notifier.js';
import { SqliteStore, createDefaultState, reconcileStateWithSources } from '../src/lib/store.js';
import { mergeObservations } from '../src/services/dealEngine.js';
import { ProductCache } from '../src/services/productCache.js';
import { buildApp } from '../src/app.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const silentLogger = { error() {}, warn() {}, log() {}, info() {} };
const MONITORS = '1';
const LAPTOPS = '8';
const T0 = '2026-11-05T08:00:00.000Z';
const T1 = '2026-11-05T08:20:00.000Z';
const T2 = '2026-11-05T08:40:00.000Z';
const T3 = '2026-11-05T09:00:00.000Z';

// ── Fixtures ───────────────────────────────────────────────────

/** A raw product as Inet embeds it (trimmed to realistic fields). */
function inetRaw(id, overrides = {}) {
  return {
    id,
    name: `Product ${id}`,
    urlName: `product-${id}`,
    image: `${String(id).replace(/\D/g, '')}_0.jpg`,
    releaseDate: '2026-10-12T10:45:17.9430000',
    templateId: 1,
    categoryId: 1506,
    manufacturerId: 150,
    price: { listPrice: 3299, price: 2399, listPriceExVat: 2639.2, priceExVat: 1919.2 },
    qty: { '00': { qty: 0, blocked: false }, '11': { qty: 1, blocked: false } },
    sellingPoint: 'Öppnad förpackning, komplett med alla tillbehör.',
    bargainParentId: '6302740',
    isBargain: true,
    reviewScore: 4.5,
    reviewCount: 12,
    purchaseStatus: 'Purchasable',
    ...overrides,
  };
}

/** Server-rendered page with the view model in hydrate("<Page>", JSON.parse("…")). */
function inetHtml(pageName, viewModel) {
  const data = { productListWithDynamicFilterViewModel: viewModel, seo: { title: 'Fyndhörnan' } };
  // A JS string literal like Inet's: JSON-escaped, with </ and non-ASCII escaped.
  const jsString = JSON.stringify(JSON.stringify(data))
    .replace(/<\//g, '<\\/')
    .replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `<!doctype html><html><head><title>Fyndhörnan | Inet.se</title></head><body>
    <div id="header"></div><script>hydrate("SiteHeader", JSON.parse("{\\"cart\\":0}"), document.getElementById("header"));</script>
    <div id="root"></div><script>hydrate("${pageName}", JSON.parse(${jsString}), document.getElementById("root"));</script>
  </body></html>`;
}

/** A page as returned by the Apify page function (compact products). */
function compact(id, overrides = {}) {
  return {
    id: String(id),
    name: `Product ${id}`,
    urlName: `product-${id}`,
    image: `${String(id).replace(/\D/g, '')}_0.jpg`,
    templateId: 1,
    categoryId: 1506,
    manufacturerId: 150,
    listPrice: 3299,
    price: 2399,
    webQty: 5,
    webBlocked: false,
    storeQty: 0,
    sellingPoint: null,
    isBargain: false,
    bargainParentId: null,
    releaseDate: null,
    purchaseStatus: 'Purchasable',
    ...overrides,
  };
}

function page(feed, products, { n = 1, ids = products.map((p) => p.id), templates } = {}) {
  return {
    feed,
    page: n,
    found: true,
    pageSize: 60,
    total: ids.length,
    products,
    ...(n === 1 ? { productIds: ids, templates: templates ?? [{ id: 1, name: 'Bildskärmar', facetCount: 2 }, { id: 8, name: 'Bärbara datorer', facetCount: 1 }] } : {}),
  };
}

function cfg(overrides = {}) {
  return normalizeInetConfig({
    enabled: true,
    groups: [{ id: 'g-mon', name: 'Monitors', categories: [MONITORS] }],
    ...overrides,
  });
}

function apply(state, pages, config, nowIso, extra = {}) {
  return applyInetPages({ state, pages, config, nowIso, ...extra });
}

// ── Extraction, mapping, planning ──────────────────────────────

test('the hydrate extractor decodes the JSON-in-a-JS-string view model', () => {
  const html = inetHtml('BargainPage', {
    page: 1,
    pageSize: 60,
    productIds: ['x1', 'x2'],
    products: { x1: inetRaw('x1', { name: 'Samsung 49" Odyssey G9 – "OLED" </script> ÅÄÖ' }), x2: inetRaw('x2') },
    filterOptions: { templates: [{ id: 1, name: 'Bildskärmar', facetCount: 2 }], manufacturers: [], properties: [], price: {} },
  });
  const out = extractInetHydrateForTest(html, 'BargainPage');
  assert.equal(out.pageName, 'BargainPage');
  const vm = out.data.productListWithDynamicFilterViewModel;
  assert.deepEqual(vm.productIds, ['x1', 'x2']);
  assert.equal(vm.products.x1.name, 'Samsung 49" Odyssey G9 – "OLED" </script> ÅÄÖ');
  assert.equal(vm.filterOptions.templates[0].name, 'Bildskärmar');

  // The named page wins over other hydrate() calls; a missing one is reported.
  assert.equal(extractInetHydrateForTest(html, 'CampaignsPage').pageName, 'BargainPage', 'falls back to any page with a product list');
  assert.equal(extractInetHydrateForTest('<html>Access denied</html>', 'BargainPage').data, null);
});

test('the page function returns compact products; page 1 adds ids and templates and enqueues extra pages', async () => {
  const ids = Array.from({ length: 130 }, (_, i) => `x${i}`);
  const html = inetHtml('BargainPage', {
    page: 1, pageSize: 60, productIds: ids,
    products: { x1: inetRaw('x1'), x2: inetRaw('x2', { qty: { '00': { qty: 3, blocked: false } } }) },
    filterOptions: { templates: [{ id: 1, name: 'Bildskärmar', facetCount: 7 }, { id: 8, name: 'Bärbara datorer', facetCount: 11 }] },
  });
  // eslint-disable-next-line no-new-func
  const pageFunction = new Function(`${INET_PAGE_FUNCTION}; return pageFunction;`)();
  const enqueued = [];
  const userData = { feed: 'outlet', page: 1, hydrate: 'BargainPage', baseUrl: 'https://www.inet.se/fyndhornan', plannedPages: 1, maxPages: 15 };
  const out = await pageFunction({
    body: html,
    request: { url: 'https://www.inet.se/fyndhornan', userData },
    response: { statusCode: 200 },
    enqueueRequest: async (request) => enqueued.push(request),
  });
  assert.equal(out.found, true);
  assert.equal(out.feed, 'outlet');
  assert.equal(out.total, 130);
  assert.equal(out.productIds.length, 130);
  assert.deepEqual(out.templates, [{ id: 1, name: 'Bildskärmar', facetCount: 7 }, { id: 8, name: 'Bärbara datorer', facetCount: 11 }]);
  assert.equal(out.products.length, 2);
  const p = out.products.find((x) => x.id === 'x1');
  assert.deepEqual(
    { listPrice: p.listPrice, price: p.price, webQty: p.webQty, storeQty: p.storeQty, sellingPoint: p.sellingPoint },
    { listPrice: 3299, price: 2399, webQty: 0, storeQty: 1, sellingPoint: 'Öppnad förpackning, komplett med alla tillbehör.' },
  );
  assert.equal(p.reviewScore, undefined, 'only the fields the watcher needs');
  assert.deepEqual(enqueued.map((r) => r.url), ['https://www.inet.se/fyndhornan?page=2', 'https://www.inet.se/fyndhornan?page=3']);
  assert.deepEqual(enqueued.map((r) => r.userData.page), [2, 3]);

  // A later page carries no id list or facets and enqueues nothing.
  enqueued.length = 0;
  const second = await pageFunction({ body: html, request: { url: 'u?page=2', userData: { ...userData, page: 2 } }, enqueueRequest: async (r) => enqueued.push(r) });
  assert.equal(second.productIds, undefined);
  assert.equal(second.templates, undefined);
  assert.equal(enqueued.length, 0);

  const blocked = await pageFunction({
    body: '<html><title>Just a moment...</title></html>',
    request: { url: 'u', userData },
    $: () => ({ first: () => ({ text: () => 'Just a moment...' }) }),
  });
  assert.equal(blocked.found, false);
  assert.equal(blocked.title, 'Just a moment...');
});

test('mapInetProduct builds URLs, prices, discount and stock', () => {
  const outlet = mapInetProduct(compact('x255588', {
    name: 'ASUS ROG Zephyrus G14 - ASUS OPEN', urlName: 'asus-rog-zephyrus-g14', image: '1979070_q4ugvd.jpg',
    listPrice: 37990, price: 32999, webQty: 0, storeQty: 1, sellingPoint: '  Öppnad förpackning,   komplett. ', templateId: 8,
  }), 'outlet');
  assert.equal(outlet.url, 'https://www.inet.se/produkt/x255588/asus-rog-zephyrus-g14');
  assert.equal(outlet.imageUrl, 'https://cdn.inet.se/product/500x500/1979070_q4ugvd.jpg');
  assert.equal(outlet.priceSek, 32999);
  assert.equal(outlet.listPriceSek, 37990);
  assert.equal(outlet.discountPct, 13);
  assert.equal(outlet.inWebStock, false);
  assert.equal(outlet.inStock, true, 'an outlet unit held in a store is in stock');
  assert.equal(outlet.templateId, '8');
  assert.equal(outlet.sellingPoint, 'Öppnad förpackning, komplett.');

  const deal = mapInetProduct(compact(1903697, { listPrice: 1149, price: 1149, webQty: 0, storeQty: 0 }), 'deals');
  assert.equal(deal.listPriceSek, null, 'no ordinary price when it is not above the current one');
  assert.equal(deal.discountPct, 0);
  assert.equal(deal.inStock, false);
  assert.equal(mapInetProduct(compact(1, { webBlocked: true }), 'deals').inWebStock, false);
  assert.equal(mapInetProduct({ id: '1' }, 'deals'), null);
  assert.equal(mapInetProduct(compact(1), 'nope'), null);
});

test('page planning covers the feed size, clamped; one Apify run fetches every page', async () => {
  assert.equal(inetPagesFor(null), 1);
  assert.equal(inetPagesFor(60), 1);
  assert.equal(inetPagesFor(61), 2);
  assert.equal(inetPagesFor(389), 7);
  assert.equal(inetPagesFor(269), 5);
  assert.equal(inetPagesFor(100_000), INET_MAX_PAGES_PER_FEED);
  assert.equal(buildInetFeedUrl('outlet', 1), 'https://www.inet.se/fyndhornan');
  assert.equal(buildInetFeedUrl('deals', 3), 'https://www.inet.se/kampanjer?page=3');

  const calls = [];
  class StubClient {
    constructor({ token }) { this.token = token; }
    actor(name) { return { call: async (input, options) => { calls.push({ name, input, options }); return { id: 'r1', status: 'SUCCEEDED', usageTotalUsd: 0.001, defaultDatasetId: 'd1' }; } }; }
    dataset() { return { listItems: async () => ({ items: [{ feed: 'deals', page: 1, found: true, products: [] }] }) }; }
  }
  const result = await fetchInetPages({ feeds: [{ id: 'outlet', pages: 7 }, { id: 'deals', pages: 1 }], token: 't', ApifyClientClass: StubClient });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'apify/cheerio-scraper');
  assert.deepEqual(calls[0].input.proxyConfiguration, { useApifyProxy: true });
  assert.equal(calls[0].options.memory, 256);
  assert.equal(calls[0].input.pageFunction, INET_PAGE_FUNCTION);
  assert.equal(calls[0].input.startUrls.length, 8);
  assert.ok(calls[0].input.startUrls.every((u) => u.url.startsWith('https://www.inet.se/')));
  assert.deepEqual(calls[0].input.startUrls.filter((u) => u.userData.feed === 'outlet').map((u) => u.userData.page), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(calls[0].input.startUrls[0].userData.plannedPages, 7);
  assert.equal(calls[0].input.startUrls.at(-1).userData.hydrate, 'CampaignsPage');
  assert.ok(calls[0].input.maxRequestsPerCrawl >= 2 * INET_MAX_PAGES_PER_FEED);
  assert.equal(result.run.usageTotalUsd, 0.001);
  assert.equal(result.pages.length, 1);

  await assert.rejects(() => fetchInetPages({ feeds: [], token: 't', ApifyClientClass: StubClient }), /No Inet feeds/);
  await assert.rejects(() => fetchInetPages({ feeds: [{ id: 'deals', pages: 1 }], token: '', ApifyClientClass: StubClient }), /No Apify token/);
});

test('resolveInetApifyToken prioritizes APIFY_TOKEN_INET over APIFY_TOKEN', () => {
  const origInet = process.env.APIFY_TOKEN_INET;
  const origDefault = process.env.APIFY_TOKEN;
  try {
    delete process.env.APIFY_TOKEN_INET;
    delete process.env.APIFY_TOKEN;
    assert.equal(resolveInetApifyToken(), '');

    process.env.APIFY_TOKEN = 'fallback-token';
    assert.equal(resolveInetApifyToken(), 'fallback-token');

    process.env.APIFY_TOKEN_INET = 'inet-token';
    assert.equal(resolveInetApifyToken(), 'inet-token');
  } finally {
    if (origInet !== undefined) process.env.APIFY_TOKEN_INET = origInet;
    else delete process.env.APIFY_TOKEN_INET;
    if (origDefault !== undefined) process.env.APIFY_TOKEN = origDefault;
    else delete process.env.APIFY_TOKEN;
  }
});

// ── Matching ───────────────────────────────────────────────────

test('keyword matching ignores case and diacritics; strict needs whole words', () => {
  assert.equal(foldText('Skärm ÖVERSIKT Ål'), 'skarm oversikt al');
  assert.ok(keywordMatchesTitle('skarm', 'Bärbar Skärm 15"'));
  assert.ok(keywordMatchesTitle('BÄRBAR', 'barbar skarm'));
  assert.ok(keywordMatchesTitle('rtx 5090', 'ASUS ROG Astral GeForce RTX™ 5090 OC'));
  assert.ok(keywordMatchesTitle('rtx5090', 'MSI GeForce RTX 5090 Gaming'), 'letters and digits split');
  assert.ok(keywordMatchesTitle('RTX 5090', 'Gigabyte RTX5090 Windforce'));
  assert.ok(keywordMatchesTitle('32 gb', 'Kingston FURY 32GB DDR5'));
  assert.ok(keywordMatchesTitle('5090 asus', 'ASUS TUF RTX 5090'), 'any word order');

  // Strict (default): whole words only.
  assert.equal(keywordMatchesTitle('5090', 'Inno3D RTX 5090D'), true, '5090D splits into 5090 + d');
  assert.equal(keywordMatchesTitle('ram', 'Corsair Ramverk 4000D'), false);
  assert.equal(keywordMatchesTitle('rtx 5090', 'ASUS RTX 5080 TUF'), false);
  assert.equal(keywordMatchesTitle('pro', 'Epson projektor'), false);
  assert.equal(keywordMatchesTitle('macbook pro', 'Apple MacBook Neo - 13" | A18 Pro | 8GB | 256GB | Indigo'), false);
  assert.equal(keywordMatchesTitle('macbook pro', 'Apple MacBook Pro - 14,2" | M5 Pro | 24GB | 2TB'), true);
  assert.equal(keywordMatchesTitle('PS5 Pro', 'Razer Wolverine V2 PRO Wireless PS5 & PC'), false);
  assert.equal(keywordMatchesTitle('PS5 Pro', 'Sony PS5 Pro 2TB'), true);
  assert.equal(keywordMatchesTitle('iPad Air 11', 'Apple iPad Air M4 11" / Wi-Fi 128GB'), true);
  assert.equal(keywordMatchesTitle('iPad Air 11', 'Apple iPad Air 13" / Wi-Fi 128GB'), false);
  // Loose: substrings.
  assert.equal(keywordMatchesTitle('ram', 'Corsair Ramverk 4000D', { strict: false }), true);
  assert.equal(keywordMatchesTitle('pro', 'Epson projektor', { strict: false }), true);
  assert.equal(keywordMatchesTitle('', 'anything'), false);
});

test('groups match on feed, keywords, categories and the value filters', () => {
  const product = mapInetProduct(compact('x9', { name: 'LG 27GR95QE OLED skärm', templateId: 1, listPrice: 10000, price: 7000, webQty: 0, storeQty: 1 }), 'outlet');
  const group = (overrides) => normalizeInetConfig({ groups: [{ id: 'g', name: 'G', ...overrides }] }).groups[0];

  assert.ok(groupMatches(group({ keywords: ['oled'] }), product));
  assert.ok(groupMatches(group({ keywords: ['qd-oled', 'Skarm'] }), product), 'any keyword');
  assert.ok(!groupMatches(group({ keywords: ['mini led'] }), product));
  assert.ok(groupMatches(group({ categories: [MONITORS, LAPTOPS] }), product));
  assert.ok(!groupMatches(group({ categories: [LAPTOPS] }), product));
  assert.ok(!groupMatches(group({ categories: [MONITORS], keywords: ['qd'] }), product), 'categories AND keywords');

  assert.ok(groupMatches(group({ keywords: ['oled'], feeds: 'outlet' }), product));
  assert.ok(!groupMatches(group({ keywords: ['oled'], feeds: 'deals' }), product));

  assert.ok(groupMatches(group({ keywords: ['oled'], minDiscountPct: 30 }), product));
  assert.ok(!groupMatches(group({ keywords: ['oled'], minDiscountPct: 31 }), product));
  assert.ok(groupMatches(group({ minDiscountPct: 25 }), product), 'a min discount alone is a valid group');
  assert.ok(groupMatches(group({ keywords: ['oled'], maxPriceSek: 7000 }), product));
  assert.ok(!groupMatches(group({ keywords: ['oled'], maxPriceSek: 6999 }), product));
  assert.ok(groupMatches(group({ keywords: ['oled'], inStockOnly: true }), product), 'store stock counts');
  assert.ok(!groupMatches(group({ keywords: ['oled'], inStockOnly: true }), { ...product, inStock: false }));

  assert.ok(!groupMatches(group({}), product), 'a group without criteria matches nothing');
  assert.ok(!groupMatches(group({ keywords: ['oled'], enabled: false }), product));
});

// ── Diffing: seeding, alerts, dedupe, gone ─────────────────────

test('the first check records everything silently', () => {
  const state = createEmptyInetState();
  const out = apply(state, [page('deals', [compact(1), compact(2)]), page('outlet', [compact('x1', { webQty: 0, storeQty: 1 })])], cfg(), T0);
  assert.equal(out.alerts.length, 0);
  assert.equal(out.newCount, 3);
  assert.deepEqual(out.okFeeds, ['deals', 'outlet']);
  assert.deepEqual(out.feedCounts, { deals: 2, outlet: 1 });
  assert.ok(state.seededFeeds.deals && state.seededFeeds.outlet);
  assert.ok(state.seededGroups['g-mon'].deals && state.seededGroups['g-mon'].outlet);
  assert.ok(Object.values(state.products).every((r) => r.seeded));
  assert.equal(state.catalog[MONITORS].name, 'Bildskärmar');
  assert.equal(state.catalog[MONITORS].counts.deals, 2);
});

test('new, price-drop and back-in-stock alerts fire for matching items', () => {
  const state = createEmptyInetState();
  const config = cfg({ notifyPriceDropPercent: 5 });
  apply(state, [page('deals', [compact(1, { price: 2000, listPrice: 3000 }), compact(2, { webQty: 0 }), compact(3, { templateId: 8 })])], config, T0);

  const out = apply(state, [page('deals', [
    compact(1, { price: 1850, listPrice: 3000 }), // −7.5% from 2000
    compact(2, { webQty: 4 }), // back in stock
    compact(3, { templateId: 8, price: 100 }), // not a monitor: no alert
    compact(4), // new monitor
    compact(5, { templateId: 8 }), // new, but not a monitor
  ])], config, T1);
  const byId = Object.fromEntries(out.alerts.map((a) => [a.product.id, a]));
  assert.deepEqual(Object.keys(byId).sort(), ['1', '2', '4']);
  assert.equal(byId['4'].reason, 'new');
  assert.deepEqual(byId['4'].groupNames, ['Monitors']);
  assert.equal(byId['1'].reason, 'price-drop');
  assert.equal(byId['1'].previousPriceSek, 2000);
  assert.equal(byId['1'].dropPercent, 7.5);
  assert.equal(byId['2'].reason, 'back-in-stock');

  // The baseline moved to the alerted price; a small further drop doesn't alert…
  const small = apply(state, [page('deals', [compact(1, { price: 1800, listPrice: 3000 }), compact(2, { webQty: 4 }), compact(3, { templateId: 8 }), compact(4), compact(5, { templateId: 8 })])], config, T2);
  assert.equal(small.alerts.length, 0);
  // …but small drops accumulate: 1850 → 1750 is −5.4%.
  const more = apply(state, [page('deals', [compact(1, { price: 1750, listPrice: 3000 }), compact(2, { webQty: 4 }), compact(3, { templateId: 8 }), compact(4), compact(5, { templateId: 8 })])], config, T3);
  assert.equal(more.alerts.length, 1);
  assert.equal(more.alerts[0].previousPriceSek, 1850);
});

test('price-drop threshold: per group, global, or off', () => {
  const state = createEmptyInetState();
  const config = cfg({
    notifyPriceDropPercent: 0,
    groups: [
      { id: 'a', name: 'Cheap watch', categories: [MONITORS], priceDropPct: 10 },
      { id: 'b', name: 'Global watch', keywords: ['product'] },
    ],
  });
  apply(state, [page('deals', [compact(1, { price: 1000 })])], config, T0);
  const nine = apply(state, [page('deals', [compact(1, { price: 910 })])], config, T1);
  assert.equal(nine.alerts.length, 0, 'group a needs 10%, global is off for b');
  const ten = apply(state, [page('deals', [compact(1, { price: 900 })])], config, T2);
  assert.equal(ten.alerts.length, 1);
  assert.deepEqual(ten.alerts[0].groupNames, ['Cheap watch']);
  assert.equal(ten.alerts[0].dropPercent, 10);
});

test('a product matching several groups gets one alert naming them all', () => {
  const state = createEmptyInetState();
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
  const state = createEmptyInetState();
  let config = cfg({ feeds: { deals: true, outlet: false }, groups: [] });
  apply(state, [page('deals', [compact(1)])], config, T0);

  // A group added now sees item 2 for the first time: recorded, no alert.
  config = cfg({ feeds: { deals: true, outlet: false }, groups: [{ id: 'g', name: 'Mon', categories: [MONITORS], feeds: 'deals' }] });
  const first = apply(state, [page('deals', [compact(1), compact(2)])], config, T1);
  assert.equal(first.alerts.length, 0);
  const second = apply(state, [page('deals', [compact(1), compact(2), compact(3)])], config, T2);
  assert.deepEqual(second.alerts.map((a) => a.product.id), ['3']);

  // Switching on the outlet feed, and the group to both feeds: silent first look.
  config = cfg({ groups: [{ id: 'g', name: 'Mon', categories: [MONITORS], feeds: 'both' }] });
  const outlet = apply(state, [page('deals', [compact(1), compact(2), compact(3)]), page('outlet', [compact('x1')])], config, T3);
  assert.equal(outlet.alerts.length, 0);
  assert.ok(state.seededFeeds.outlet);

  // Disabling the group forgets its seed.
  apply(state, [page('deals', [compact(1)])], cfg({ groups: [{ id: 'g', name: 'Mon', categories: [MONITORS], enabled: false }] }), T3);
  assert.equal(state.seededGroups.g, undefined);
});

test('a manual check while disabled records silently', () => {
  const state = createEmptyInetState();
  apply(state, [page('deals', [compact(1)])], cfg(), T0);
  const out = apply(state, [page('deals', [compact(1), compact(2)])], cfg({ enabled: false }), T1, { alertsEnabled: false });
  assert.equal(out.alerts.length, 0);
  assert.ok(state.products['deals:2'].seeded);
});

test('items listed on the previous sweep are not "new" after a failed page', () => {
  const state = createEmptyInetState();
  const ids = Array.from({ length: 70 }, (_, i) => String(i + 1));
  // Page 2 (item 61) failed on the first sweep, but page 1 listed its id.
  apply(state, [page('deals', [compact(1)], { ids }), { feed: 'deals', page: 2, found: false }], cfg(), T0);
  assert.equal(state.feedStats.deals.complete, false);
  const out = apply(state, [page('deals', [compact(1)], { ids }), page('deals', [compact(61)], { ids, n: 2 })], cfg(), T1);
  assert.equal(state.feedStats.deals.complete, true);
  assert.equal(out.alerts.length, 0);
  assert.ok(state.products['deals:61'].seeded);
});

test('an item is gone after two complete sweeps without it, and alerts when it returns in stock', () => {
  const state = createEmptyInetState();
  const config = cfg();
  apply(state, [page('deals', [compact(1), compact(2)])], config, T0);

  apply(state, [page('deals', [compact(1)])], config, T1);
  assert.equal(state.products['deals:2'].misses, 1);
  assert.equal(state.products['deals:2'].missingSince, null);

  // An incomplete sweep (page 1 failed) doesn't count as a miss.
  apply(state, [{ ...page('deals', [compact(1)], { n: 2 }) }], config, T1);
  assert.equal(state.products['deals:2'].misses, 1);

  // Listed in page 1's id list but not fetched: not missing.
  apply(state, [page('deals', [compact(1)], { ids: ['1', '2'] })], config, T2);
  assert.equal(state.products['deals:2'].misses, 0);

  apply(state, [page('deals', [compact(1)])], config, T2);
  apply(state, [page('deals', [compact(1)])], config, T3);
  assert.equal(state.products['deals:2'].missingSince, T3);

  const back = apply(state, [page('deals', [compact(1), compact(2)])], config, '2026-11-05T10:00:00.000Z');
  assert.equal(back.alerts.length, 1);
  assert.equal(back.alerts[0].reason, 'back-in-stock');
  assert.equal(state.products['deals:2'].missingSince, null);
});

test('a feed whose pages all failed is reported and not seeded', () => {
  const state = createEmptyInetState();
  const out = apply(state, [page('deals', [compact(1)]), { feed: 'outlet', page: 1, found: false, title: 'Access denied' }], cfg(), T0);
  assert.deepEqual(out.okFeeds, ['deals']);
  assert.deepEqual(out.failedFeeds, ['outlet']);
  assert.equal(state.seededFeeds.outlet, undefined);
  assert.match(state.feedStats.outlet.lastError, /Access denied/);
  assert.ok(out.warnings.some((w) => /Fyndhörnan/.test(w)));
});

// ── Cost guard, interval floor ─────────────────────────────────

test('delays respect the 30-second floor and the jitter', () => {
  const config = normalizeInetConfig({ intervalMinutes: 0.1, jitterPct: 40 });
  assert.equal(config.intervalMinutes, MIN_INTERVAL_MINUTES);
  const at = (r) => computeNextDelayMs({ config, random: () => r, minDelayMs: MIN_DELAY_MS });
  assert.equal(at(0), MIN_DELAY_MS, 'jitter never goes below the floor');
  assert.equal(at(1), Math.round(MIN_DELAY_MS * 1.4));

  const defaults = normalizeInetConfig({});
  const lo = computeNextDelayMs({ config: defaults, random: () => 0, minDelayMs: MIN_DELAY_MS });
  const hi = computeNextDelayMs({ config: defaults, random: () => 1, minDelayMs: MIN_DELAY_MS });
  assert.equal(lo, 12 * 60_000);
  assert.equal(hi, 28 * 60_000);
  const backoff = computeNextDelayMs({ config: defaults, consecutiveFailures: 5, random: () => 0.5, minDelayMs: MIN_DELAY_MS });
  assert.equal(backoff, 60 * 60_000);
});

test('the cost guard stretches the interval to fit the $1.5 cap', () => {
  const config = normalizeInetConfig({});
  const nowMs = Date.UTC(2026, 10, 1, 0, 0, 0);
  // 12 pages/check ≈ $0.001: every 20 min would be ≈ $2.1/month.
  const guard = computeCostGuard({ usage: null, config, urlCount: 12, nowMs, costModel: INET_COST_MODEL });
  assert.equal(guard.maxMonthlyUsd, 1.5);
  assert.equal(guard.stretched, true);
  assert.ok(guard.intervalMs > 20 * 60_000);
  assert.ok(guard.projectedMonthUsd <= 1.5 + 1e-9);

  const spent = computeCostGuard({ usage: { month: '2026-11', usd: 1.5, runs: 1500, urls: 18000 }, config, urlCount: 12, nowMs, costModel: INET_COST_MODEL });
  assert.equal(spent.exhausted, true);
});

// ── Config ─────────────────────────────────────────────────────

test('config defaults, clamping and validation', () => {
  const defaults = normalizeInetConfig({});
  assert.equal(defaults.enabled, false);
  assert.deepEqual(defaults.feeds, { deals: true, outlet: true });
  assert.equal(defaults.intervalMinutes, 20);
  assert.equal(defaults.jitterPct, 40);
  assert.equal(defaults.maxMonthlyUsd, 1.5);
  assert.equal(defaults.notifyBackInStock, true);
  assert.deepEqual(defaults.groups, []);
  assert.deepEqual(DEFAULT_INET_CONFIG.feeds, { deals: true, outlet: true });

  const c = normalizeInetConfig({
    intervalMinutes: 9999, jitterPct: 99, maxMonthlyUsd: 0, notifyPriceDropPercent: 200,
    feeds: { outlet: false },
    groups: [{ id: 'a', name: '  GPUs ', keywords: ['RTX 5090', 'rtx 5090', ' ', 'B580'], categories: ['7', 7, 'x', '8'], feeds: 'weird', minDiscountPct: '', maxPriceSek: '15000', priceDropPct: '' }, { id: 'a' }],
  });
  assert.equal(c.intervalMinutes, 240);
  assert.equal(c.jitterPct, 50);
  assert.equal(c.maxMonthlyUsd, 0.1);
  assert.equal(c.notifyPriceDropPercent, 90);
  assert.deepEqual(c.feeds, { deals: true, outlet: false });
  const g = c.groups[0];
  assert.equal(g.name, 'GPUs');
  assert.deepEqual(g.keywords, ['RTX 5090', 'B580']);
  assert.deepEqual(g.categories, ['7', '8']);
  assert.equal(g.feeds, 'both');
  assert.equal(g.minDiscountPct, null);
  assert.equal(g.maxPriceSek, 15000);
  assert.equal(g.priceDropPct, null);
  assert.equal(g.strictKeywordMatch, true);
  assert.notEqual(c.groups[1].id, 'a', 'duplicate group ids are replaced');

  // A partial update keeps the rest.
  const partial = normalizeInetConfig({ enabled: true }, c);
  assert.equal(partial.intervalMinutes, 240);
  assert.equal(partial.groups.length, 2);

  assert.equal(validateInetConfigPatch({ enabled: true }), null);
  assert.match(validateInetConfigPatch([]), /object/);
  assert.match(validateInetConfigPatch({ feeds: { kampanj: true } }), /Unknown Inet feed/);
  assert.match(validateInetConfigPatch({ groups: {} }), /array/);
  assert.match(validateInetConfigPatch({ groups: [{ categories: ['abc'] }] }), /abc/);
  assert.match(validateInetConfigPatch({ groups: [{ feeds: 'all' }] }), /feeds/);
  assert.match(validateInetConfigPatch({ groups: [{ keywords: 'rtx' }] }), /keywords/);

  const pub = publicInetConfig({ discordWebhookUrl: 'https://discord.com/api/webhooks/1/secret-token' });
  assert.ok(!JSON.stringify(pub).includes('secret-token'));
  assert.equal(pub.discordWebhookConfigured, true);
});

// ── Poller ─────────────────────────────────────────────────────

function makeHarness({ config = cfg(), responses = [], persistence, now = (() => { let t = Date.parse(T0); return () => (t += 1000); })() } = {}) {
  const queue = [...responses];
  const sent = [];
  const fetchCalls = [];
  let current = config;
  const poller = createInetPoller({
    getConfig: () => current,
    notifier: {
      async notifyInet({ alerts }) {
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

const run = (pages, usd = 0.001, id = `run-${Math.random()}`) => ({ run: { id, status: 'SUCCEEDED', usageTotalUsd: usd }, pages });

test('the poller plans pages from the last sweep, seeds, alerts and tracks spend', async () => {
  const ids = Array.from({ length: 130 }, (_, i) => String(i + 1));
  const h = makeHarness({
    responses: [
      run([page('deals', [compact(1)], { ids }), page('outlet', [compact('x1')])], 0.001, 'r1'),
      run([page('deals', [compact(1), compact(131)], { ids: [...ids, '131'] }), page('outlet', [compact('x1')])], 0.0011, 'r2'),
    ],
  });
  const first = await h.poller.pollNow();
  assert.equal(first.alertCount, 0);
  assert.deepEqual(h.fetchCalls[0], [{ id: 'deals', pages: 1 }, { id: 'outlet', pages: 1 }], 'first run: page 1 discovers the rest');

  const second = await h.poller.pollNow();
  assert.deepEqual(h.fetchCalls[1], [{ id: 'deals', pages: 3 }, { id: 'outlet', pages: 1 }], 'then ceil(130/60) pages');
  assert.equal(second.alertCount, 1);
  assert.equal(h.sent[0].product.id, '131');

  const status = h.poller.getStatus();
  assert.equal(status.costGuard.runs, 2);
  assert.ok(Math.abs(status.costGuard.spentUsd - 0.0021) < 1e-9);
  assert.equal(status.recentAlerts[0].id, '131');
  assert.deepEqual(status.recentAlerts[0].groupNames, ['Monitors']);
  assert.equal(status.feeds.find((f) => f.id === 'deals').total, 131);
  assert.equal(status.groups[0].matches, 3);
  assert.equal(status.latestFinds[0].id, '131');
  assert.ok(status.effectiveIntervalMinutes >= 20);
  assert.deepEqual(h.poller.getCatalog().map((c) => c.name), ['Bildskärmar', 'Bärbara datorer'], 'Swedish order: ä after z');
});

test('Page-1 delta polling fetches only Page 1 between hourly full sweeps and enqueues only pages with new IDs', async () => {
  const ids = Array.from({ length: 130 }, (_, i) => String(i + 1));
  let nowMs = Date.parse(T0);
  const h = makeHarness({
    now: () => nowMs,
    responses: [
      // Run 1: complete 3-page full sweep of deals (130 items) + 1-page outlet
      run([
        page('deals', [compact(1)], { n: 1, ids }),
        page('deals', [compact(61)], { n: 2, ids }),
        page('deals', [compact(121)], { n: 3, ids }),
        page('outlet', [compact('x1')]),
      ], 0.0005, 'r1'),
      // Run 2 (5 min later): delta check (only page 1 needed)
      run([
        { ...page('deals', [compact(1)], { n: 1, ids }), delta: true, deltaPages: [] },
        page('outlet', [compact('x1')]),
      ], 0.0003, 'r2'),
      // Run 3 (65 min after Run 1): full sweep again
      run([
        page('deals', [compact(1)], { n: 1, ids }),
        page('deals', [compact(61)], { n: 2, ids }),
        page('deals', [compact(121)], { n: 3, ids }),
        page('outlet', [compact('x1')]),
      ], 0.0005, 'r3'),
    ],
  });

  await h.poller.pollNow();
  assert.equal(h.poller.getState().feedStats.deals.complete, true);

  // 5 minutes later: plans a 1-page delta check for deals
  nowMs += 5 * 60_000;
  await h.poller.pollNow();
  assert.deepEqual(h.fetchCalls[1], [
    { id: 'deals', pages: 1, delta: true, knownIds: ids },
    { id: 'outlet', pages: 1 },
  ]);

  // 61 minutes after Run 1: full sweep is due again
  nowMs += FULL_SWEEP_INTERVAL_MS;
  await h.poller.pollNow();
  assert.deepEqual(h.fetchCalls[2], [
    { id: 'deals', pages: 3 },
    { id: 'outlet', pages: 1 },
  ]);

  // Verify INET_PAGE_FUNCTION in delta mode only enqueues pages with unseen IDs
  // eslint-disable-next-line no-new-func
  const pageFunction = new Function(`${INET_PAGE_FUNCTION}; return pageFunction;`)();
  const updatedIds = [...ids.slice(0, 60), 'new-on-page-2', ...ids.slice(61)];
  const html = inetHtml('CampaignsPage', {
    page: 1,
    pageSize: 60,
    productIds: updatedIds,
    products: { '1': inetRaw('1') },
    filterOptions: { templates: [] },
  });
  const enqueued = [];
  const out = await pageFunction({
    body: html,
    request: {
      url: 'https://www.inet.se/kampanjer',
      userData: {
        feed: 'deals',
        page: 1,
        hydrate: 'CampaignsPage',
        baseUrl: 'https://www.inet.se/kampanjer',
        plannedPages: 1,
        maxPages: 15,
        delta: true,
        knownIds: ids,
      },
    },
    response: { statusCode: 200 },
    enqueueRequest: async (req) => enqueued.push(req),
  });
  assert.equal(out.delta, true);
  assert.deepEqual(out.deltaPages, [2], 'only page 2 has an unseen ID; page 3 is skipped');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].url, 'https://www.inet.se/kampanjer?page=2');
});

test('a blocked run fails, the cost still counts, and the poller needs a feed', async () => {
  const h = makeHarness({ responses: [run([{ feed: 'deals', page: 1, found: false }, { feed: 'outlet', page: 1, found: false }], 0.0005)] });
  await assert.rejects(() => h.poller.pollNow(), /No Inet page returned product data/);
  const status = h.poller.getStatus();
  assert.equal(status.costGuard.runs, 1);
  assert.equal(status.consecutiveFailures, 1);

  h.setConfig(cfg({ feeds: { deals: false, outlet: false } }));
  await assert.rejects(() => h.poller.pollNow(), /Enable at least one Inet feed/);
});

test('state persists across a restart so nothing re-alerts', async () => {
  let saved = null;
  const persistence = { load: () => (saved ? JSON.parse(saved) : null), save: (value) => { saved = JSON.stringify(value); } };
  const before = makeHarness({
    persistence,
    responses: [run([page('deals', [compact(1)])]), run([page('deals', [compact(1), compact(2)])])],
  });
  await before.poller.pollNow();
  await before.poller.pollNow();
  assert.equal(before.sent.length, 1);

  const after = makeHarness({ persistence, responses: [run([page('deals', [compact(1), compact(2), compact(3)])])] });
  const status = after.poller.getStatus();
  assert.equal(status.costGuard.runs, 2);
  assert.equal(status.recentAlerts.length, 1);
  assert.equal(status.feeds.find((f) => f.id === 'deals').seeded, true);
  await after.poller.pollNow();
  assert.deepEqual(after.sent.map((a) => a.product.id), ['3']);
});

test('SqliteStore keeps the inet record in its own row', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spw-inet-test-'));
  try {
    const store = new SqliteStore(path.join(dir, 'store.db'));
    await store.load();
    store.saveRecord('inet', { products: { 'deals:1': { id: '1' } } });
    await store.save({ skipItems: true });
    const reloaded = new SqliteStore(path.join(dir, 'store.db'));
    await reloaded.load();
    assert.deepEqual(reloaded.loadRecord('inet'), { products: { 'deals:1': { id: '1' } } });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── Discord ────────────────────────────────────────────────────

test('notifyInet posts labelled embeds with the image URL, in batches, without mentions', async () => {
  const originalFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, init) => {
    posts.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 204, headers: { get: () => null } };
  };
  try {
    const notifier = new DiscordNotifier({ webhookUrl: 'https://discord.com/api/webhooks/1/global', cooldownHours: 1 });
    const outlet = mapInetProduct(compact('x255588', { name: 'ASUS ROG Zephyrus G14', listPrice: 37990, price: 32999, webQty: 0, storeQty: 1, sellingPoint: 'Öppnad förpackning, komplett med alla tillbehör.', image: '1979070_q4ugvd.jpg', templateId: 8 }), 'outlet');
    const res = await notifier.notifyInet({
      alerts: [{ reason: 'new', product: outlet, feed: 'outlet', groupNames: ['Laptops', 'ROG'] }],
      webhookUrl: '',
      catalog: { 8: { name: 'Bärbara datorer' } },
    });
    assert.deepEqual(res.delivered, [true]);
    assert.equal(posts[0].url, 'https://discord.com/api/webhooks/1/global', 'falls back to the global webhook');
    assert.equal(posts[0].init.headers['content-type'], 'application/json', 'no attachments');
    const body = posts[0].body;
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.ok(!/@everyone|@here/.test(JSON.stringify(body)));
    assert.match(body.content, /Inet outlet.*new find/);
    const embed = body.embeds[0];
    assert.equal(embed.title, 'ASUS ROG Zephyrus G14');
    assert.equal(embed.url, 'https://www.inet.se/produkt/x255588/product-x255588');
    assert.equal(embed.image.url, 'https://cdn.inet.se/product/500x500/1979070_q4ugvd.jpg');
    const field = (name) => embed.fields.find((f) => f.name === name)?.value;
    assert.match(field('Price'), /32.999/);
    assert.match(field('Ordinary'), /37.990.*−13%/);
    assert.equal(field('Feed'), 'Fyndhörnan');
    assert.match(field('Condition'), /Öppnad förpackning/);
    assert.match(field('Stock'), /1 in store/);
    assert.equal(field('Category'), 'Bärbara datorer');
    assert.equal(field('Watch groups'), 'Laptops, ROG');
    assert.match(embed.footer.text, /Inet outlet/);

    posts.length = 0;
    const deal = mapInetProduct(compact(1903697, { price: 1149, listPrice: 2090, webQty: 50 }), 'deals');
    const drop = await notifier.notifyInet({
      alerts: [{ reason: 'price-drop', product: deal, feed: 'deals', groupNames: ['Mobo'], previousPriceSek: 1290, dropPercent: 10.9 }],
      webhookUrl: 'https://discord.com/api/webhooks/2/own',
    });
    assert.equal(drop.sent, 1);
    assert.equal(posts[0].url, 'https://discord.com/api/webhooks/2/own');
    assert.match(posts[0].body.content, /Inet deal.*price drop 10.9%/);
    assert.equal(posts[0].body.embeds[0].fields.find((f) => f.name === 'Feed').value, 'Kampanj');
    assert.ok(!posts[0].body.embeds[0].fields.some((f) => f.name === 'Condition'), 'no condition for campaign items');
    assert.match(posts[0].body.embeds[0].description, /Price drop 10.9% \(was 1.290/);

    posts.length = 0;
    const many = Array.from({ length: 12 }, (_, i) => ({ reason: 'new', product: mapInetProduct(compact(100 + i), 'deals'), feed: i % 2 ? 'deals' : 'outlet', groupNames: ['G'] }));
    const batched = await notifier.notifyInet({ alerts: many, webhookUrl: '' });
    assert.equal(batched.sent, 12);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.embeds.length, 10);
    assert.equal(posts[1].body.embeds.length, 2);
    assert.match(posts[0].body.content, /\*\*Inet\*\* — 10 updates/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const none = await new DiscordNotifier({ webhookUrl: '', cooldownHours: 1 }).notifyInet({ alerts: [{ reason: 'new', product: { id: '1' }, feed: 'deals' }] });
  assert.equal(none.reason, 'no-webhook');
  assert.deepEqual(none.delivered, [false]);
});

// ── Listing ────────────────────────────────────────────────────

function watcherWith(pages, config = cfg()) {
  const state = createEmptyInetState();
  applyInetPages({ state, pages, config, nowIso: T0 });
  return state;
}

test('outlet conditions are bucketed into a few labels', () => {
  const cases = {
    'Öppnad förpackning, komplett med alla tillbehör.': 'Öppnad förpackning',
    'Oöppnad förpackning.': 'Oöppnad förpackning',
    'Demoexemplar, Spår av användning förekommer, som t.ex. repor och skavmärken.': 'Demoexemplar',
    'Ersättningsprodukt från tillverkaren. Saknar originalförpackning, i övrigt komplett med alla tillbehör.': 'Ersättningsprodukt',
    'Öppnad förpackning, komplett med alla tillbehör, små kosmetiska repor på fram och baksidan.': 'Spår av användning',
    'Skadad förpackning, komplett med alla tillbehör.': 'Skadad förpackning',
    'EJ original förpackning, komplett med alla tillbehör.': 'Ej originalförpackning',
    'Ej i originalkartong': 'Ej originalförpackning',
    'Kommer i förpackning av annan modell': 'Ej originalförpackning',
    'Enbart hörlurar och case': 'Saknar tillbehör',
    '': 'Fyndhörnan',
    'Något helt annat': 'Fyndhörnan',
  };
  for (const [text, label] of Object.entries(cases)) assert.equal(inetConditionLabel(text), label, text);
});

test('Inet items join the listing as two stores, searchable and filterable', async () => {
  const watcher = watcherWith([
    page('deals', [compact(1903697, { name: 'ASUS Prime B550M-A WIFI II', templateId: 117, listPrice: 2090, price: 1149, webQty: 50, sellingPoint: 'mATX-kort för Ryzen' })],
      { templates: [{ id: 117, name: 'Moderkort', facetCount: 1 }] }),
    page('outlet', [compact('x255588', { name: 'ASUS ROG Zephyrus G14 RTX 5070', templateId: 8, listPrice: 37990, price: 32999, webQty: 0, storeQty: 1, sellingPoint: 'Öppnad förpackning, komplett med alla tillbehör.' })]),
  ]);
  const state = createDefaultState();
  const result = syncInetListing({ state, watcherState: watcher, config: cfg() });
  assert.equal(result.listed, 2);
  assert.deepEqual(result.newKeys.sort(), ['inet-deals:1903697', 'inet-outlet:x255588']);
  assert.equal(state.items['inet-outlet:x255588'].firstSeenAt, T0);

  const obs = inetRecordToObservation(watcher.products['outlet:x255588'], { catalog: watcher.catalog });
  assert.equal(obs.category, 'Bärbara datorer');
  assert.equal(obs.condition, 'outlet');
  assert.equal(obs.conditionLabel, 'Öppnad förpackning');
  assert.equal(obs.referencePriceSek, 37990);
  assert.equal(obs.availability, 'few_left');

  const cache = new ProductCache();
  cache.rebuild(state, new Map([[INET_DEALS_SOURCE_ID, 'Inet deals'], [INET_OUTLET_SOURCE_ID, 'Inet outlet']]));
  const app = await buildApp({ config: { publicDir, sources: [] }, store: { getState: () => state }, productCache: cache });
  const all = (await app.inject({ method: 'GET', url: '/api/outlet-products?pageSize=100' })).json();
  assert.equal(all.total, 2);
  const deal = all.items.find((p) => p.sourceId === 'inet-deals');
  assert.equal(deal.sourceLabel, 'Inet deals');
  assert.equal(deal.category, 'Moderkort');
  assert.equal(deal.conditionLabel, 'Kampanj');
  assert.equal(deal.currentPriceSek, 1149);
  assert.equal(deal.availability, 'in_stock');
  assert.equal(deal.imageUrl, 'https://cdn.inet.se/product/500x500/1903697_0.jpg');
  const search = (await app.inject({ method: 'GET', url: '/api/outlet-products?search=zephyrus' })).json();
  assert.deepEqual(search.items.map((p) => p.listingKey), ['inet-outlet:x255588']);
  const stores = (await app.inject({ method: 'GET', url: '/api/outlet-sources' })).json();
  assert.deepEqual(stores.map((s) => s.id).sort(), ['inet-deals', 'inet-outlet']);
  await app.close();

  // A switched-off feed and a gone item leave the listing; history is archived.
  watcher.products['deals:1903697'].missingSince = T1;
  const after = syncInetListing({ state, watcherState: watcher, config: cfg({ feeds: { deals: true, outlet: false } }) });
  assert.deepEqual(after.deletedKeys.sort(), ['inet-deals:1903697', 'inet-outlet:x255588']);
  assert.equal(Object.keys(state.items).length, 0);
  assert.ok(state.itemHistory['inet-outlet:x255588'].history.length);
});

test('startup backfills the listing from the saved inet record', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inet-listing-'));
  const dbPath = path.join(dir, 'store.db');
  try {
    const before = new SqliteStore(dbPath);
    await before.load();
    mergeObservations(before.getState(), [{
      sourceId: 'inet-fyndhornan', sourceLabel: 'Inet Fyndhörnan (archived)', externalId: 'x1', title: 'Old', url: 'https://www.inet.se/produkt/x1',
      priceSek: 100, condition: 'outlet', seenAt: T0,
    }]);
    await before.save();
    before.saveRecord('inet', watcherWith([page('deals', [compact(1), compact(2)]), page('outlet', [compact('x1')])]));

    const store = new SqliteStore(dbPath);
    await store.load();
    reconcileStateWithSources(store.getState(), ['inet-deals', 'inet-outlet']);
    const poller = createInetPoller({
      getConfig: () => cfg(),
      persistence: { load: () => store.loadRecord('inet'), save: (v) => store.saveRecord('inet', v) },
      logger: silentLogger, setTimeoutFn: () => 0, clearTimeoutFn: () => {},
    });
    const result = syncInetListing({ state: store.getState(), watcherState: poller.getState(), config: cfg(), getItemHistory: (k) => store.getItemHistory(k) });
    store.flushItems(result.changedKeys, result.deletedKeys);
    assert.equal(result.listed, 3);
    const cache = new ProductCache();
    cache.rebuild(store.getState());
    assert.equal(cache.query({}).total, 3, 'the archived inet-fyndhornan row stays hidden');

    const again = new SqliteStore(dbPath);
    await again.load();
    reconcileStateWithSources(again.getState(), ['inet-deals', 'inet-outlet']);
    const second = syncInetListing({ state: again.getState(), watcherState: poller.getState(), config: cfg() });
    assert.equal(second.newCount, 0);
    assert.deepEqual(second.deletedKeys, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── Routes ─────────────────────────────────────────────────────

test('Inet routes: overview, config validation, masked webhook, catalog, poll', async () => {
  const state = createDefaultState();
  const cache = new ProductCache();
  cache.rebuild(state);
  let stored = normalizeInetConfig({ discordWebhookUrl: 'https://discord.com/api/webhooks/9/keep-me' });
  let polls = 0;
  const catalog = [{ id: '1', name: 'Bildskärmar', count: 9, counts: { deals: 2, outlet: 7 } }];
  const app = await buildApp({
    config: { publicDir, sources: [] },
    store: { getState: () => state },
    productCache: cache,
    inet: {
      getConfig: () => stored,
      update: async (next) => { stored = next; return next; },
      getStatus: () => ({ enabled: stored.enabled, costGuard: {} }),
      getCatalog: () => catalog,
      pollNow: async () => { polls += 1; return { count: 658 }; },
    },
  });

  const overview = (await app.inject({ method: 'GET', url: '/api/inet' })).json();
  assert.deepEqual(overview.catalog, catalog);
  assert.ok(!JSON.stringify(overview).includes('keep-me'));
  assert.equal(overview.config.discordWebhookConfigured, true);
  assert.equal(overview.limits.minIntervalMinutes, MIN_INTERVAL_MINUTES);

  assert.equal((await app.inject({ method: 'POST', url: '/api/inet/config', payload: { groups: [{ categories: ['bad'] }] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/inet/config', payload: { discordWebhookUrl: 'https://evil.example.com/x' } })).statusCode, 400);

  const saved = await app.inject({
    method: 'POST',
    url: '/api/inet/config',
    payload: {
      enabled: true, intervalMinutes: 30, discordWebhookUrl: overview.config.discordWebhookUrl,
      groups: [{ id: 'g1', name: 'Monitors', feeds: 'outlet', keywords: ['OLED'], categories: ['1'], inStockOnly: true }],
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(stored.intervalMinutes, 30);
  assert.equal(stored.discordWebhookUrl, 'https://discord.com/api/webhooks/9/keep-me');
  assert.deepEqual(stored.groups[0].categories, ['1']);
  assert.equal(stored.groups[0].feeds, 'outlet');
  assert.ok(!JSON.stringify(saved.json()).includes('keep-me'));

  await app.inject({ method: 'PUT', url: '/api/inet', payload: { discordWebhookUrl: '' } });
  assert.equal(stored.discordWebhookUrl, '');
  assert.equal(stored.groups.length, 1, 'a partial update keeps the groups');

  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/inet/catalog' })).json(), catalog);
  assert.equal((await app.inject({ method: 'GET', url: '/api/inet/status' })).json().enabled, true);
  assert.equal((await app.inject({ method: 'GET', url: '/api/inet/config' })).json().config.intervalMinutes, 30);
  const poll = await app.inject({ method: 'POST', url: '/api/inet/poll' });
  assert.equal(poll.json().result.count, 658);
  assert.equal(polls, 1);
  await app.close();

  const without = await buildApp({ config: { publicDir, sources: [] }, store: { getState: () => state }, productCache: cache });
  assert.equal((await without.inject({ method: 'GET', url: '/api/inet' })).statusCode, 404);
  await without.close();
});
