import { ApifyClient } from 'apify-client';

import {
  normalizeProductIdentity
} from '../lib/utils.js';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_HEADERS = { 'user-agent': BROWSER_UA, accept: 'text/html,*/*' };

function guessCategoryFromUrl(url) {
  const pathname = new URL(url).pathname;

  if (/grafikkort|gpu/i.test(pathname)) {
    return 'gpu';
  }

  if (/horlurar|headset|gamingheadset|in-ear-horlurar/i.test(pathname)) {
    return 'audio';
  }

  if (/datorer-barbara-laptop|gaming-laptop|laptop/i.test(pathname)) {
    return 'laptop';
  }

  if (/stationar-dator|gamingdator/i.test(pathname)) {
    return 'desktop';
  }

  if (/mobiltelefoner/i.test(pathname)) {
    return 'phone';
  }

  if (/surfplattor|tablet/i.test(pathname)) {
    return 'tablet';
  }

  if (/bildskarm|gamingskarm/i.test(pathname)) {
    return 'monitor';
  }

  if (/tangentbord/i.test(pathname)) {
    return 'keyboard';
  }

  if (/gamingmus|\/mus\//i.test(pathname)) {
    return 'mouse';
  }

  return 'electronics';
}

function extractRefPriceFromProductHtml(html) {
  const attr =
    html.match(/komplett-demo-condition-info[^>]+data='([^']+)'/i)?.[1] ??
    html.match(/komplett-demo-condition-info[^>]+data="([^"]+)"/i)?.[1];

  if (!attr) return null;

  try {
    const data = JSON.parse(attr.replace(/&#xA0;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    return {
      originalProductPrice:
        typeof data.originalProductPrice === 'number' && data.originalProductPrice > 0
          ? Math.round(data.originalProductPrice)
          : null,
      originalMaterialNumber: data.originalMaterialNumber ? String(data.originalMaterialNumber).trim() : null,
    };
  } catch {
    return null;
  }
}

const KOMPLETT_ORIGIN = 'https://www.komplett.se';

/** Absolute product URL from the relative `url` Komplett embeds in its listing JSON. */
export function komplettProductUrl(product) {
  const relative = String(product?.url ?? '').trim();
  if (!relative) return null;
  if (/^https?:\/\//i.test(relative)) return relative;
  return `${KOMPLETT_ORIGIN}${relative.startsWith('/') ? '' : '/'}${relative}`;
}

/** First product image as an absolute URL, or null. */
export function komplettImageUrl(product) {
  const imageFile = product?.productImages?.[0];
  if (!imageFile?.url || !imageFile?.fileName) return null;
  return `${KOMPLETT_ORIGIN}/${imageFile.url}/${imageFile.fileName}`;
}

function mapKomplettCategoryProduct(product, source, refPriceCache, now) {
  const url = komplettProductUrl(product) ?? KOMPLETT_ORIGIN;
  const priceSek =
    typeof product.price?.listPriceNumber === 'number' ? Math.round(product.price.listPriceNumber) : null;

  if (!priceSek || !product.name) return null;

  const cached = refPriceCache[product.materialNumber];
  const originalProductPrice = cached?.originalProductPrice ?? null;
  const originalMaterialNumber = cached?.originalMaterialNumber ?? null;

  const imageUrl = komplettImageUrl(product);

  const cleanIdentity = normalizeProductIdentity(product.name.replace(/\b-?\s*b-?grade\b/gi, ''));

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId: product.materialNumber,
    productKey: cleanIdentity,
    title: product.name.trim(),
    url,
    category: guessCategoryFromUrl(url),
    condition: 'outlet',
    priceSek,
    marketValueSek: originalProductPrice ?? source.marketValueSek,
    referencePriceSek: originalProductPrice ?? source.referencePriceSek,
    referenceUrl: originalMaterialNumber ? `https://www.komplett.se/product/${originalMaterialNumber}/` : null,
    referenceTitle: null,
    referenceSourceLabel: originalProductPrice != null ? (source.label ?? source.id) : null,
    referenceMatchType: originalProductPrice != null ? 'listing-reference' : null,
    articleNumber: product.materialNumber,
    resaleEstimateSek: source.resaleEstimateSek,
    shippingEstimateSek: source.shippingEstimateSek,
    feesEstimateSek: source.feesEstimateSek,
    availability: product.stock?.availabilityText ?? product.stock?.availabilityStatus ?? 'unknown',
    description: product.description ?? null,
    imageUrl,
    notes: source.notes ?? null,
    seenAt: now,
  };
}

