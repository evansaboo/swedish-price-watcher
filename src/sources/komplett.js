import { ApifyClient } from 'apify-client';

import {
  normalizeProductIdentity
} from '../lib/utils.js';
import {
  fetchViaWatcherProxy,
  mapWithConcurrency,
  resolveWatcherProxyUrl,
} from '../services/watcherProxy.js';

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
/**
 * Komplett's resized product image (verified 2026-11-03): `/img/p/<size>/<id>.jpg`.
 * Size 400 is ~23 KB, versus 1+ MB for the original under `product-media/…`,
 * and Komplett serves it without a referer check, so it can be hotlinked.
 */
export function komplettThumbnailUrl(materialNumber, size = 400) {
  const id = String(materialNumber ?? '').trim();
  return /^\d+$/.test(id) ? `${KOMPLETT_ORIGIN}/img/p/${size}/${id}.jpg` : null;
}

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
 * newest demo listing first.
 *
 * Paging (verified 2026-11-01): `&page=N` works like "load more". It returns the
 * first N×24 products in one page (`page=2` gives 48), and `page=1` is the same as
 * no page. So one request per category covers the whole category when N is
 * ceil(total/24).
 */
export const KOMPLETT_DEMO_PAGE_SIZE = 24;
export const KOMPLETT_DEMO_MAX_PAGES = 5;

export const KOMPLETT_FEEDS = Object.freeze({
  deals: Object.freeze({
    id: 'deals',
    label: 'Campaign deals (Kampanjer)',
    shortLabel: 'Kampanjer',
    url: `${KOMPLETT_ORIGIN}/kampanj/veckans-hetaste?sort=ReleaseDateDesc`,
  }),
  outlet: Object.freeze({
    id: 'outlet',
    label: 'B-grade / demo (Demovaror)',
    shortLabel: 'Demovaror',
    url: `${KOMPLETT_ORIGIN}/category/10066/demovaror?sort=ReleaseDateDesc`,
  }),
});

export const KOMPLETT_DEALS_DEPARTMENTS = Object.freeze({
  'deals-datorutrustning': Object.freeze({
    id: 'deals-datorutrustning',
    feed: 'deals',
    label: 'Datorutrustning (Kampanjer)',
    url: `${KOMPLETT_ORIGIN}/category/10000/datorutrustning?kom_isDiscounted=%27true%27&sort=ReleaseDateDesc&page=6`,
  }),
  'deals-gaming': Object.freeze({
    id: 'deals-gaming',
    feed: 'deals',
    label: 'Gaming (Kampanjer)',
    url: `${KOMPLETT_ORIGIN}/category/10431/gaming?kom_isDiscounted=%27true%27&sort=ReleaseDateDesc&page=6`,
  }),
  'deals-datorer': Object.freeze({
    id: 'deals-datorer',
    feed: 'deals',
    label: 'Datorer & tillbehör (Kampanjer)',
    url: `${KOMPLETT_ORIGIN}/category/10723/dator-tillbehor?kom_isDiscounted=%27true%27&sort=ReleaseDateDesc&page=4`,
  }),
  'deals-tv-ljud-bild': Object.freeze({
    id: 'deals-tv-ljud-bild',
    feed: 'deals',
    label: 'TV, ljud & bild (Kampanjer)',
    url: `${KOMPLETT_ORIGIN}/category/10719/tv-ljud-bild?kom_isDiscounted=%27true%27&sort=ReleaseDateDesc&page=6`,
  }),
  'deals-mobil-klockor': Object.freeze({
    id: 'deals-mobil-klockor',
    feed: 'deals',
    label: 'Mobil, tablets & klockor (Kampanjer)',
    url: `${KOMPLETT_ORIGIN}/category/10444/mobil-tablets-klockor?kom_isDiscounted=%27true%27&sort=ReleaseDateDesc&page=6`,
  }),
  'deals-hem-fritid': Object.freeze({
    id: 'deals-hem-fritid',
    feed: 'deals',
    label: 'Hem & fritid (Kampanjer)',
    url: `${KOMPLETT_ORIGIN}/category/10560/hem-fritid?kom_isDiscounted=%27true%27&sort=ReleaseDateDesc&page=6`,
  }),
  'deals-all': Object.freeze({
    id: 'deals-all',
    feed: 'deals',
    label: 'Veckans hetaste (Kampanjer)',
    url: `${KOMPLETT_ORIGIN}/kampanj/veckans-hetaste?sort=ReleaseDateDesc&page=6`,
  }),
});

