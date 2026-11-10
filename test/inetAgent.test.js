import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INET_AGENT_USER_AGENT,
  fetchInetAgentPages,
  lookupInetAgentProducts,
  mapAgentListItem,
} from '../src/sources/inetAgent.js';
import {
  classifyTemplate,
  resolveInetTemplates,
  specSignature,
} from '../src/services/inetTemplates.js';
import { createEmptyInetState, createInetPoller } from '../src/services/inetPoller.js';
import { normalizeInetConfig } from '../src/services/inetConfig.js';
import { resolveWatcherProxyUrl } from '../src/services/watcherProxy.js';

const silentLogger = { error() {}, warn() {}, log() {}, info() {} };
const PROXY = 'socks5://u-erik:pw@proxy.invalid:1080';
const noSleep = async () => {};
const T0 = '2026-11-10T16:00:00.000Z';

// ── Fixtures (shapes as the API answered on 2026-11-10) ────────

function campaignItem(id, overrides = {}) {
  return {
    productId: String(id),
    name: `Product ${id}`,
    manufacturer: 'Maker',
    priceIncVat: 1149.0,
    ordinaryPriceIncVat: 2090.0,
    discountPercent: 45,
    campaignEndsAt: '2026-11-12T23:59:59+01:00',
    currency: 'SEK',
    inWebStock: true,
    url: `https://www.inet.se/produkt/${id}/product-${id}`,
    ...overrides,
  };
}

function bargainItem(id, parent, overrides = {}) {
  return {
    productId: String(id),
    name: `Bargain ${id}`,
    manufacturer: 'Maker',
    condition: 'Öppnad förpackning, komplett med alla tillbehör.',
    priceIncVat: 99.0,
    ordinaryPriceIncVat: 299.0,
    discountPercent: 67,
    currency: 'SEK',
    parentProductId: String(parent),
    bargainVariantCount: 1,
    inWebStock: false,
    pickupStores: ['Göteborg, Sisjön'],
    url: `https://www.inet.se/produkt/${id}/bargain-${id}`,
    ...overrides,
  };
}

function detail(id, fields) {
  return {
    productId: String(id),
    name: `Product ${id}`,
    specifications: Object.entries(fields).map(([name, specs]) => ({
      name,
      specifications: specs.map((spec) => ({ name: spec, value: 'x' })),
    })),
  };
}

const GPU_SPECS = { GPU: ['Grafikprocessor', 'Boost'], Minne: ['Minnesstorlek', 'Minnestyp'], Utgångar: ['HDMI', 'DisplayPort'] };
const BOARD_SPECS = { Allmänt: ['Chipset', 'Processorsocket', 'Formfaktor'], Minne: ['Internminnestyp', 'Antalet platser'] };

/** A proxy fetch serving `routes` (path+query → { status, body }), recording calls. */
function fakeProxy(routes) {
  const calls = [];
  const proxyFetch = async (url, options) => {
    calls.push({ url, options });
    const key = url.replace('https://www.inet.se/agent/guest/v1', '');
    const route = routes[key] ?? { status: 404, body: '' };
    return { statusCode: route.status ?? 200, body: typeof route.body === 'string' ? route.body : JSON.stringify(route.body) };
  };
  return { calls, proxyFetch };
}

const listPage = (key, items, totalCount, page = 1) => ({ body: { [key]: items, totalCount, page, pageSize: 10 } });

// ── Fetching ───────────────────────────────────────────────────

test('the agent fetcher sweeps every list page of both feeds through the proxy and maps the items', async () => {
  const deals = Array.from({ length: 12 }, (_, i) => campaignItem(1000 + i));
  const { calls, proxyFetch } = fakeProxy({
    '/campaigns/products?page=1': listPage('products', deals.slice(0, 10), 12),
    '/campaigns/products?page=2': listPage('products', deals.slice(10), 12, 2),
    '/bargains/products?page=1': listPage('bargains', [bargainItem('x1', 5000)], 1),
  });
  let sleeps = 0;
  const result = await fetchInetAgentPages({
    feeds: [{ id: 'deals', pages: 1 }, { id: 'outlet', pages: 1 }],
    proxyUrl: PROXY, proxyFetch, logger: silentLogger, sleep: async () => { sleeps += 1; },
  });

  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.options.proxyUrl === PROXY), 'every request goes through the proxy');
  assert.ok(calls.every((c) => c.options.headers['user-agent'] === INET_AGENT_USER_AGENT));
  assert.equal(sleeps, 2, 'a pause between requests');
  assert.equal(result.source, 'agent');
  assert.deepEqual(result.run, { ...result.run, id: null, status: 'PROXY', usageTotalUsd: 0 });

  const [dealsPage, outletPage] = result.pages;
  assert.equal(dealsPage.found, true);
  assert.equal(dealsPage.products.length, 12);
  assert.deepEqual(dealsPage.productIds, deals.map((d) => d.productId));
  assert.equal(dealsPage.total, 12);
  assert.ok(dealsPage.pageSize >= 12, 'one aggregated page covers the feed');
  assert.equal(outletPage.products[0].bargainParentId, '5000');
});

