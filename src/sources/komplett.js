import { XMLParser } from 'fast-xml-parser';
import { load } from 'cheerio';
import { ApifyClient } from 'apify-client';

import {
  absoluteUrl,
  getUrlPathSegments,
  normalizeProductIdentity,
  parseIsoDate,
  parseSekValue,
  slugify,
  stripText
} from '../lib/utils.js';

const sitemapParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true
});

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SITEMAP_HEADERS = { 'user-agent': BROWSER_UA, accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8' };
const PAGE_HEADERS = { 'user-agent': BROWSER_UA, accept: 'text/html,*/*' };
const SITEMAP_TIMEOUT_MS = 30_000; // tight timeout — we abort early via maxItems

/**
 * Stream-read a sitemap XML, collecting <loc>/<lastmod> entries that satisfy
 * `locFilter(loc)`.  Aborts the HTTP connection as soon as `maxItems` matching
 * entries are found or `maxBytes` have been read (whichever comes first).
 *
 * This avoids downloading the full (often multi-MB) sitemap.products.xml when
 * only a small subset of URLs is required.
 */
async function streamSitemapEntries(sitemapUrl, headers, { maxItems = 200, maxBytes = 8_000_000, timeoutMs = 90_000, locFilter = () => true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('sitemap stream timeout')), timeoutMs);

  try {
    const response = await fetch(sitemapUrl, { headers, signal: controller.signal });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${sitemapUrl}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let bytesRead = 0;
    const entries = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.length;
      buffer += decoder.decode(value, { stream: true });

      // Parse complete <url>…</url> blocks from the accumulated buffer.
      let blockStart;
      while ((blockStart = buffer.indexOf('<url>')) !== -1) {
        const blockEnd = buffer.indexOf('</url>', blockStart);
        if (blockEnd === -1) break; // incomplete block — wait for more data

        const block = buffer.slice(blockStart, blockEnd + 6);
        buffer = buffer.slice(blockEnd + 6);

        const locMatch = block.match(/<loc>(.*?)<\/loc>/s);
        const lastmodMatch = block.match(/<lastmod>(.*?)<\/lastmod>/s);
        if (locMatch && locFilter(locMatch[1].trim())) {
          entries.push({ loc: locMatch[1].trim(), lastmod: lastmodMatch?.[1].trim() ?? null });
        }

        if (entries.length >= maxItems) {
          reader.cancel().catch(() => {});
          return entries;
        }
      }

      if (bytesRead >= maxBytes) {
        reader.cancel().catch(() => {});
        break;
      }
    }

    return entries;
  } finally {
    clearTimeout(timer);
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function pathMatches(url, includePaths = [], excludePaths = []) {
  const pathname = new URL(url).pathname;

  if (includePaths.length && !includePaths.some((segment) => pathname.includes(segment))) {
    return false;
  }

  if (excludePaths.some((segment) => pathname.includes(segment))) {
    return false;
  }

  return true;
}

function categoryRootMatches(url, categoryRoots = []) {
  if (!categoryRoots.length) {
    return true;
  }

  const segments = getUrlPathSegments(url);
  return categoryRoots.some((root) => segments.includes(root));
}

function updatedRecentlyEnough(entry, updatedSinceDays) {
  if (!Number.isFinite(updatedSinceDays) || updatedSinceDays <= 0 || !entry.lastmod) {
    return true;
  }

  const parsedDate = parseIsoDate(entry.lastmod);

  if (parsedDate == null) {
    return true;
  }

  return parsedDate >= Date.now() - updatedSinceDays * 24 * 60 * 60 * 1000;
}

function parseSitemapEntries(xml) {
  const parsed = sitemapParser.parse(xml);
  const urls = asArray(parsed?.urlset?.url);

  return urls
    .map((entry) => ({
      loc: stripText(entry.loc),
      lastmod: stripText(entry.lastmod)
    }))
    .filter((entry) => entry.loc.includes('/product/'));
}

function latestFirst(left, right) {
  const leftDate = parseIsoDate(left.lastmod) ?? 0;
  const rightDate = parseIsoDate(right.lastmod) ?? 0;
  return rightDate - leftDate;
}

function getUrlSlug(url) {
  return getUrlPathSegments(url).at(-1) ?? '';
}

function buildReferenceIndex(entries, source) {
  const index = new Map();

  for (const entry of entries) {
    if (!pathMatches(entry.loc, source.matchReferenceIncludePaths, source.matchReferenceExcludePaths)) {
      continue;
    }

    const normalizedSlug = normalizeProductIdentity(getUrlSlug(entry.loc));

    if (!index.has(normalizedSlug)) {
      index.set(normalizedSlug, []);
    }

    index.get(normalizedSlug).push(entry);
  }

  for (const matches of index.values()) {
    matches.sort(latestFirst);
  }

  return index;
}

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

function extractVisibleText(html) {
  const $ = load(html);
  $('script, style, noscript, svg').remove();
  return stripText($('body').text());
}

function findPriceText(pageText) {
  const explicitLabelMatch = pageText.match(/B-grade pris\s*([0-9][\d\s\u00a0.]*(?::-|kr))/i);

  if (explicitLabelMatch) {
    return explicitLabelMatch[1];
  }

  const priceBeforeAvailability = pageText.match(
    /([0-9][\d\s\u00a0.]*(?::-|kr))\s*(\d+\s*st i lager|i lager|slut i lager|ej i lager|beställningsvara|fåtal kvar)/i
  );

  if (priceBeforeAvailability) {
    return priceBeforeAvailability[1];
  }

  const genericPrice = pageText.match(/(?:pris|price)\s*([0-9][\d\s\u00a0.]*(?::-|kr))/i);
  return genericPrice?.[1] ?? null;
}

function findAvailability(pageText) {
  return (
    pageText.match(/\d+\s*st i lager(?:\s*\([^)]*\))?/i)?.[0] ??
    pageText.match(/\b(?:i lager|slut i lager|ej i lager|beställningsvara|fåtal kvar)\b/i)?.[0] ??
    'unknown'
  );
}