export const KOMPLETT_OUTLET_ALL_TARGET = Object.freeze({
  id: 'outlet-all',
  feed: 'outlet',
  label: 'Alla demovaror',
  url: `${KOMPLETT_ORIGIN}/category/10066/demovaror?sort=ReleaseDateDesc&page=6`,
});

const CATEGORY_TO_DEALS_DEPARTMENTS = Object.freeze({
  '10073': ['deals-datorutrustning'],
  '10072': ['deals-datorutrustning'],
  '11203': ['deals-datorutrustning', 'deals-datorer'],
  '9104': ['deals-datorutrustning', 'deals-gaming', 'deals-tv-ljud-bild'],
  '9105': ['deals-datorutrustning'],
  '10071': ['deals-datorutrustning'],
  '9102': ['deals-datorutrustning', 'deals-gaming'],
  '10075': ['deals-datorer', 'deals-datorutrustning'],
  '10076': ['deals-datorutrustning'],
  '10542': ['deals-datorer'],
  '9103': ['deals-datorutrustning', 'deals-gaming'],
  '11258': ['deals-gaming'],
  '10140': ['deals-datorer', 'deals-gaming'],
  '10141': ['deals-datorer', 'deals-gaming'],
  '12423': ['deals-gaming', 'deals-datorer'],
  '10142': ['deals-datorer'],
  '10551': ['deals-tv-ljud-bild'],
  '10661': ['deals-tv-ljud-bild'],
  '11001': ['deals-tv-ljud-bild'],
  '11149': ['deals-mobil-klockor'],
  '965344': ['deals-mobil-klockor'],
  '965343': ['deals-mobil-klockor'],
  '11147': ['deals-hem-fritid'],
  '21478': ['deals-hem-fritid'],
});

/** Return the normal-deals department target descriptors needed to cover `categoryIds` (empty = all main departments). */
export function dealsTargetsForCategories(categoryIds = [], { includeAll = false } = {}) {
  const deptIds = new Set();
  if (includeAll || !Array.isArray(categoryIds) || categoryIds.length === 0) {
    deptIds.add('deals-all');
    deptIds.add('deals-datorutrustning');
    deptIds.add('deals-gaming');
    deptIds.add('deals-datorer');
    deptIds.add('deals-tv-ljud-bild');
    deptIds.add('deals-mobil-klockor');
  } else {
    for (const catId of categoryIds) {
      const mapped = CATEGORY_TO_DEALS_DEPARTMENTS[String(catId)] ?? ['deals-all'];
      for (const id of mapped) deptIds.add(id);
    }
  }
  return [...deptIds].map((id) => KOMPLETT_DEALS_DEPARTMENTS[id]).filter(Boolean);
}

const DEMO_SLUG_TO_CATEGORY_ID = Object.freeze({
  'demo-bildskarmar': '10073',
  'demo-grafikkort': '10072',
  'demo-haarddiskar': '11203',
  'demo-headset': '9104',
  'demo-minne-ram': '9105',
  'demo-moderkort': '10071',
  'demo-mus': '9102',
  'demo-natverk': '10075',
  'demo-skrivare': '10542',
  'demo-tangentbord': '9103',
  'demo-gaming': '11258',
  'demo-barbara-datorer': '10140',
  'demo-stationara-datorer': '10141',
  'komplett-pc': '12423',
  'demo-ovrigt-i-datorer': '10142',
  'demo-tvprojektorer': '10551',
  'demo-hi-fistereodvd': '10661',
  'demo-mobiltelefoner': '11149',
  'demo-tillbehor-till-mobiler-smartwatches': '965344',
  'demo-watches': '965343',
  'demo-hem-hushaall': '11147',
  'demo-traning-halsa': '21478',
});