test('an agent list item maps to the scraper\'s compact product shape', () => {
  assert.deepEqual(mapAgentListItem(campaignItem(1903697), 'deals'), {
    id: '1903697', name: 'Product 1903697', urlName: 'product-1903697', image: null,
    templateId: null, categoryId: null, manufacturerId: null,
    listPrice: 2090, price: 1149, webQty: 1, webBlocked: false, storeQty: 0,
    sellingPoint: null, isBargain: false, bargainParentId: null, releaseDate: null,
    purchaseStatus: null, campaignEndsAt: '2026-11-12T23:59:59+01:00',
  });
  const outlet = mapAgentListItem(bargainItem('x9', 77, { pickupStores: ['A', 'B'] }), 'outlet');
  assert.equal(outlet.storeQty, 2, 'outlet units are counted per pickup store');
  assert.equal(outlet.webQty, 0);
  assert.equal(outlet.sellingPoint, 'Öppnad förpackning, komplett med alla tillbehör.');
  assert.equal(outlet.isBargain, true);
  assert.equal(mapAgentListItem({ name: 'no id' }, 'deals'), null);
});

test('a failed list page leaves the feed partial, so nothing is counted as gone, and a 429 stops the feed', async () => {
  const { calls, proxyFetch } = fakeProxy({
    '/campaigns/products?page=1': listPage('products', [campaignItem(1)], 30),
    '/campaigns/products?page=2': { status: 429, body: '' },
    '/campaigns/products?page=3': listPage('products', [campaignItem(3)], 30, 3),
  });
  const { pages } = await fetchInetAgentPages({
    feeds: [{ id: 'deals' }], proxyUrl: PROXY, proxyFetch, logger: silentLogger, sleep: noSleep,
  });
  assert.equal(calls.length, 2, 'page 3 is never requested after the 429');
  assert.equal(pages[0].found, true);
  assert.equal(pages[0].partial, true);
  assert.equal('productIds' in pages[0], false);
  assert.match(pages[0].error, /429/);
});

test('a feed whose first page fails is reported as not found', async () => {
  const { proxyFetch } = fakeProxy({ '/bargains/products?page=1': { status: 403, body: '<html>' } });
  const { pages } = await fetchInetAgentPages({ feeds: [{ id: 'outlet' }], proxyUrl: PROXY, proxyFetch, logger: silentLogger, sleep: noSleep });
  assert.equal(pages[0].found, false);
  assert.match(pages[0].error, /403/);
});

test('the agent fetcher refuses to call inet.se without a proxy', async () => {
  const { calls, proxyFetch } = fakeProxy({});
  await assert.rejects(
    fetchInetAgentPages({ feeds: [{ id: 'deals' }], proxyUrl: '', proxyFetch, logger: silentLogger, sleep: noSleep }),
    /home IP/,
  );
  assert.equal(calls.length, 0);
});

test('Inet falls back to the Elgiganten NordVPN proxy, and its own setting wins', () => {
  const nord = 'socks5://u-erik:pw@nord.invalid:1080';
  assert.equal(resolveWatcherProxyUrl('INET', { ELGIGANTEN_PROXY_URL: nord }), nord);
  assert.equal(resolveWatcherProxyUrl('INET', { ELGIGANTEN_PROXY_URL: nord, WATCHER_PROXY_URL: 'http://shared.invalid:8080' }), 'http://shared.invalid:8080');
  assert.equal(resolveWatcherProxyUrl('INET', { ELGIGANTEN_PROXY_URL: nord, INET_PROXY_URL: 'http://inet.invalid:8080' }), 'http://inet.invalid:8080');
  assert.equal(resolveWatcherProxyUrl('INET', { ELGIGANTEN_PROXY_URL: nord, INET_PROXY_URL: 'off' }), '');
  assert.equal(resolveWatcherProxyUrl('KOMPLETT', { ELGIGANTEN_PROXY_URL: nord }), '', 'Komplett does not borrow it');
});

