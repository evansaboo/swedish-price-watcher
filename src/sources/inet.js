import { ApifyClient } from 'apify-client';

import {
  fetchViaWatcherProxy,
  mapWithConcurrency,
  resolveWatcherProxyUrl,
} from '../services/watcherProxy.js';

// ═══════════════════════════════════════════════════════════════
// Inet watcher: campaign deals (/kampanjer) and the outlet (/fyndhornan).
// See services/inetPoller.js.
//
// The owner doesn't want any Inet traffic from the home IP, so EVERY Inet
// request goes through Apify's cheerio-scraper on Apify's proxy, like the
// Komplett watcher. Nothing in this module fetches inet.se directly.
//
// Since 2026-11-10 Cloudflare refuses these pages to Apify and NordVPN; the
// poller now uses inetAgent.js by default. The feed definitions and
// mapInetProduct here are still shared with it.
// ═══════════════════════════════════════════════════════════════

const INET_ORIGIN = 'https://www.inet.se';
export const INET_IMAGE_BASE = 'https://cdn.inet.se/product/500x500/';

/**
 * The two feeds. Both pages are server-rendered and embed their data as
 * `hydrate("<Page>", JSON.parse("<JSON in a JS string>"))` (verified via
 * Apify 2026-11-05).
 */
export const INET_FEEDS = Object.freeze({
  deals: Object.freeze({ id: 'deals', path: '/kampanjer', hydrate: 'CampaignsPage', label: 'Kampanj', alertLabel: 'Inet deal' }),
  outlet: Object.freeze({ id: 'outlet', path: '/fyndhornan', hydrate: 'BargainPage', label: 'Fyndhörnan', alertLabel: 'Inet outlet' }),
});
export const INET_FEED_IDS = Object.freeze(Object.keys(INET_FEEDS));

/**
 * `?page=N` works with 60 products a page (fyndhornan ≈ 7 pages, kampanjer ≈ 5
 * on 2026-11-05). There is no newest-first sort, so every check is a full sweep.
 * The cap bounds the cost if a feed balloons.
 */
export const INET_PAGE_SIZE = 60;
export const INET_MAX_PAGES_PER_FEED = 15;

/** Pages needed to cover `total` products, clamped to [1, MAX]. */
export function inetPagesFor(total, pageSize = INET_PAGE_SIZE) {
  const n = Number(total);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(INET_MAX_PAGES_PER_FEED, Math.max(1, Math.ceil(n / pageSize)));
}

/** Listing URL of one feed page. Page 1 has no parameter (the page function builds the same URLs). */
export function buildInetFeedUrl(feedId, page = 1) {
  const feed = INET_FEEDS[feedId];
  if (!feed) throw new Error(`Unknown Inet feed "${feedId}"`);
  const base = `${INET_ORIGIN}${feed.path}`;
  const n = Math.floor(Number(page));
  return Number.isFinite(n) && n > 1 ? `${base}?page=${n}` : base;
}

export function inetProductUrl(id, urlName) {
  const productId = String(id ?? '').trim();
  if (!productId) return null;
  const slug = String(urlName ?? '').trim();
  return `${INET_ORIGIN}/produkt/${encodeURIComponent(productId)}${slug ? `/${encodeURIComponent(slug)}` : ''}`;
}

export function inetImageUrl(image) {
  const file = typeof image === 'string' ? image.trim() : '';
  return file && /^[\w.-]+$/.test(file) ? `${INET_IMAGE_BASE}${file}` : null;
}

/**
 * Pull the view model out of the page HTML: find `hydrate("<name>",`, then
 * `JSON.parse("`, scan to the closing unescaped quote and decode twice (JS
 * string → JSON text → object). Kept as plain ES5-ish source so the exact
 * same function runs inside the Apify page function (see below) and in tests.
 */
