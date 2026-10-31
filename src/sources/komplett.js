import { ApifyClient } from 'apify-client';

import {
  normalizeProductIdentity
} from '../lib/utils.js';

// The `komplett-category` scan source that used to live here is archived in
// archive/scrapers/komplettCategory.js (see archive/scrapers/README.md).

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
