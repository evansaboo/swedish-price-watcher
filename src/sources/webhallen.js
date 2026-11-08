import { ApifyClient } from 'apify-client';

import {
  fetchViaWatcherProxy,
  mapWithConcurrency,
  resolveWatcherProxyUrl,
} from '../services/watcherProxy.js';
import { fetchApifyRunUsage } from './komplett.js';

// ═══════════════════════════════════════════════════════════════
// Webhallen watcher: campaign deals (/se/campaigns) and the
// Fyndvaror outlet (/se/category/s53-Fyndvaror).
// See services/webhallenPoller.js.
//
// Like the Inet and Komplett watchers, EVERY Webhallen request goes through
// Apify's cheerio-scraper on Apify's proxy so no Webhallen traffic leaves
// the Pi's home IP. Nothing in this module fetches webhallen.com directly.
// ═══════════════════════════════════════════════════════════════

const WEBHALLEN_ORIGIN = 'https://www.webhallen.com';
const WEBHALLEN_API_BASE = `${WEBHALLEN_ORIGIN}/api/productdiscovery`;

/**
 * The two feeds. Both are backed by Webhallen's JSON productdiscovery API
 * (`limit=250`, verified via Apify 2026-11-07).
 */
export const WEBHALLEN_FEEDS = Object.freeze({
  deals: Object.freeze({
    id: 'deals',
    path: '/se/campaigns',
    apiPath: '/campaigns',
    label: 'Kampanjer',
    alertLabel: 'Webhallen deal',
  }),
  outlet: Object.freeze({
    id: 'outlet',
    path: '/se/category/s53-Fyndvaror',
    apiPath: '/search/fyndware',
    label: 'Fyndvaror',
    alertLabel: 'Webhallen outlet',
  }),
});
export const WEBHALLEN_FEED_IDS = Object.freeze(Object.keys(WEBHALLEN_FEEDS));

/**
 * Webhallen's productdiscovery endpoints accept `limit=250` with `page=N&pageNo=N`
 * (campaigns ≈ 4 pages, fyndware ≈ 6 pages on 2026-11-07). Every check is a
 * full sweep; the cap bounds the cost if a feed grows unusually large.
 */
export const WEBHALLEN_PAGE_SIZE = 250;
export const WEBHALLEN_MAX_PAGES_PER_FEED = 12;

export const WEBHALLEN_API_HEADERS = Object.freeze({
  accept: 'application/json',
  'x-requested-with': 'XMLHttpRequest',
  region: 'se',
  referer: 'https://www.webhallen.com/se/',
});

/** Pages needed to cover `total` products, clamped to [1, MAX]. */
export function webhallenPagesFor(total, pageSize = WEBHALLEN_PAGE_SIZE) {
  const n = Number(total);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(WEBHALLEN_MAX_PAGES_PER_FEED, Math.max(1, Math.ceil(n / pageSize)));
}

/** Human-facing Webhallen listing URL for a feed. */
export function buildWebhallenPageUrl(feedId) {
  const feed = WEBHALLEN_FEEDS[feedId];
  if (!feed) throw new Error(`Unknown Webhallen feed "${feedId}"`);
  return `${WEBHALLEN_ORIGIN}${feed.path}`;
}

/** API URL of one feed page (`limit=250`). */
export function buildWebhallenFeedUrl(feedId, page = 1, pageSize = WEBHALLEN_PAGE_SIZE) {
  const feed = WEBHALLEN_FEEDS[feedId];
  if (!feed) throw new Error(`Unknown Webhallen feed "${feedId}"`);
  const n = Math.max(1, Math.floor(Number(page)) || 1);
  const limit = Math.max(1, Math.min(250, Math.floor(Number(pageSize)) || WEBHALLEN_PAGE_SIZE));
  return `${WEBHALLEN_API_BASE}${feed.apiPath}?page=${n}&pageNo=${n}&limit=${limit}&touchpoint=DESKTOP&totalProductCountSet=false`;
}