function extractInetHydrate(html, name) {
  const text = String(html || '');
  const markers = [];
  if (name) {
    const at = text.indexOf('hydrate("' + name + '"');
    if (at !== -1) markers.push(at);
  }
  // Fallback: any hydrate(...) call, in case the page component is renamed.
  for (let from = 0; markers.length < 12;) {
    const at = text.indexOf('hydrate("', from);
    if (at === -1) break;
    if (markers.indexOf(at) === -1) markers.push(at);
    from = at + 9;
  }
  let lastError = 'no hydrate() call found';
  for (let m = 0; m < markers.length; m++) {
    const markerAt = markers[m];
    const nameEnd = text.indexOf('"', markerAt + 9);
    const pageName = nameEnd === -1 ? null : text.slice(markerAt + 9, nameEnd);
    const parseAt = text.indexOf('JSON.parse("', markerAt);
    if (parseAt === -1 || parseAt - markerAt > 300) { lastError = 'no JSON.parse after hydrate()'; continue; }
    const start = parseAt + 'JSON.parse("'.length;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 92) { i++; continue; } // backslash: skip the escaped char
      if (ch === 34) { end = i; break; } // closing quote
    }
    if (end === -1) { lastError = 'unterminated JSON string'; continue; }
    let slice = text.slice(start, end);
    let data = null;
    for (let attempt = 0; attempt < 2 && data === null; attempt++) {
      try {
        data = JSON.parse(JSON.parse('"' + slice + '"'));
      } catch (error) {
        lastError = 'parse error: ' + error.message;
        // JS-only escapes that JSON rejects.
        slice = slice.replace(/\\'/g, "'").replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1');
      }
    }
    if (data && typeof data === 'object') {
      if (!name || pageName === name || data.productListWithDynamicFilterViewModel) {
        return { pageName: pageName, data: data, error: null };
      }
      lastError = 'hydrate("' + pageName + '") has no product list';
    }
  }
  return { pageName: null, data: null, error: lastError };
}

/** Compact product as returned by the page function (dataset writes cost money). */
function compactInetProduct(p) {
  if (!p || typeof p !== 'object' || p.id == null) return null;
  const qty = p.qty && typeof p.qty === 'object' ? p.qty : {};
  const web = qty['00'] && typeof qty['00'] === 'object' ? qty['00'] : null;
  let storeQty = 0;
  for (const key of Object.keys(qty)) {
    const entry = qty[key];
    if (key !== '00' && entry && !entry.blocked && typeof entry.qty === 'number' && entry.qty > 0) storeQty += entry.qty;
  }
  const price = p.price && typeof p.price === 'object' ? p.price : {};
  return {
    id: String(p.id),
    name: typeof p.name === 'string' ? p.name.slice(0, 300) : null,
    urlName: typeof p.urlName === 'string' ? p.urlName.slice(0, 300) : null,
    image: typeof p.image === 'string' ? p.image.slice(0, 120) : null,
    templateId: p.templateId == null ? null : p.templateId,
    categoryId: p.categoryId == null ? null : p.categoryId,
    manufacturerId: p.manufacturerId == null ? null : p.manufacturerId,
    listPrice: typeof price.listPrice === 'number' ? price.listPrice : null,
    price: typeof price.price === 'number' ? price.price : null,
    webQty: web && typeof web.qty === 'number' ? web.qty : null,
    webBlocked: web ? Boolean(web.blocked) : null,
    storeQty: storeQty,
    sellingPoint: typeof p.sellingPoint === 'string' ? p.sellingPoint.slice(0, 300) : null,
    isBargain: p.isBargain === true,
    bargainParentId: p.bargainParentId == null ? null : p.bargainParentId,
    releaseDate: typeof p.releaseDate === 'string' ? p.releaseDate.slice(0, 40) : null,
    purchaseStatus: p.purchaseStatus == null ? null : p.purchaseStatus,
  };
}

/**
 * Runs inside apify/cheerio-scraper: one dataset item per page with compact
 * products. Page 1 also returns the full `productIds` list and the template
 * (category) facet, and enqueues any pages beyond the planned ones, so the
 * very first run discovers the feed size by itself.
 */