test('product lookups go in batches of ten and report ids that were not answered', async () => {
  const ids = Array.from({ length: 23 }, (_, i) => String(i + 1));
  const batch = (list) => `/products/lookup?ids=${list.join(',')}`;
  const { calls, proxyFetch } = fakeProxy({
    [batch(ids.slice(0, 10))]: { body: { products: ids.slice(0, 9).map((id) => detail(id, GPU_SPECS)), notFound: ['10'] } },
    [batch(ids.slice(10, 20))]: { status: 500, body: '' },
  });
  const result = await lookupInetAgentProducts(ids, { proxyUrl: PROXY, proxyFetch, logger: silentLogger, sleep: noSleep });
  assert.equal(calls.length, 2, 'stops after a failed batch');
  assert.equal(result.products.size, 9);
  assert.deepEqual([...result.notFound], ['10']);
  assert.deepEqual([...result.failed], ids.slice(10));
});

// ── Categories ─────────────────────────────────────────────────

test('spec signatures pick the closest template and refuse weak matches', () => {
  const signatures = { 17: [specSignature(detail('a', GPU_SPECS))], 117: [specSignature(detail('b', BOARD_SPECS))] };
  const gpuLike = specSignature(detail('c', { ...GPU_SPECS, Kylning: ['Fläktar'] }));
  assert.equal(classifyTemplate(gpuLike, signatures), '17');
  assert.equal(classifyTemplate(specSignature(detail('d', { Övrigt: ['Färg'] })), signatures), null);
  assert.equal(classifyTemplate([], signatures), null);
});

function trackedState() {
  const state = createEmptyInetState();
  state.products = {
    'deals:5001': { key: 'deals:5001', id: '5001', feed: 'deals', templateId: '17' },
    'deals:5002': { key: 'deals:5002', id: '5002', feed: 'deals', templateId: '17' },
    'deals:1901': { key: 'deals:1901', id: '1901', feed: 'deals', templateId: '117' },
    'outlet:x1': { key: 'outlet:x1', id: 'x1', feed: 'outlet', templateId: '117', bargainParentId: '1902' },
  };
  return state;
}

const agentPage = (feed, products) => ({ feed, page: 1, found: true, products, productIds: products.map((p) => p.id), source: 'agent' });

test('known products keep their template and new ones are classified from their specifications', async () => {
  const state = trackedState();
  const pages = [
    agentPage('deals', [mapAgentListItem(campaignItem(5001), 'deals'), mapAgentListItem(campaignItem(5003), 'deals')]),
    agentPage('outlet', [mapAgentListItem(bargainItem('x2', 1902), 'outlet'), mapAgentListItem(bargainItem('x3', 7777), 'outlet')]),
  ];
  const asked = [];
  const lookup = async (ids) => {
    asked.push(ids);
    const known = { 5001: GPU_SPECS, 5002: GPU_SPECS, 1901: BOARD_SPECS, 1902: BOARD_SPECS, 5003: { ...GPU_SPECS, Ström: ['Kontakt'] }, 7777: BOARD_SPECS };
    return {
      products: new Map(ids.filter((id) => known[id]).map((id) => [id, detail(id, known[id])])),
      notFound: new Set(ids.filter((id) => !known[id])),
      failed: new Set(),
    };
  };

  const stats = await resolveInetTemplates({ state, pages, lookup, nowIso: T0, logger: silentLogger });

  const [deals, outlet] = pages;
  assert.equal(deals.products[0].templateId, '17', 'tracked product keeps its template');
  assert.equal(deals.products[1].templateId, '17', 'new GPU classified');
  assert.equal(outlet.products[0].templateId, '117', 'bargain of a tracked parent inherits its template');
  assert.equal(outlet.products[1].templateId, '117', 'bargain classified from its parent');
  assert.equal(stats.classified, 2);
  assert.ok(asked[0].includes('5003') && asked[0].includes('7777'));
  assert.ok(state.templateSignatures['17']?.length && state.templateSignatures['117']?.length, 'signatures learned');
  assert.equal(state.templateCache['5003'].templateId, '17');

  // Cached now: the next check needs no lookups at all.
  asked.length = 0;
  const again = [agentPage('deals', [mapAgentListItem(campaignItem(5003), 'deals')])];
  await resolveInetTemplates({ state, pages: again, lookup, nowIso: T0, logger: silentLogger });
  assert.equal(asked.length, 0);
  assert.equal(again[0].products[0].templateId, '17');
});