function slugifyProductName(value) {
  return String(value ?? '')
    .replace(/\s*\(Fyndvara(?:\s+klass\s*\d+)?\)\s*$/i, '')
    .trim()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[™®©℠]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export function webhallenProductUrl(id, name) {
  const productId = String(id ?? '').trim();
  if (!productId) return null;
  const slug = slugifyProductName(name);
  return `${WEBHALLEN_ORIGIN}/se/product/${encodeURIComponent(productId)}${slug ? `-${slug}` : ''}`;
}

export function webhallenImageUrl(image, id, parentId = null) {
  const raw = typeof image === 'string' ? image.trim() : '';
  if (raw.startsWith('https://www.webhallen.com/images-ext/')) return raw;
  if (raw.startsWith('/images-ext/')) return `${WEBHALLEN_ORIGIN}${raw}`;
  // Older fyndvaror point at their own fyndware id on `/images/product/<id>?trim`,
  // which serves a placeholder SVG; the parent product id has the real photo.
  const targetId = String(parentId || id || '').trim();
  if (/^\d+$/.test(targetId)) {
    return `${WEBHALLEN_ORIGIN}/images/product/${encodeURIComponent(targetId)}?size=500x500`;
  }
  if (raw.startsWith('https://')) return raw;
  if (raw.startsWith('/')) return `${WEBHALLEN_ORIGIN}${raw}`;
  return null;
}

/**
 * Slugify a category label into a stable category id
 * (e.g. "Datorkomponenter / Grafikkort (GPU)" → "datorkomponenter-grafikkort-gpu").
 */
export function slugifyCategoryId(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Fyndvaror nests some subcategories under intermediate grouping folders that
// normal categories omit (e.g. "Fyndvaror/Datorer & Tillbehör/Datortillbehör/Möss"
// vs "Datorer & Tillbehör/Möss").
const CONTAINER_SEGMENTS = new Set([
  'Datorer',
  'Datortillbehör',
  'Bild',
  'Ljud',
  'Nätverk',
  'Mobiltillbehör',
]);

// Canonicalize naming differences between Fyndvaror and regular categories so
// one category filter in a watch group covers both feeds.
const LEAF_SYNONYMS = Object.freeze({
  'Datorskärm Bildskärm': 'Bildskärmar',
  'Stationära': 'Stationära datorer',
  'Stationär dator': 'Stationära datorer',
  'Bärbara': 'Bärbara datorer',
  'Laptop Bärbar dator': 'Bärbara datorer',
  'Minnen': 'RAM-minne',
  'Hårddisk': 'Lagring',
  'Nätaggregat': 'Nätaggregat (PSU)',
  'TV-apparater': 'TV',
  'Projektorer': 'Projektor',
  'Router Mesh': 'Router',
  'Mobiltelefoner': 'Mobiltelefon',
  'Smartbands Smartklockor': 'Smartklocka',
  'Surf- & Läsplattor': 'Surfplatta',
  'Laddare Kablage': 'Laddare & Kablar',
  'Gaming headset': 'Headset',
  'Skrivare & Scanner': 'Skrivare & Scanners',
  'PS5': 'PlayStation 5',
  'PS4': 'PlayStation 4',
});

/**
 * Normalize a Webhallen `categoryTree` path (such as
 * `"Fyndvaror/Datorkomponenter/Grafikkort (GPU)"` or
 * `"Datorer & Tillbehör/Stationär dator/Webhallen Config"`) into a canonical
 * category `{ id, name, sectionId, sectionName }`.
 */
export function resolveWebhallenCategory(categoryTree) {
  const raw = typeof categoryTree === 'string' ? categoryTree.trim() : '';
  if (!raw) return { id: null, name: null, sectionId: null, sectionName: null };
  const parts = raw.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts[0] === 'Fyndvaror') parts.shift();
  if (!parts.length) return { id: null, name: null, sectionId: null, sectionName: null };

  const sectionName = parts[0];
  const sectionId = slugifyCategoryId(sectionName);
  if (parts.length === 1) {
    return { id: sectionId, name: sectionName, sectionId, sectionName };
  }

  const rawLeaf = CONTAINER_SEGMENTS.has(parts[1]) && parts[2] ? parts[2] : parts[1];
  const leaf = LEAF_SYNONYMS[rawLeaf] ?? rawLeaf;
  const name = `${sectionName} / ${leaf}`;
  const id = slugifyCategoryId(name);
  return { id, name, sectionId, sectionName };
}

/**
 * Compact product as returned by the Apify page function (dataset writes cost money).
 * Kept self-contained so `.toString()` embeds cleanly in WEBHALLEN_PAGE_FUNCTION.
 */
function compactWebhallenProduct(p) {
  if (!p || typeof p !== 'object' || p.id == null) return null;
  const parsePrice = (val) => {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string' && val.trim()) {
      const n = Number.parseFloat(val);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const stock = p.stock && typeof p.stock === 'object' ? p.stock : {};
  const webQty = typeof stock.web === 'number' && Number.isFinite(stock.web) ? stock.web : null;
  let storeQty = 0;
  for (const key of Object.keys(stock)) {
    if (key === 'web' || key === '992' || !/^\d+$/.test(key)) continue;
    const qty = stock[key];
    if (typeof qty === 'number' && Number.isFinite(qty) && qty > 0) storeQty += qty;
  }
  const priceObj = p.price && typeof p.price === 'object' ? p.price : {};
  const regObj = p.regularPrice && typeof p.regularPrice === 'object' ? p.regularPrice : {};
  const lowObj = p.lowestPrice && typeof p.lowestPrice === 'object' ? p.lowestPrice : {};
  const fyndClass = p.fyndwareClass && typeof p.fyndwareClass === 'object' ? p.fyndwareClass : null;
  const fyndOf = p.fyndwareOf && typeof p.fyndwareOf === 'object' ? p.fyndwareOf : null;
  const price = parsePrice(priceObj.price);
  const regularPrice = parsePrice(regObj.price) ?? parsePrice(lowObj.price);
  return {
    id: String(p.id),
    name: typeof p.name === 'string' ? p.name.slice(0, 300) : null,
    mainTitle: typeof p.mainTitle === 'string' ? p.mainTitle.slice(0, 300) : null,
    subTitle: typeof p.subTitle === 'string' ? p.subTitle.slice(0, 300) : null,
    image: typeof p.image === 'string' ? p.image.slice(0, 300) : null,
    categoryTree: typeof p.categoryTree === 'string' ? p.categoryTree.slice(0, 240) : null,
    manufacturer: p.manufacturer && typeof p.manufacturer.name === 'string' ? p.manufacturer.name.slice(0, 120) : null,
    price,
    listPrice: regularPrice,
    priceType: typeof priceObj.type === 'string' ? priceObj.type.slice(0, 40) : null,
    webQty,
    storeQty,
    isFyndware: p.isFyndware === true,
    fyndwareClassId: fyndClass && typeof fyndClass.id === 'number' ? fyndClass.id : null,
    fyndwareClassName: fyndClass && typeof fyndClass.name === 'string' ? fyndClass.name.slice(0, 80) : null,
    fyndwareCondition: fyndClass && typeof fyndClass.condition === 'string' ? fyndClass.condition.slice(0, 80) : null,
    fyndwareParentId: fyndOf && fyndOf.id != null ? String(fyndOf.id) : null,
    discontinued: p.discontinued === true,
  };
}

/**
 * Runs inside apify/cheerio-scraper: one dataset item per page with compact
 * products. Page 1 also returns the total count and enqueues any pages beyond
 * the planned ones, so the first run discovers the feed size automatically.
 */
export const WEBHALLEN_PAGE_FUNCTION = /* js */ `
async function pageFunction(context) {
  ${compactWebhallenProduct.toString()}
  const ud = context.request.userData || {};
  const meta = {
    feed: ud.feed || null,
    page: ud.page || 1,
    url: context.request.url,
    loadedUrl: context.request.loadedUrl || null,
    statusCode: context.response ? (context.response.statusCode || context.response.status || null) : null,
  };
  let payload = context.json && typeof context.json === 'object' ? context.json : null;
  let parseError = null;
  if (!payload) {
    const raw = context.body ? String(context.body) : '';
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch (err) {
      parseError = err.message;
    }
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.products)) {
    let title = null;
    try { title = context.$ ? context.$('title').first().text().slice(0, 120) : null; } catch (e) {}
    return {
      ...meta,
      found: false,
      error: parseError ? 'parse error: ' + parseError : 'no products array in response',
      title,
    };
  }
  const products = [];
  for (const raw of payload.products) {
    if (ud.feed === 'outlet' && raw && raw.isFyndware === false) continue;
    const compact = compactWebhallenProduct(raw);
    if (compact) products.push(compact);
  }
  const pageSize = Number(ud.pageSize) > 0 ? Number(ud.pageSize) : 250;
  const total = typeof payload.filteredProductCount === 'number'
    ? payload.filteredProductCount
    : (typeof payload.totalProductCount === 'number' ? payload.totalProductCount : products.length);
  const out = {
    ...meta,
    found: true,
    pageSize,
    total,
    products,
  };
  if (meta.page === 1) {
    out.categories = Array.isArray(payload.categories)
      ? payload.categories
        .filter((c) => c && c.name)
        .map((c) => ({ id: c.id ?? null, name: String(c.name).slice(0, 120) }))
      : [];
    const needed = Math.min(Math.ceil(total / pageSize), Number(ud.maxPages) || 12);
    const planned = Number(ud.plannedPages) || 1;
    if (needed > planned && typeof context.enqueueRequest === 'function' && ud.apiBaseUrl) {
      for (let p = planned + 1; p <= needed; p++) {
        const nextUrl = ud.apiBaseUrl + '?page=' + p + '&pageNo=' + p + '&limit=' + pageSize + '&touchpoint=DESKTOP&totalProductCountSet=false';
        await context.enqueueRequest({
          url: nextUrl,
          headers: ud.headers || undefined,
          userData: { ...ud, page: p },
        });
      }
      out.enqueued = needed - planned;
    }
  }
  return out;
}
`;

export const compactWebhallenProductForTest = compactWebhallenProduct;

function positiveRounded(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function optionalId(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function formatTitle(raw) {
  const baseName = String(raw.name ?? '').trim();
  if (!baseName) return '';
  const subTitle = typeof raw.subTitle === 'string' ? raw.subTitle.trim().replace(/\s+/g, ' ') : '';
  // Webhallen Config PCs with short model names (e.g. "Webhallen Config Ultra - a330")
  // put the CPU/RAM/GPU specs in subTitle ("Ultra / R7 9800X3D / 32 GB / 2 TB / NVIDIA GeForce RTX 5080...").
  if (subTitle && /^webhallen\s+config\b/i.test(baseName) && !baseName.includes('/')) {
    return `${baseName} (${subTitle})`.slice(0, 300);
  }
  return baseName;
}

function formatSellingPoint(raw, feedId) {
  if (feedId === 'outlet') {
    const className = typeof raw.fyndwareClassName === 'string' ? raw.fyndwareClassName.trim() : '';
    const cond = typeof raw.fyndwareCondition === 'string' ? raw.fyndwareCondition.trim() : '';
    if (className && cond) return `${className} — ${cond}`;
    if (cond) return cond;
    if (className) return className;
  }
  const subTitle = typeof raw.subTitle === 'string' ? raw.subTitle.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
  return subTitle || null;
}

/** Map one compact page product to the watcher's record shape. */
export function mapWebhallenProduct(raw, feedId) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  const title = formatTitle(raw);
  if (!id || !title || !WEBHALLEN_FEEDS[feedId]) return null;
  const priceSek = positiveRounded(raw.price);
  const listPrice = positiveRounded(raw.listPrice);
  const listPriceSek = listPrice && priceSek && listPrice > priceSek ? listPrice : null;
  const discountPct = listPriceSek ? Math.round((1 - priceSek / listPriceSek) * 100) : 0;
  const webQty = Number.isFinite(raw.webQty) ? raw.webQty : null;
  const storeQty = Number.isFinite(raw.storeQty) && raw.storeQty > 0 ? raw.storeQty : 0;
  const inWebStock = webQty !== null && webQty > 0;
  const category = resolveWebhallenCategory(raw.categoryTree);
  const fyndwareParentId = optionalId(raw.fyndwareParentId);
  return {
    id,
    feed: feedId,
    title,
    url: webhallenProductUrl(id, raw.mainTitle || raw.name),
    imageUrl: webhallenImageUrl(raw.image, id, fyndwareParentId),
    priceSek,
    listPriceSek,
    discountPct,
    webQty,
    inWebStock,
    storeQty,
    // Like Inet's Fyndhörnan, some Fyndvaror sit in physical stores with
    // webQty = 0, so "in stock" means online OR store stock.
    inStock: (inWebStock || storeQty > 0) && raw.discontinued !== true,
    categoryId: category.id,
    categoryName: category.name,
    sectionId: category.sectionId,
    sectionName: category.sectionName,
    categoryTree: typeof raw.categoryTree === 'string' && raw.categoryTree.trim() ? raw.categoryTree.trim() : null,
    manufacturer: typeof raw.manufacturer === 'string' && raw.manufacturer.trim() ? raw.manufacturer.trim() : null,
    sellingPoint: formatSellingPoint(raw, feedId),
    fyndwareClassId: Number.isFinite(raw.fyndwareClassId) ? raw.fyndwareClassId : null,
    fyndwareClassName: typeof raw.fyndwareClassName === 'string' && raw.fyndwareClassName.trim() ? raw.fyndwareClassName.trim() : null,
    fyndwareCondition: typeof raw.fyndwareCondition === 'string' && raw.fyndwareCondition.trim() ? raw.fyndwareCondition.trim() : null,
    fyndwareParentId,
  };
}

function resolveApifyToken() {
  return process.env.APIFY_TOKEN?.trim() || '';
}

function extractTitleFromHtml(html) {
  const match = String(html ?? '').match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim().slice(0, 120) : null;
}

/** Parse one Webhallen JSON response into the same page shape as WEBHALLEN_PAGE_FUNCTION. */
export function parseWebhallenPageBody({
  body,
  statusCode = null,
  url,
  loadedUrl = null,
  feedId,
  page = 1,
  pageSize = WEBHALLEN_PAGE_SIZE,
}) {
  const meta = {
    feed: feedId || null,
    page: page || 1,
    url,
    loadedUrl: loadedUrl || url || null,
    statusCode,
  };
  let payload = null;
  let parseError = null;
  try {
    payload = body ? JSON.parse(String(body)) : null;
  } catch (err) {
    parseError = err.message;
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.products)) {
    return {
      ...meta,
      found: false,
      error: parseError ? `parse error: ${parseError}` : 'no products array in response',
      title: extractTitleFromHtml(body),
    };
  }
  const products = [];
  for (const raw of payload.products) {
    if (feedId === 'outlet' && raw && raw.isFyndware === false) continue;
    const compact = compactWebhallenProduct(raw);
    if (compact) products.push(compact);
  }
  const total = typeof payload.filteredProductCount === 'number'
    ? payload.filteredProductCount
    : (typeof payload.totalProductCount === 'number' ? payload.totalProductCount : products.length);
  const out = {
    ...meta,
    found: true,
    pageSize,
    total,
    products,
  };
  if (page === 1) {
    out.categories = Array.isArray(payload.categories)
      ? payload.categories
        .filter((c) => c && c.name)
        .map((c) => ({ id: c.id ?? null, name: String(c.name).slice(0, 120) }))
      : [];
  }
  return out;
}

async function fetchWebhallenPagesViaProxy({ planned, proxyUrl, proxyFetch = fetchViaWatcherProxy, logger = console }) {
  const startedAtMs = Date.now();
  const pages = [];

  for (const feed of planned) {
    const firstUrl = buildWebhallenFeedUrl(feed.id, 1);
    const firstRes = await proxyFetch(firstUrl, {
      proxyUrl,
      headers: WEBHALLEN_API_HEADERS,
      logger,
    });
    const firstPage = parseWebhallenPageBody({
      body: firstRes.body,
      statusCode: firstRes.statusCode,
      url: firstUrl,
      loadedUrl: firstRes.loadedUrl,
      feedId: feed.id,
      page: 1,
    });
    pages.push(firstPage);
    if (!firstPage.found) continue;

    const needed = webhallenPagesFor(firstPage.total, firstPage.pageSize);
    if (needed > 1) {
      const restPageNums = Array.from({ length: needed - 1 }, (_, i) => i + 2);
      const restPages = await mapWithConcurrency(restPageNums, 2, async (pageNum) => {
        const pageUrl = buildWebhallenFeedUrl(feed.id, pageNum);
        try {
          const res = await proxyFetch(pageUrl, {
            proxyUrl,
            headers: WEBHALLEN_API_HEADERS,
            logger,
          });
          return parseWebhallenPageBody({
            body: res.body,
            statusCode: res.statusCode,
            url: pageUrl,
            loadedUrl: res.loadedUrl,
            feedId: feed.id,
            page: pageNum,
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
 * Fetches every page of each enabled Webhallen feed.
 *
 * Uses the configured proxy (`WEBHALLEN_PROXY_URL`, `WATCHER_PROXY_URL`, or
 * `ELGIGANTEN_PROXY_URL`) first at $0.00 cost; falls back to Apify's
 * `apify/cheerio-scraper` if no proxy is set or if the proxy fails/is blocked.
 * Never contacts webhallen.com from the Pi's home IP.
 *
 * @returns {Promise<{ run: { id, status, usageTotalUsd, runTimeSecs }, pages: object[], urls: number }>}
 */
export async function fetchWebhallenPages({
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
  const planned = (Array.isArray(feeds) ? feeds : []).filter((feed) => WEBHALLEN_FEEDS[feed?.id]);
  if (!planned.length) throw new Error('No Webhallen feeds enabled.');

  const resolvedProxy = proxyUrl !== undefined
    ? String(proxyUrl ?? '').trim()
    : (ApifyClientClass === ApifyClient ? resolveWatcherProxyUrl('WEBHALLEN') : '');

  if (resolvedProxy) {
    try {
      const proxyResult = await fetchWebhallenPagesViaProxy({
        planned,
        proxyUrl: resolvedProxy,
        proxyFetch,
        logger,
      });
      if (proxyResult.pages.some((p) => p?.found)) {
        return proxyResult;
      }
      if (!token) return proxyResult;
      logger.warn?.('[webhallen] Proxy returned no usable pages; falling back to Apify.');
    } catch (error) {
      if (!token) throw error;
      logger.warn?.(`[webhallen] Proxy fetch failed (${error.message}); falling back to Apify.`);
    }
  }

  if (!token) throw new Error('No Apify token configured (APIFY_TOKEN).');

  const startUrls = [];
  for (const feed of planned) {
    const pages = webhallenPagesFor((Number(feed.pages) || 1) * WEBHALLEN_PAGE_SIZE);
    const userData = {
      feed: feed.id,
      apiBaseUrl: `${WEBHALLEN_API_BASE}${WEBHALLEN_FEEDS[feed.id].apiPath}`,
      headers: WEBHALLEN_API_HEADERS,
      pageSize: WEBHALLEN_PAGE_SIZE,
      plannedPages: pages,
      maxPages: WEBHALLEN_MAX_PAGES_PER_FEED,
    };
    for (let page = 1; page <= pages; page += 1) {
      startUrls.push({
        url: buildWebhallenFeedUrl(feed.id, page),
        headers: WEBHALLEN_API_HEADERS,
        userData: { ...userData, page },
      });
    }
  }

  const client = new ApifyClientClass({ token });
  const run = await client.actor('apify/cheerio-scraper').call({
    startUrls,
    additionalMimeTypes: ['application/json'],
    pageFunction: WEBHALLEN_PAGE_FUNCTION,
    proxyConfiguration: { useApifyProxy: true },
    maxRequestsPerCrawl: planned.length * WEBHALLEN_MAX_PAGES_PER_FEED + 2,
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

// Komplett's settled-cost reader is generic (any Apify run id).
export { fetchApifyRunUsage };