export const INET_PAGE_FUNCTION = /* js */ `
async function pageFunction(context) {
  ${extractInetHydrate.toString()}
  ${compactInetProduct.toString()}
  const html = context.body ? String(context.body) : '';
  const ud = context.request.userData || {};
  const meta = {
    feed: ud.feed || null,
    page: ud.page || 1,
    url: context.request.url,
    loadedUrl: context.request.loadedUrl || null,
    statusCode: context.response ? (context.response.statusCode || context.response.status || null) : null,
  };
  const extracted = extractInetHydrate(html, ud.hydrate);
  const vm = extracted.data && extracted.data.productListWithDynamicFilterViewModel;
  if (!vm || typeof vm !== 'object') {
    let title = null;
    try { title = context.$ ? context.$('title').first().text().slice(0, 120) : null; } catch (e) {}
    return { ...meta, found: false, error: extracted.error || 'no productListWithDynamicFilterViewModel', title };
  }
  const ids = Array.isArray(vm.productIds) ? vm.productIds.map(String) : [];
  const map = vm.products && typeof vm.products === 'object' ? vm.products : {};
  const products = [];
  for (const key of Object.keys(map)) {
    const compact = compactInetProduct(map[key]);
    if (compact) products.push(compact);
  }
  const pageSize = Number(vm.pageSize) > 0 ? Number(vm.pageSize) : 60;
  const out = {
    ...meta,
    found: true,
    pageName: extracted.pageName,
    vmPage: vm.page == null ? null : vm.page,
    pageSize,
    total: ids.length,
    products,
  };
  if (meta.page === 1) {
    out.productIds = ids;
    if (ud.delta) out.delta = true;
    const fo = vm.filterOptions && typeof vm.filterOptions === 'object' ? vm.filterOptions : {};
    out.templates = Array.isArray(fo.templates)
      ? fo.templates.filter((t) => t && t.id != null).map((t) => ({ id: t.id, name: t.name == null ? null : String(t.name).slice(0, 120), facetCount: typeof t.facetCount === 'number' ? t.facetCount : null }))
      : [];
    const needed = Math.min(Math.ceil(ids.length / pageSize), Number(ud.maxPages) || 15);
    const planned = Number(ud.plannedPages) || 1;
    if (needed > planned && typeof context.enqueueRequest === 'function' && ud.baseUrl) {
      if (ud.delta && Array.isArray(ud.knownIds) && ud.knownIds.length > 0) {
        const known = {};
        for (let k = 0; k < ud.knownIds.length; k++) known[String(ud.knownIds[k])] = true;
        const deltaPages = [];
        for (let p = planned + 1; p <= needed; p++) {
          const from = (p - 1) * pageSize;
          const to = Math.min(p * pageSize, ids.length);
          let hasNew = false;
          for (let i = from; i < to; i++) {
            if (!known[ids[i]]) { hasNew = true; break; }
          }
          if (hasNew) {
            deltaPages.push(p);
            await context.enqueueRequest({
              url: ud.baseUrl + '?page=' + p,
              userData: { ...ud, page: p, knownIds: undefined },
            });
          }
        }
        out.deltaPages = deltaPages;
        out.enqueued = deltaPages.length;
      } else {
        for (let p = planned + 1; p <= needed; p++) {
          await context.enqueueRequest({ url: ud.baseUrl + '?page=' + p, userData: { ...ud, page: p } });
        }
        out.enqueued = needed - planned;
      }
    }
  }
  return out;
}
`;

/** Exposed for tests: the same extractor the page function embeds. */
export const extractInetHydrateForTest = extractInetHydrate;
export const compactInetProductForTest = compactInetProduct;

function positiveRounded(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function optionalId(value) {
  if (value == null || value === '') return null;
  return String(value);
}

/** Map one compact page product to the watcher's record shape. */
export function mapInetProduct(raw, feedId) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  const title = String(raw.name ?? '').trim();
  if (!id || !title || !INET_FEEDS[feedId]) return null;
  const priceSek = positiveRounded(raw.price);
  const listPrice = positiveRounded(raw.listPrice);
  const listPriceSek = listPrice && priceSek && listPrice > priceSek ? listPrice : null;
  const discountPct = listPriceSek ? Math.round((1 - priceSek / listPriceSek) * 100) : 0;
  const webQty = Number.isFinite(raw.webQty) ? raw.webQty : null;
  const storeQty = Number.isFinite(raw.storeQty) && raw.storeQty > 0 ? raw.storeQty : 0;
  const inWebStock = webQty !== null && webQty > 0 && raw.webBlocked !== true;
  const sellingPoint = typeof raw.sellingPoint === 'string' && raw.sellingPoint.trim()
    ? raw.sellingPoint.trim().replace(/\s+/g, ' ').slice(0, 200)
    : null;
  return {
    id,
    feed: feedId,
    title,
    url: inetProductUrl(id, raw.urlName),
    imageUrl: inetImageUrl(raw.image),
    priceSek,
    listPriceSek,
    discountPct,
    webQty,
    inWebStock,
    storeQty,
    // Outlet units sit in a store warehouse, never in web stock (all 389 on
    // 2026-11-05 had web qty 0 and one unit in a store, all purchasable), so
    // "in stock" means web OR store stock.
    inStock: inWebStock || storeQty > 0,
    purchaseStatus: typeof raw.purchaseStatus === 'string' ? raw.purchaseStatus : null,
    templateId: optionalId(raw.templateId),
    categoryId: optionalId(raw.categoryId),
    manufacturerId: optionalId(raw.manufacturerId),
    sellingPoint,
    bargainParentId: optionalId(raw.bargainParentId),
    releaseDate: typeof raw.releaseDate === 'string' ? raw.releaseDate : null,
  };
}

export function resolveInetApifyToken() {
  return process.env.APIFY_TOKEN_INET?.trim() || process.env.APIFY_TOKEN?.trim() || '';
}