test('a product whose lookup failed is left for the next check instead of being recorded uncategorised', async () => {
  const state = trackedState();
  const pages = [agentPage('deals', [mapAgentListItem(campaignItem(5001), 'deals'), mapAgentListItem(campaignItem(6000), 'deals')])];
  const lookup = async (ids) => ({ products: new Map(), notFound: new Set(), failed: new Set(ids) });

  const stats = await resolveInetTemplates({ state, pages, lookup, nowIso: T0, logger: silentLogger });

  assert.equal(stats.deferred, 1);
  assert.deepEqual(pages[0].products.map((p) => p.id), ['5001']);
  assert.deepEqual(pages[0].productIds, ['5001']);
  assert.equal(state.templateCache['6000'], undefined, 'not cached, so it is retried');
});

// ── Poller ─────────────────────────────────────────────────────

test('switching to the agent API seeds silently once, then alerts on new matching products', async () => {
  const state = trackedState();
  // An HTML-era state that was fully seeded.
  state.seededFeeds = { deals: T0, outlet: T0 };
  state.seededGroups = { 'g-gpu': { deals: T0, outlet: T0 } };
  state.feedIds = { deals: ['5001', '5002', '1901'], outlet: ['x1'] };
  const config = normalizeInetConfig({ enabled: true, groups: [{ id: 'g-gpu', name: 'GPU', categories: ['17'] }] });

  const responses = [
    // First agent check: 5003 is a GPU nobody saw before, but it only seeds.
    [campaignItem(5001), campaignItem(5002), campaignItem(1901), campaignItem(5003)],
    // Second check: 5004 is new and alerts.
    [campaignItem(5001), campaignItem(5002), campaignItem(1901), campaignItem(5003), campaignItem(5004)],
  ];
  const sent = [];
  let t = Date.parse(T0);
  const poller = createInetPoller({
    getConfig: () => config,
    persistence: { load: () => state, save: async () => {} },
    notifier: {
      async notifyInet({ alerts }) {
        sent.push(...alerts);
        return { sent: alerts.length, failed: 0, skipped: 0, delivered: alerts.map(() => true) };
      },
    },
    fetchPages: async () => {
      const items = responses.shift();
      const products = items.map((item) => mapAgentListItem(item, 'deals'));
      return {
        source: 'agent',
        run: { id: null, status: 'PROXY', usageTotalUsd: 0 },
        pages: [agentPage('deals', products), agentPage('outlet', [mapAgentListItem(bargainItem('x1', 1902), 'outlet')])],
        urls: 81,
      };
    },
    lookupProducts: async (ids) => ({
      products: new Map(ids.map((id) => [id, detail(id, String(id).startsWith('19') ? BOARD_SPECS : GPU_SPECS)])),
      notFound: new Set(),
      failed: new Set(),
    }),
    logger: silentLogger,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    random: () => 0.5,
    now: () => (t += 60_000),
  });

  const first = await poller.pollNow();
  assert.equal(first.alertCount, 0, 'the switch seeds silently');
  assert.equal(poller.getState().source, 'agent');
  assert.equal(poller.getState().products['deals:5003'].templateId, '17');

  const second = await poller.pollNow();
  assert.equal(second.alertCount, 1);
  assert.equal(sent[0].product.id, '5004');
  assert.deepEqual(sent[0].groupNames, ['GPU']);
  assert.equal(poller.getStatus().costGuard.spentUsd, 0, 'no Apify cost');
  assert.equal(poller.getStatus().lastRun.urls, 81, 'counts the list pages actually requested');
});

// ── Fast check of watched items ────────────────────────────────

function seededAgentState() {
  const state = createEmptyInetState();
  state.source = 'agent';
  state.seededFeeds = { deals: T0, outlet: T0 };
  state.seededGroups = { 'g-gpu': { deals: T0, outlet: T0 } };
  const record = (id, overrides) => ({
    key: `deals:${id}`, id, feed: 'deals', title: `GPU ${id}`, url: `https://www.inet.se/produkt/${id}`,
    templateId: '17', priceSek: 5000, listPriceSek: 6000, discountPct: 17, inWebStock: true, webQty: 1,
    storeQty: 0, inStock: true, groupBase: { 'g-gpu': 5000 }, firstSeenAt: T0, lastSeenAt: T0,
    missingSince: null, misses: 1, ...overrides,
  });
  state.products = {
    'deals:5001': record('5001'),
    'deals:5002': record('5002', { inWebStock: false, webQty: 0, inStock: false }),
    'deals:2201': record('2201', { title: 'Monitor 2201', templateId: '1', groupBase: {} }),
    'deals:5003': record('5003', { missingSince: T0 }),
  };
  return state;
}