/**
 * Collect Komplett B-grade products by paging through the demovaror category HTML.
 *
 * Much faster than the sitemap approach:
 *  - Each page is ~400 KB and contains 24 products with full price/stock data embedded as JSON.
/**
 * The pageFunction executed inside Apify's cheerio-scraper actor.
 * It runs on Apify's infrastructure (bypasses Railway IP block) and extracts
 * the embedded products JSON array from each Komplett category page HTML.
 *
 * Each product in the array is saved as a separate dataset item, so the actor
 * output is a flat list of all products across all fetched pages.
 */
const CHEERIO_PAGE_FUNCTION = /* js */ `
async function pageFunction(context) {
  const html = context.body;
  const idx = html.indexOf('"products":[');
  if (idx === -1) return [];
  const start = idx + '"products":'.length;
  let depth = 0, end = start;
  for (let i = start; i < html.length && i < start + 600000; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  try { return JSON.parse(html.slice(start, end)); } catch { return []; }
}
`;

/**
 * Collect Komplett B-grade products via Apify's cheerio-scraper actor.
 *
 * The actor runs on Apify's infrastructure (not Railway), which sidesteps
 * Komplett's datacenter IP blocks. It uses Apify's rotating proxy internally.
 * Each category page (24 products/page) is fetched in parallel by the actor;
 * the products JSON embedded in the page HTML is extracted and returned as
 * flat dataset items.
 *
 * Reference prices are lazily fetched from individual product pages and cached
 * in sourceState so they are only fetched once per product.
 */
export async function collectFromKomplettCategory({ source, fetcher, sourceState, now, _ApifyClient }) {
  const maxPages = Number.isFinite(source.maxPages) ? source.maxPages : 10;
  const categoryUrl = source.categoryUrl ?? 'https://www.komplett.se/category/10066/demovaror';
  const refPriceLookupPerScan = Number.isFinite(source.refPriceLookupPerScan) ? source.refPriceLookupPerScan : 20;

  const token = _ApifyClient
    ? 'stub'
    : (process.env[source.apiTokenEnvVar ?? 'APIFY_TOKEN']?.trim() ?? process.env.APIFY_TOKEN?.trim() ?? '');
  if (!token) throw new Error(`No Apify token configured for ${source.label ?? source.id}.`);

  const refPriceCache = sourceState.refPriceCache ?? (sourceState.refPriceCache = {});
  const pageStates = sourceState.pageStates ?? (sourceState.pageStates = {});

  const ClientClass = _ApifyClient ?? ApifyClient;

  // --- Step 1: run cheerio-scraper on all category pages ---
  const startUrls = [];
  for (let i = 0; i < maxPages; i++) {
    startUrls.push({ url: i === 0 ? categoryUrl : `${categoryUrl}?page=${i}` });
  }

  const client = new ClientClass({ token });
  const run = await client.actor('apify/cheerio-scraper').call({
    startUrls,
    pageFunction: CHEERIO_PAGE_FUNCTION,
    proxyConfiguration: { useApifyProxy: true },
    maxRequestsPerCrawl: maxPages + 2,
  }, { timeout: Math.floor((source.actorTimeoutMs ?? 300_000) / 1000) });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  // Deduplicate by materialNumber across all pages
  const productMap = new Map();
  for (const item of items) {
    if (item.materialNumber && !productMap.has(item.materialNumber)) {
      productMap.set(item.materialNumber, item);
    }
  }

  const allProducts = [...productMap.values()];
  sourceState.lastDiscoveryCount = allProducts.length;

  // --- Step 2: lazily fetch reference prices for unknown products ---
  const needsRefPrice = allProducts.filter((p) => !refPriceCache[p.materialNumber]);
  const toFetch = needsRefPrice.slice(0, refPriceLookupPerScan);

  for (const product of toFetch) {
    const productUrl = `https://www.komplett.se${product.url}`;
    const productPageState = pageStates[productUrl] ?? (pageStates[productUrl] = {});

    try {
      const result = await fetcher.fetchText(source, productPageState, productUrl, {
        headers: PAGE_HEADERS,
        skipRobotsCheck: true,
        timeoutMs: 25_000,
      });
      const refData = result.body ? extractRefPriceFromProductHtml(result.body) : null;
      refPriceCache[product.materialNumber] = { ...(refData ?? {}), fetchedAt: now };
    } catch {
      refPriceCache[product.materialNumber] = { originalProductPrice: null, originalMaterialNumber: null, fetchedAt: now };
    }
  }

  // --- Step 3: build observations ---
  return allProducts.map((p) => mapKomplettCategoryProduct(p, source, refPriceCache, now)).filter(Boolean);
}