function resolveApifyToken() {
  return resolveInetApifyToken();
}

function extractTitleFromHtml(html) {
  const match = String(html ?? '').match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim().slice(0, 120) : null;
}

/** Parse one Inet HTML page into the same dataset item shape as INET_PAGE_FUNCTION. */
export function parseInetPageBody({
  body,
  statusCode = null,
  url,
  loadedUrl = null,
  feedId,
  page = 1,
  hydrate = INET_FEEDS[feedId]?.hydrate,
  delta = false,
}) {
  const html = body ? String(body) : '';
  const meta = {
    feed: feedId || null,
    page: page || 1,
    url,
    loadedUrl: loadedUrl || url || null,
    statusCode,
  };
  const extracted = extractInetHydrate(html, hydrate);
  const vm = extracted.data && extracted.data.productListWithDynamicFilterViewModel;
  if (!vm || typeof vm !== 'object') {
    return {
      ...meta,
      found: false,
      error: extracted.error || 'no productListWithDynamicFilterViewModel',
      title: extractTitleFromHtml(html),
    };
  }
  const ids = Array.isArray(vm.productIds) ? vm.productIds.map(String) : [];
  const map = vm.products && typeof vm.products === 'object' ? vm.products : {};
  const products = [];
  for (const key of Object.keys(map)) {
    const compact = compactInetProduct(map[key]);
    if (compact) products.push(compact);
  }
  const pageSize = Number(vm.pageSize) > 0 ? Number(vm.pageSize) : INET_PAGE_SIZE;
  const out = {
    ...meta,
    found: true,
    pageName: extracted.pageName,
    vmPage: vm.page == null ? null : vm.page,
    pageSize,
    total: ids.length,
    products,
  };
  if (page === 1) {
    out.productIds = ids;
    if (delta) out.delta = true;
    const fo = vm.filterOptions && typeof vm.filterOptions === 'object' ? vm.filterOptions : {};
    out.templates = Array.isArray(fo.templates)
      ? fo.templates
        .filter((t) => t && t.id != null)
        .map((t) => ({
          id: t.id,
          name: t.name == null ? null : String(t.name).slice(0, 120),
          facetCount: typeof t.facetCount === 'number' ? t.facetCount : null,
        }))
      : [];
  }
  return out;
}

async function fetchInetPagesViaProxy({ planned, proxyUrl, proxyFetch = fetchViaWatcherProxy, logger = console }) {
  const startedAtMs = Date.now();
  const pages = [];

  for (const feed of planned) {
    const firstUrl = buildInetFeedUrl(feed.id, 1);
    const firstRes = await proxyFetch(firstUrl, { proxyUrl, logger });
    const firstPage = parseInetPageBody({
      body: firstRes.body,
      statusCode: firstRes.statusCode,
      url: firstUrl,
      loadedUrl: firstRes.loadedUrl,
      feedId: feed.id,
      page: 1,
      hydrate: INET_FEEDS[feed.id].hydrate,
      delta: Boolean(feed.delta),
    });
    pages.push(firstPage);
    if (!firstPage.found) continue;

    const pageSize = firstPage.pageSize || INET_PAGE_SIZE;
    const needed = inetPagesFor(firstPage.total, pageSize);
    let pagesToFetch = [];

    if (feed.delta && Array.isArray(feed.knownIds) && feed.knownIds.length > 0) {
      const known = new Set(feed.knownIds.map(String));
      const ids = firstPage.productIds || [];
      for (let p = 2; p <= needed; p += 1) {
        const slice = ids.slice((p - 1) * pageSize, p * pageSize);
        if (slice.some((id) => !known.has(id))) pagesToFetch.push(p);
      }
      firstPage.deltaPages = pagesToFetch;
      firstPage.enqueued = pagesToFetch.length;
    } else if (needed > 1) {
      pagesToFetch = Array.from({ length: needed - 1 }, (_, i) => i + 2);
      firstPage.enqueued = pagesToFetch.length;
    }

    if (pagesToFetch.length) {
      const restPages = await mapWithConcurrency(pagesToFetch, 2, async (pageNum) => {
        const pageUrl = buildInetFeedUrl(feed.id, pageNum);
        try {
          const res = await proxyFetch(pageUrl, { proxyUrl, logger });
          return parseInetPageBody({
            body: res.body,
            statusCode: res.statusCode,
            url: pageUrl,
            loadedUrl: res.loadedUrl,
            feedId: feed.id,
            page: pageNum,
            hydrate: INET_FEEDS[feed.id].hydrate,
          });
        } catch (error) {
          return {
            feed: feed.id,
            page: pageNum,
            url: pageUrl,
            loadedUrl: null,
            statusCode: null,
            found: false,
            error: error.message,
            title: null,
          };
        }
      });
      pages.push(...restPages);
    }
  }

  return {
    run: {
      id: null,
      status: 'PROXY',
      usageTotalUsd: 0,
      runTimeSecs: Math.round((Date.now() - startedAtMs) / 100) / 10,
    },
    pages,
    urls: pages.length,
  };
}