/**
 * Infer a catalog categoryId ('10072', '10071', '12423', etc.) from a Komplett
 * product's URL and title when the page was a broad department or campaign feed.
 */
export function inferKomplettCategoryId(product, fallbackCategoryId = null) {
  const fb = fallbackCategoryId == null ? '' : String(fallbackCategoryId).trim();
  if (fb && /^\d+$/.test(fb)) return fb;

  const url = String(product?.url ?? '').toLowerCase();
  const title = String(product?.name ?? product?.title ?? '').toLowerCase();

  const demoMatch = url.match(/\/demovaror\/([^/]+)\/([^/]+)\//);
  if (demoMatch) {
    const [, group, slug] = demoMatch;
    if (slug === 'demo-ovrigt') {
      return group === 'tv-ljud-bild' ? '11001' : '10076';
    }
    if (DEMO_SLUG_TO_CATEGORY_ID[slug]) return DEMO_SLUG_TO_CATEGORY_ID[slug];
  }

  if (url.includes('/datorkomponenter/grafikkort/')) return '10072';
  if (/\/datorkomponenter\/moderkort\/(?!tillbehor)/.test(url)) return '10071';
  if (url.includes('/bildskarm/bildskarmar/') || url.includes('/bildskarm/')) return '10073';
  if (url.includes('/lagring/harddisk-ssd/') || url.includes('/lagring/minneskort') || url.includes('/lagring/extern')) return '11203';
  if (url.includes('/datorkomponenter/minne/')) return '9105';
  if (url.includes('/kringutrustning/mus/') || url.includes('/gaming-utrustning/gamingmus/')) return '9102';
  if (url.includes('/kringutrustning/tangentbord/') || url.includes('/gaming-utrustning/gamingtangentbord/')) return '9103';
  if (url.includes('/kringutrustning/headset/') || url.includes('/gaming-utrustning/gaming-headset/') || url.includes('/tv-ljud-bild/horlurar/')) return '9104';
  if (url.includes('/natverk/')) return '10075';
  if (url.includes('/skrivare/') || url.includes('/skanner/')) return '10542';
  if (title.includes('komplett-pc') || url.includes('/gamingdator/gamingdator-stationar/')) return '12423';
  if (url.includes('/gamingdator/gaming-laptop/') || url.includes('/datorer-barbara/')) return '10140';
  if (url.includes('/datorer-stationara/')) return '10141';
  if (url.includes('/datorutrustning/')) return '10076';
  if (url.includes('/dator-tillbehor/')) return '10142';
  if (url.includes('/gaming/')) return '11258';
  if (url.includes('/tv-ljud-bild/tv/') || url.includes('/tv-ljud-bild/projektorer/')) return '10551';
  if (url.includes('/tv-ljud-bild/hogtalare-hi-fi/') || url.includes('/tv-ljud-bild/soundbar/')) return '10661';
  if (url.includes('/tv-ljud-bild/')) return '11001';
  if (url.includes('/mobiltelefoner/')) return '11149';
  if (url.includes('/smartklockor/') || url.includes('/aktivitetsarmband/')) return '965343';
  if (url.includes('/mobil-tablets-klockor/')) return '965344';
  if (url.includes('/sport-fritid/') || url.includes('/traning')) return '21478';
  if (url.includes('/hem-fritid/') || url.includes('/vitvaror/')) return '11147';

  return fb || null;
}

/** Smallest `page` value that shows `total` products, clamped to [1, MAX_PAGES]. */
export function komplettDemoPagesFor(total) {
  const n = Number(total);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(KOMPLETT_DEMO_MAX_PAGES, Math.max(1, Math.ceil(n / KOMPLETT_DEMO_PAGE_SIZE)));
}
export const KOMPLETT_DEMO_SORT = 'ReleaseDateDesc';

/** Newest-first listing URL (page 1) for one demo category ({ id, group, slug }) or custom target. */
export function buildKomplettDemoUrl(category, { sort = KOMPLETT_DEMO_SORT, pages = 1 } = {}) {
  if (category?.url) return String(category.url);
  const base = `${KOMPLETT_ORIGIN}/category/${encodeURIComponent(category.id)}/demovaror/${category.group}/${category.slug}`;
  const params = [];
  if (sort) params.push(`sort=${encodeURIComponent(sort)}`);
  const n = Math.floor(Number(pages));
  if (Number.isFinite(n) && n > 1) params.push(`page=${Math.min(n, KOMPLETT_DEMO_MAX_PAGES)}`);
  return params.length ? `${base}?${params.join('&')}` : base;
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
    feed: userData.feed || null,
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
      price: {
        listPriceNumber: p.price ? p.price.listPriceNumber : null,
        discountNumber: p.price && typeof p.price.discountNumber === 'number' ? p.price.discountNumber : null,
      },
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

/** Map one embedded listing product to the watcher's compact record. */
export function mapKomplettDemoProduct(product, categoryId = null, feed = null) {
  if (!product || typeof product !== 'object') return null;
  const id = String(product.materialNumber ?? '').trim();
  const title = String(product.name ?? '').trim();
  const url = komplettProductUrl(product);
  if (!id || !title || !url) return null;

  const rawPrice = product.price?.listPriceNumber;
  const priceSek = typeof rawPrice === 'number' && Number.isFinite(rawPrice) && rawPrice > 0 ? Math.round(rawPrice) : null;
  const rawDiscount = product.price?.discountNumber;
  const discountSek = typeof rawDiscount === 'number' && Number.isFinite(rawDiscount) && rawDiscount > 0 ? Math.round(rawDiscount) : 0;
  const listPriceSek = priceSek != null && discountSek > 0 ? priceSek + discountSek : null;
  const discountPct = listPriceSek && listPriceSek > priceSek
    ? Math.round(((listPriceSek - priceSek) / listPriceSek) * 100)
    : 0;

  const isDemoProduct = /\/demovaror\//i.test(url) || /\b-?\s*b-?grade\b/i.test(title);
  const resolvedFeed = feed === 'deals' || feed === 'outlet'
    ? feed
    : isDemoProduct ? 'outlet' : 'outlet';
  const resolvedCategoryId = inferKomplettCategoryId(product, categoryId);

  return {
    id,
    feed: resolvedFeed,
    title,
    url,
    imageUrl: komplettThumbnailUrl(id) ?? komplettImageUrl(product),
    priceSek,
    listPriceSek,
    discountPct,
    inStock: isKomplettInStock(product.stock),
    availabilityText: product.stock?.availabilityText ?? product.stock?.availabilityStatus ?? null,
    manufacturerPartNumber: product.manufacturerPartNumber ?? null,
    // Komplett's one-line summary. For PCs it is the spec list ("GeForce RTX 5090,
    // Ryzen 7 9800X3D, …"), the only place the GPU appears.
    description: typeof product.description === 'string' && product.description.trim()
      ? product.description.trim().slice(0, 300)
      : null,
    productKey: normalizeProductIdentity(title.replace(/\b-?\s*b-?grade\b/gi, '')),
    categoryId: resolvedCategoryId == null ? null : String(resolvedCategoryId),
  };
}

function resolveApifyToken(envVar = 'APIFY_TOKEN') {
  return process.env[envVar]?.trim() || process.env.APIFY_TOKEN?.trim() || '';
}

function extractTitleFromHtml(html) {
  const match = String(html ?? '').match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim().slice(0, 120) : null;
}

/** Parse one Komplett category HTML body into the same dataset item shape as KOMPLETT_DEMO_PAGE_FUNCTION. */
export function parseKomplettDemoPageBody({
  body,
  statusCode = null,
  url,
  loadedUrl = null,
  categoryId,
  feed = null,
}) {
  const html = String(body ?? '');
  const meta = {
    categoryId: categoryId || null,
    feed: feed || null,
    url,
    loadedUrl: loadedUrl || url || null,
    statusCode,
  };
  const idx = html.indexOf('"products":[');
  if (idx === -1) {
    return { ...meta, found: false, title: extractTitleFromHtml(html), products: [] };
  }
  const start = idx + '"products":'.length;
  let depth = 0;
  let end = start;
  for (let i = start; i < html.length && i < start + 800000; i += 1) {
    if (html[i] === '[') depth += 1;
    else if (html[i] === ']') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  let products = [];
  try {
    products = JSON.parse(html.slice(start, end));
  } catch {
    return { ...meta, found: false, parseError: true, products: [] };
  }
  const ti = html.indexOf('"totalNumberOfResultsMatchingQuery":');
  const searchState = ti === -1 ? '' : html.slice(ti, ti + 800);
  const total = searchState.match(/"totalNumberOfResultsMatchingQuery":(\d+)/);
  const onPage = searchState.match(/"numberOfResults":(\d+)/);
  const sort = searchState.match(/"sort":"([A-Za-z]+)"/);
  return {
    ...meta,
    found: true,
    total: total ? Number(total[1]) : null,
    numberOfResults: onPage ? Number(onPage[1]) : null,
    sort: sort ? sort[1] : null,
    products: products.map((p) => ({
      materialNumber: p.materialNumber,
      name: p.name,
      url: p.url,
      manufacturerPartNumber: p.manufacturerPartNumber || null,
      description: typeof p.description === 'string' ? p.description.slice(0, 300) : null,
      price: {
        listPriceNumber: p.price ? p.price.listPriceNumber : null,
        discountNumber: p.price && typeof p.price.discountNumber === 'number' ? p.price.discountNumber : null,
      },
      stock: p.stock ? {
        availabilityStatus: p.stock.availabilityStatus,
        availabilityQuantity: p.stock.availabilityQuantity,
        availabilityText: p.stock.availabilityText,
      } : null,
      productImages: Array.isArray(p.productImages)
        ? p.productImages.slice(0, 1).map((img) => ({ url: img.url, fileName: img.fileName }))
        : [],
    })),
  };
}

/**
 * Fetches page 1 (newest first) of every selected Komplett target page
 * (demovaror categories and/or normal deals departments).
 * Uses `KOMPLETT_PROXY_URL` or `WATCHER_PROXY_URL` first if configured; falls
 * back to Apify's `apify/cheerio-scraper`. Never contacts komplett.se from
 * the Pi's home IP.
 *
 * @returns {Promise<{ run: { id, status, usageTotalUsd, runTimeSecs }, pages: object[] }>}
 */
export async function fetchKomplettDemoPages({
  categories,
  token = resolveApifyToken(),
  ApifyClientClass = ApifyClient,
  proxyUrl,
  proxyFetch = fetchViaWatcherProxy,
  logger = console,
  memoryMbytes = 256,
  timeoutSecs = 180,
  maxRequestRetries = 2,
}) {
  if (!Array.isArray(categories) || !categories.length) throw new Error('No Komplett demo categories selected.');

  const resolvedProxy = proxyUrl !== undefined
    ? String(proxyUrl ?? '').trim()
    : (ApifyClientClass === ApifyClient ? resolveWatcherProxyUrl('KOMPLETT') : '');

  if (resolvedProxy) {
    try {
      const startedAtMs = Date.now();
      const pages = await mapWithConcurrency(categories, 2, async (category) => {
        const url = buildKomplettDemoUrl(category, { pages: category.pages });
        const res = await proxyFetch(url, { proxyUrl: resolvedProxy, logger });
        return parseKomplettDemoPageBody({
          body: res.body,
          statusCode: res.statusCode,
          url,
          loadedUrl: res.loadedUrl,
          categoryId: String(category.id),
          feed: category.feed || null,
        });
      });
      const proxyResult = {
        run: {
          id: null,
          status: 'PROXY',
          usageTotalUsd: 0,
          runTimeSecs: Math.round((Date.now() - startedAtMs) / 100) / 10,
        },
        pages,
      };
      if (pages.some((p) => p?.found)) {
        return proxyResult;
      }
      if (!token) return proxyResult;
      logger.warn?.('[komplett-demo] Proxy returned no usable pages; falling back to Apify.');
    } catch (error) {
      if (!token) throw error;
      logger.warn?.(`[komplett-demo] Proxy fetch failed (${error.message}); falling back to Apify.`);
    }
  }

  if (!token) throw new Error('No Apify token configured (APIFY_TOKEN).');

  const startUrls = categories.map((category) => {
    const userData = { categoryId: String(category.id) };
    if (category.feed) userData.feed = String(category.feed);
    return {
      url: buildKomplettDemoUrl(category, { pages: category.pages }),
      userData,
    };
  });

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


/**
 * Fetch product thumbnails through Apify, for Discord attachments.
 *
 * Discord's image proxy can't load komplett.se (Akamai blocks it, like the
 * Pi's IP; verified 2026-11-03), so an embed image URL renders blank. Alerts
 * instead attach the image bytes, fetched here from Apify's IPs. Best effort:
 * on any failure the caller sends the alert without a picture.
 *
 * Returns { images: { [materialNumber]: { data: Buffer, contentType } }, runId }.
 */
const KOMPLETT_IMAGE_PAGE_FUNCTION = /* js */ `
async function pageFunction(context) {
  const body = context.body;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'binary');
  const type = String((context.response && context.response.headers && context.response.headers['content-type']) || '');
  if (!/^image\\//.test(type) || !buf.length || buf.length > 400000) {
    return { id: context.request.userData.id, ok: false, type, size: buf.length };
  }
  return { id: context.request.userData.id, ok: true, type, data: buf.toString('base64') };
}
`;

export async function fetchKomplettImages({
  ids,
  token = resolveApifyToken(),
  ApifyClientClass = ApifyClient,
  size = 400,
  memoryMbytes = 256,
  timeoutSecs = 90,
}) {
  const unique = [...new Set((ids ?? []).map((id) => String(id)).filter((id) => /^\d+$/.test(id)))].slice(0, 10);
  if (!token || !unique.length) return { images: {}, runId: null };
  const client = new ApifyClientClass({ token });
  const run = await client.actor('apify/cheerio-scraper').call({
    startUrls: unique.map((id) => ({
      url: komplettThumbnailUrl(id, size),
      userData: { id },
      // JPEG: Discord can't render AVIF, which Komplett sends when it's accepted.
      headers: { accept: 'image/jpeg,image/png,image/*;q=0.5' },
    })),
    pageFunction: KOMPLETT_IMAGE_PAGE_FUNCTION,
    additionalMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'],
    proxyConfiguration: { useApifyProxy: true },
    maxRequestsPerCrawl: unique.length + 2,
    maxRequestRetries: 1,
  }, { memory: memoryMbytes, timeout: timeoutSecs });
  const images = {};
  if (run?.defaultDatasetId) {
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    for (const item of items ?? []) {
      if (item?.ok && item.data && item.id) {
        images[String(item.id)] = { data: Buffer.from(item.data, 'base64'), contentType: item.type.split(';')[0] };
      }
    }
  }
  return { images, runId: run?.id ?? null };
}
