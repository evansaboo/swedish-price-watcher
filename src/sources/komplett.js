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

function mapKomplettCategoryProduct(product, source, refPriceCache, now) {
  const url = `https://www.komplett.se${product.url}`;
  const priceSek =
    typeof product.price?.listPriceNumber === 'number' ? Math.round(product.price.listPriceNumber) : null;

  if (!priceSek || !product.name) return null;

  const cached = refPriceCache[product.materialNumber];
  const originalProductPrice = cached?.originalProductPrice ?? null;
  const originalMaterialNumber = cached?.originalMaterialNumber ?? null;

  const imageFile = product.productImages?.[0];
  const imageUrl = imageFile ? `https://www.komplett.se/${imageFile.url}/${imageFile.fileName}` : null;

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