// ═══════════════════════════════════════════════════════════════
// Komplett demo-products watcher (demovaror) — see services/komplettDemoPoller.js
// ═══════════════════════════════════════════════════════════════

/**
 * Komplett's "Nyheter" sort. Verified 2026-10-31: `?sort=ReleaseDateDesc`
 * is echoed back in the page's embedded search state
 * (`"queryParameters":[{"key":"sort","value":"ReleaseDateDesc"}]`) and the
 * products come back in strictly descending materialNumber order, i.e. the
 * newest demo listing first. Only page 1 is used: `&page=N` is NOT Komplett's
 * paging parameter (`&page=1` returns `"pageNumber":0` again), so the watcher
 * relies on newest-first ordering instead of paging.
 */
export const KOMPLETT_DEMO_SORT = 'ReleaseDateDesc';

/** Newest-first listing URL (page 1) for one demo category ({ id, group, slug }). */
export function buildKomplettDemoUrl(category, { sort = KOMPLETT_DEMO_SORT } = {}) {
  const base = `${KOMPLETT_ORIGIN}/category/${encodeURIComponent(category.id)}/demovaror/${category.group}/${category.slug}`;
  return sort ? `${base}?sort=${encodeURIComponent(sort)}` : base;
}

/**
 * Runs inside apify/cheerio-scraper. Returns ONE dataset item per page with a
 * trimmed-down product list: Apify bills dataset writes by volume, and the
 * old one-item-per-product output made writes the most expensive part of a
 * run. `found: false` marks a page without the embedded products JSON (a
 * block or error page), which the poller treats as a failed category.
 */
export const KOMPLETT_DEMO_PAGE_FUNCTION = /* js */ `
async function pageFunction(context) {
  const html = context.body || '';
  const userData = context.request.userData || {};
  const meta = {
    categoryId: userData.categoryId || null,
    url: context.request.url,
    loadedUrl: context.request.loadedUrl || null,
    statusCode: context.response ? context.response.statusCode : null,
  };
  const idx = html.indexOf('"products":[');
  if (idx === -1) {
    return { ...meta, found: false, title: context.$ ? context.$('title').first().text().slice(0, 120) : null, products: [] };
  }
  const start = idx + '"products":'.length;
  let depth = 0, end = start;
  for (let i = start; i < html.length && i < start + 800000; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  let products = [];
  try { products = JSON.parse(html.slice(start, end)); } catch { return { ...meta, found: false, parseError: true, products: [] }; }
  const ti = html.indexOf('"totalNumberOfResultsMatchingQuery":');
  const searchState = ti === -1 ? '' : html.slice(ti, ti + 800);
  const total = searchState.match(/"totalNumberOfResultsMatchingQuery":(\\d+)/);
  const onPage = searchState.match(/"numberOfResults":(\\d+)/);
  const sort = searchState.match(/"sort":"([A-Za-z]+)"/);
  return {
    ...meta,
    found: true,
    total: total ? Number(total[1]) : null,
    // Komplett sometimes reports results it didn't server-render
    // ("numberOfResults":1 with "products":[]); the poller checks this.
    numberOfResults: onPage ? Number(onPage[1]) : null,
    sort: sort ? sort[1] : null,
    products: products.map((p) => ({
      materialNumber: p.materialNumber,
      name: p.name,
      url: p.url,
      manufacturerPartNumber: p.manufacturerPartNumber || null,
      description: typeof p.description === 'string' ? p.description.slice(0, 300) : null,
      price: { listPriceNumber: p.price ? p.price.listPriceNumber : null },
      stock: p.stock ? {
        availabilityStatus: p.stock.availabilityStatus,
        availabilityQuantity: p.stock.availabilityQuantity,
        availabilityText: p.stock.availabilityText,
      } : null,
      productImages: Array.isArray(p.productImages) ? p.productImages.slice(0, 1).map((img) => ({ url: img.url, fileName: img.fileName })) : [],
    })),
  };
}
`;