export function parseKomplettProductPage({ html, url, source, now }) {
  const $ = load(html);
  const pageText = extractVisibleText(html);
  const title = stripText(
    $('h1').first().text() ||
      $('meta[name="title"]').attr('content') ||
      $('meta[property="og:title"]').attr('content') ||
      $('title').text().replace(/\s*\|\s*Komplett\.se$/i, '')
  );
  const description = stripText(
    $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content')
  );
  const imageUrl = absoluteUrl(
    url,
    $('meta[property="og:image:secure_url"]').attr('content') ||
      $('meta[property="og:image"]').attr('content') ||
      $('link[rel="image_src"]').attr('href') ||
      ''
  );
  const priceSek = parseSekValue(findPriceText(pageText));

  if (!title || priceSek == null) {
    return null;
  }

  const condition =
    source.condition === 'outlet' || /\/demovaror\//i.test(url) || /B-grade pris/i.test(pageText) || /\bB-Grade\b/i.test(title)
      ? 'outlet'
      : source.condition ?? 'new';
  const cleanIdentity = normalizeProductIdentity(title.replace(/\b-?\s*b-?grade\b/gi, ''));
  const segments = getUrlPathSegments(url);
  const productId = segments[1] ?? slugify(title);

  // Extract original price + original material number from the embedded custom element JSON.
  // Komplett embeds: <komplett-demo-condition-info data='{"originalProductPrice":1499,"originalMaterialNumber":"1330084",...}'>
  let originalProductPrice = null;
  let originalMaterialNumber = null;

  const demoInfoAttr = html.match(/komplett-demo-condition-info[^>]+data='([^']+)'/i)?.[1] ??
    html.match(/komplett-demo-condition-info[^>]+data="([^"]+)"/i)?.[1];

  if (demoInfoAttr) {
    try {
      const demoData = JSON.parse(demoInfoAttr.replace(/&#xA0;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      if (typeof demoData.originalProductPrice === 'number' && demoData.originalProductPrice > 0) {
        originalProductPrice = Math.round(demoData.originalProductPrice);
      }
      if (demoData.originalMaterialNumber) {
        originalMaterialNumber = String(demoData.originalMaterialNumber).trim();
      }
    } catch {
      // ignore parse errors — fall back to no reference price
    }
  }

  const referenceUrl = originalMaterialNumber
    ? `https://www.komplett.se/product/${originalMaterialNumber}/`
    : null;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId: productId,
    productKey: cleanIdentity,
    title,
    url,
    category: guessCategoryFromUrl(url),
    condition,
    priceSek,
    marketValueSek: originalProductPrice ?? source.marketValueSek,
    referencePriceSek: originalProductPrice ?? source.referencePriceSek,
    referenceUrl,
    referenceTitle: null,
    referenceSourceLabel: originalProductPrice != null ? (source.label ?? source.id) : null,
    referenceMatchType: originalProductPrice != null ? 'listing-reference' : null,
    articleNumber: originalMaterialNumber,
    resaleEstimateSek: source.resaleEstimateSek,
    shippingEstimateSek: source.shippingEstimateSek,
    feesEstimateSek: source.feesEstimateSek,
    availability: findAvailability(pageText),
    description,
    imageUrl,
    notes: source.notes ?? null,
    seenAt: now
  };
}