function fastHarness(state, { lookupProducts, fetchPages, config } = {}) {
  const sent = [];
  const looked = [];
  const poller = createInetPoller({
    getConfig: () => config ?? normalizeInetConfig({
      enabled: true, notifyPriceDropPercent: 5, notifyBackInStock: true,
      groups: [{ id: 'g-gpu', name: 'GPU', categories: ['17'] }],
    }),
    persistence: { load: () => state, save: async () => {} },
    notifier: {
      async notifyInet({ alerts }) {
        sent.push(...alerts);
        return { sent: alerts.length, failed: 0, skipped: 0, delivered: alerts.map(() => true) };
      },
    },
    fetchPages: fetchPages ?? (async () => { throw new Error('no sweep expected'); }),
    lookupProducts: lookupProducts ?? (async (ids) => {
      looked.push(ids);
      const answers = {
        5001: { productId: '5001', priceIncVat: 4000, stock: { inWebStock: true, stores: [] } },
        5002: { productId: '5002', priceIncVat: 5000, stock: { inWebStock: false, stores: [{ storeName: 'Göteborg', inStock: true }] } },
      };
      return { products: new Map(ids.filter((id) => answers[id]).map((id) => [id, answers[id]])), notFound: new Set(), failed: new Set() };
    }),
    logger: silentLogger,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    random: () => 0.5,
    now: () => Date.parse(T0) + 60_000,
  });
  return { poller, sent, looked };
}

test('the fast check looks up only watched items and alerts on price drops and restocks', async () => {
  const state = seededAgentState();
  const { poller, sent, looked } = fastHarness(state);

  const result = await poller.fastCheckNow();

  assert.deepEqual(looked, [['5001', '5002']], 'not the monitor (no group) or the gone GPU');
  assert.deepEqual(result, { checked: 2, changed: 2, alerts: 2 });
  const byId = Object.fromEntries(sent.map((a) => [a.product.id, a]));
  assert.equal(byId['5001'].reason, 'price-drop');
  assert.equal(byId['5001'].previousPriceSek, 5000);
  assert.equal(byId['5002'].reason, 'back-in-stock');
  assert.deepEqual(byId['5002'].groupNames, ['GPU']);

  const record = poller.getState().products['deals:5001'];
  assert.equal(record.priceSek, 4000);
  assert.equal(record.discountPct, 33);
  assert.equal(record.lastSeenAt, T0, 'listing bookkeeping is left to the sweeps');
  assert.equal(record.misses, 1);
  assert.equal(poller.getState().products['deals:5002'].storeQty, 1);
  assert.equal(poller.getStatus().fastCheck.checked, 2);

  // Same answers again: nothing new to say.
  sent.length = 0;
  assert.deepEqual(await poller.fastCheckNow(), { checked: 2, changed: 0, alerts: 0 });
  assert.equal(sent.length, 0);
});

test('the fast check waits for the first agent sweep and does nothing while disabled', async () => {
  const before = seededAgentState();
  before.source = null;
  const first = fastHarness(before);
  assert.equal(await first.poller.fastCheckNow(), null);
  assert.equal(first.looked.length, 0);

  const disabled = fastHarness(seededAgentState(), {
    config: normalizeInetConfig({ enabled: false, groups: [{ id: 'g-gpu', name: 'GPU', categories: ['17'] }] }),
  });
  assert.equal(await disabled.poller.fastCheckNow(), null);
  assert.equal(disabled.looked.length, 0);
});

test('a sweep waits for a running fast check instead of interleaving with it', async () => {
  const state = seededAgentState();
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { poller } = fastHarness(state, {
    lookupProducts: async () => {
      order.push('lookup start');
      await gate;
      order.push('lookup end');
      return { products: new Map(), notFound: new Set(), failed: new Set() };
    },
    fetchPages: async () => {
      order.push('sweep');
      return { source: 'agent', run: { id: null, status: 'PROXY', usageTotalUsd: 0 }, pages: [], urls: 0 };
    },
  });

  const fast = poller.fastCheckNow();
  const sweep = poller.pollNow().catch(() => null);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([fast, sweep]);
  assert.deepEqual(order, ['lookup start', 'lookup end', 'sweep']);
});