/**
 * Fetches every planned page of each enabled Inet feed.
 * `feeds` is `[{ id: 'deals'|'outlet', pages, delta?, knownIds? }]`.
 *
 * Uses `INET_PROXY_URL` or `WATCHER_PROXY_URL` first if configured; falls back
 * to Apify's `apify/cheerio-scraper` if no proxy is set or if the proxy is
 * blocked. Never contacts inet.se from the Pi's home IP.
 *
 * @returns {Promise<{ run: { id, status, usageTotalUsd, runTimeSecs }, pages: object[] }>}
 */
export async function fetchInetPages({
  feeds,
  token = resolveApifyToken(),
  ApifyClientClass = ApifyClient,
  proxyUrl,
  proxyFetch = fetchViaWatcherProxy,
  logger = console,
  memoryMbytes = 256,
  timeoutSecs = 240,
  maxRequestRetries = 2,
}) {
  const planned = (Array.isArray(feeds) ? feeds : []).filter((feed) => INET_FEEDS[feed?.id]);
  if (!planned.length) throw new Error('No Inet feeds enabled.');

  const resolvedProxy = proxyUrl !== undefined
    ? String(proxyUrl ?? '').trim()
    : (ApifyClientClass === ApifyClient ? resolveWatcherProxyUrl('INET') : '');

  if (resolvedProxy) {
    try {
      const proxyResult = await fetchInetPagesViaProxy({
        planned,
        proxyUrl: resolvedProxy,
        proxyFetch,
        logger,
      });
      if (proxyResult.pages.some((p) => p?.found)) {
        return proxyResult;
      }
      if (!token) return proxyResult;
      logger.warn?.('[inet] Proxy returned no usable pages; falling back to Apify.');
    } catch (error) {
      if (!token) throw error;
      logger.warn?.(`[inet] Proxy fetch failed (${error.message}); falling back to Apify.`);
    }
  }

  if (!token) throw new Error('No Apify token configured (APIFY_TOKEN_INET or APIFY_TOKEN).');

  const startUrls = [];
  for (const feed of planned) {
    const pages = inetPagesFor((Number(feed.pages) || 1) * INET_PAGE_SIZE);
    const userData = {
      feed: feed.id,
      hydrate: INET_FEEDS[feed.id].hydrate,
      baseUrl: buildInetFeedUrl(feed.id, 1),
      plannedPages: pages,
      maxPages: INET_MAX_PAGES_PER_FEED,
      ...(feed.delta ? { delta: true, knownIds: Array.isArray(feed.knownIds) ? feed.knownIds.map(String) : [] } : {}),
    };
    for (let page = 1; page <= pages; page += 1) {
      startUrls.push({
        url: buildInetFeedUrl(feed.id, page),
        userData: { ...userData, page, ...(page > 1 ? { knownIds: undefined } : {}) },
      });
    }
  }

  const client = new ApifyClientClass({ token });
  const run = await client.actor('apify/cheerio-scraper').call({
    startUrls,
    pageFunction: INET_PAGE_FUNCTION,
    proxyConfiguration: { useApifyProxy: true },
    maxRequestsPerCrawl: planned.length * INET_MAX_PAGES_PER_FEED + 2,
    maxRequestRetries,
  }, { memory: memoryMbytes, timeout: timeoutSecs });

  let pages = [];
  if (run?.defaultDatasetId) {
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    pages = Array.isArray(items) ? items : [];
  }

  return {
    run: {
      id: run?.id ?? null,
      status: run?.status ?? null,
      usageTotalUsd: Number.isFinite(run?.usageTotalUsd) ? run.usageTotalUsd : null,
      runTimeSecs: run?.stats?.runTimeSecs ?? null,
    },
    pages,
    urls: startUrls.length,
  };
}

export async function fetchApifyRunUsage({ runId, token = resolveInetApifyToken(), ApifyClientClass = ApifyClient }) {
  if (!runId || !token) return null;
  const client = new ApifyClientClass({ token });
  const run = await client.run(runId).get();
  return Number.isFinite(run?.usageTotalUsd) ? run.usageTotalUsd : null;
}