/** Komplett reports stock as e.g. { availabilityStatus: 'Stocked', availabilityQuantity: '1' }. */
export function isKomplettInStock(stock) {
  if (!stock || typeof stock !== 'object') return false;
  const quantity = Number.parseInt(String(stock.availabilityQuantity ?? ''), 10);
  if (Number.isFinite(quantity) && quantity > 0) return true;
  const status = String(stock.availabilityStatus ?? '');
  return /^(in)?stock(ed)?$/i.test(status);
}

/** Map one embedded listing product to the demo watcher's compact record. */
export function mapKomplettDemoProduct(product, categoryId = null) {
  if (!product || typeof product !== 'object') return null;
  const id = String(product.materialNumber ?? '').trim();
  const title = String(product.name ?? '').trim();
  const url = komplettProductUrl(product);
  if (!id || !title || !url) return null;

  const rawPrice = product.price?.listPriceNumber;
  const priceSek = typeof rawPrice === 'number' && Number.isFinite(rawPrice) && rawPrice > 0 ? Math.round(rawPrice) : null;

  return {
    id,
    title,
    url,
    imageUrl: komplettImageUrl(product),
    priceSek,
    inStock: isKomplettInStock(product.stock),
    availabilityText: product.stock?.availabilityText ?? product.stock?.availabilityStatus ?? null,
    manufacturerPartNumber: product.manufacturerPartNumber ?? null,
    productKey: normalizeProductIdentity(title.replace(/\b-?\s*b-?grade\b/gi, '')),
    categoryId: categoryId == null ? null : String(categoryId),
  };
}

function resolveApifyToken(envVar = 'APIFY_TOKEN') {
  return process.env[envVar]?.trim() || process.env.APIFY_TOKEN?.trim() || '';
}

/**
 * One cheerio-scraper run fetching page 1 (newest first) of every category.
 *
 * Never throws on a failed *run*: the caller still needs the run's cost.
 * Throws only when the actor could not be started or read at all.
 *
 * @returns {Promise<{ run: { id, status, usageTotalUsd, runTimeSecs }, pages: object[] }>}
 */
export async function fetchKomplettDemoPages({
  categories,
  token = resolveApifyToken(),
  ApifyClientClass = ApifyClient,
  memoryMbytes = 256,
  timeoutSecs = 180,
  maxRequestRetries = 2,
}) {
  if (!token) throw new Error('No Apify token configured (APIFY_TOKEN).');
  if (!Array.isArray(categories) || !categories.length) throw new Error('No Komplett demo categories selected.');

  const startUrls = categories.map((category) => ({
    url: buildKomplettDemoUrl(category),
    userData: { categoryId: String(category.id) },
  }));

  const client = new ApifyClientClass({ token });
  const run = await client.actor('apify/cheerio-scraper').call({
    startUrls,
    pageFunction: KOMPLETT_DEMO_PAGE_FUNCTION,
    proxyConfiguration: { useApifyProxy: true },
    maxRequestsPerCrawl: startUrls.length + 2,
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
  };
}

/**
 * Apify settles a run's usage a little after it finishes (a 3-URL run read
 * $0.00027 on completion and $0.00045 once settled), so the poller re-reads
 * the previous run's final cost on the next tick. This is a free API call.
 */
export async function fetchApifyRunUsage({ runId, token = resolveApifyToken(), ApifyClientClass = ApifyClient }) {
  if (!runId || !token) return null;
  const client = new ApifyClientClass({ token });
  const run = await client.run(runId).get();
  return Number.isFinite(run?.usageTotalUsd) ? run.usageTotalUsd : null;
}