function findReferenceCandidate(outletEntry, referenceIndex) {
  const normalizedSlug = normalizeProductIdentity(getUrlSlug(outletEntry.loc));
  const exactMatches = referenceIndex.get(normalizedSlug) ?? [];

  if (exactMatches.length) {
    return exactMatches[0];
  }

  let fallbackMatch = null;

  for (const [candidateSlug, entries] of referenceIndex.entries()) {
    if (candidateSlug.includes(normalizedSlug) || normalizedSlug.includes(candidateSlug)) {
      fallbackMatch = entries[0];
      break;
    }
  }

  return fallbackMatch;
}

/**
 * Extract the embedded `products` JSON array from a Komplett category page HTML.
 * Komplett inlines the full product list (with prices, stock, images) as a JS
 * variable — no separate API call needed.
 */
function extractProductsFromCategoryHtml(html) {
  const idx = html.indexOf('"products":[');
  if (idx === -1) return [];

  const start = idx + '"products":'.length;
  let depth = 0;
  let end = start;

  for (let i = start; i < html.length && i < start + 600_000; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }

  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    return [];
  }
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
  const html = context.$.html();
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

export async function collectFromKomplettSitemap({ source, fetcher, sourceState, now }) {
  const maxItems = Number.isFinite(source.maxItems) ? source.maxItems : 50;

  // Stream only /demovaror/ entries and abort as soon as we have maxItems * 4 of them.
  // Reference prices are extracted directly from each product page (originalProductPrice
  // in the komplett-demo-condition-info element), so we don't need reference URLs from
  // the sitemap at all.
  const candidateEntries = await streamSitemapEntries(source.sitemapUrl, SITEMAP_HEADERS, {
    maxItems: maxItems * 4, // abort early — stops reading after finding enough
    maxBytes: source.sitemapMaxBytes ?? 3_000_000, // hard cap at 3 MB (< 10s on slow links)
    timeoutMs: source.sitemapTimeoutMs ?? SITEMAP_TIMEOUT_MS,
    locFilter: (loc) => pathMatches(loc, source.includePaths, source.excludePaths),
  }).then((entries) =>
    entries
      .filter((entry) => categoryRootMatches(entry.loc, source.categoryRoots))
      .filter((entry) => updatedRecentlyEnough(entry, source.updatedSinceDays))
      .sort(latestFirst)
      .slice(0, maxItems)
  );

  const pageStates = sourceState.pageStates ?? (sourceState.pageStates = {});
  const observations = [];

  sourceState.lastDiscoveryCount = candidateEntries.length;

  for (const entry of candidateEntries) {
    const pageState = pageStates[entry.loc] ?? (pageStates[entry.loc] = {});
    const pageResult = await fetcher.fetchText(source, pageState, entry.loc, {
      headers: PAGE_HEADERS,
      skipRobotsCheck: true,
    });
    const observation =
      pageResult.notModified && pageState.cachedObservation
        ? { ...pageState.cachedObservation, seenAt: now }
        : parseKomplettProductPage({ html: pageResult.body, url: entry.loc, source, now });

    if (!observation) continue;

    pageState.cachedObservation = observation;
    observations.push(observation);
  }

  return observations;
}
