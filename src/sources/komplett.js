import { XMLParser } from 'fast-xml-parser';
import { load } from 'cheerio';

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
const SITEMAP_TIMEOUT_MS = 60_000; // sitemap XML can be several MB

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

export function parseKomplettProductPage({ html, url, source, now, referenceObservation = null }) {
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
    marketValueSek: referenceObservation?.priceSek ?? source.marketValueSek,
    referencePriceSek: referenceObservation?.priceSek ?? source.referencePriceSek,
    referenceUrl: referenceObservation?.url ?? null,
    referenceTitle: referenceObservation?.title ?? null,
    referenceSourceLabel: referenceObservation?.sourceLabel ?? null,
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

export async function collectFromKomplettSitemap({ source, fetcher, sourceState, now }) {
  const maxItems = Number.isFinite(source.maxItems) ? source.maxItems : 50;

  // Stream the sitemap, collecting both outlet entries AND potential reference entries.
  // Using maxBytes as the primary stop condition avoids the full-download timeout on Railway.
  const allEntries = await streamSitemapEntries(source.sitemapUrl, SITEMAP_HEADERS, {
    maxItems: 100_000, // rely on maxBytes, not item count
    maxBytes: source.sitemapMaxBytes ?? 10_000_000, // stop at 10 MB
    timeoutMs: source.sitemapTimeoutMs ?? SITEMAP_TIMEOUT_MS,
    locFilter: (loc) => {
      if (pathMatches(loc, source.includePaths, source.excludePaths)) return true;
      // Also keep reference candidates so we can build the reference index.
      if (source.referenceLookup) {
        return pathMatches(loc, source.matchReferenceIncludePaths, source.matchReferenceExcludePaths);
      }
      return false;
    },
  });

  const candidateEntries = allEntries
    .filter((entry) => pathMatches(entry.loc, source.includePaths, source.excludePaths))
    .filter((entry) => categoryRootMatches(entry.loc, source.categoryRoots))
    .filter((entry) => updatedRecentlyEnough(entry, source.updatedSinceDays))
    .sort(latestFirst)
    .slice(0, maxItems);

  const referenceIndex = source.referenceLookup ? buildReferenceIndex(allEntries, source) : new Map();
  const pageStates = sourceState.pageStates ?? (sourceState.pageStates = {});
  const referencePageStates = sourceState.referencePageStates ?? (sourceState.referencePageStates = {});
  const observations = [];

  sourceState.lastDiscoveryCount = candidateEntries.length;

  for (const entry of candidateEntries) {
    const pageState = pageStates[entry.loc] ?? (pageStates[entry.loc] = {});
    const pageResult = await fetcher.fetchText(source, pageState, entry.loc, {
      headers: SITEMAP_HEADERS,
      skipRobotsCheck: true,
    });
    const observation =
      pageResult.notModified && pageState.cachedObservation
        ? {
            ...pageState.cachedObservation,
            seenAt: now
          }
        : parseKomplettProductPage({
            html: pageResult.body,
            url: entry.loc,
            source,
            now
          });

    if (!observation) {
      continue;
    }

    const referenceCandidate = source.referenceLookup ? findReferenceCandidate(entry, referenceIndex) : null;

    if (referenceCandidate && referenceCandidate.loc !== entry.loc) {
      const referenceState = referencePageStates[referenceCandidate.loc] ?? (referencePageStates[referenceCandidate.loc] = {});
      const referenceResult = await fetcher.fetchText(source, referenceState, referenceCandidate.loc, {
        headers: SITEMAP_HEADERS,
        skipRobotsCheck: true,
      });
      const referenceObservation =
        referenceResult.notModified && referenceState.cachedObservation
          ? {
              ...referenceState.cachedObservation,
              seenAt: now
            }
          : parseKomplettProductPage({
              html: referenceResult.body,
              url: referenceCandidate.loc,
              source: {
                ...source,
                condition: 'new'
              },
              now
            });

      if (referenceObservation) {
        observation.marketValueSek = referenceObservation.priceSek;
        observation.referencePriceSek = referenceObservation.priceSek;
        observation.referenceUrl = referenceObservation.url;
        observation.referenceTitle = referenceObservation.title;
        observation.referenceSourceLabel = referenceObservation.sourceLabel;
        referenceState.cachedObservation = referenceObservation;
      }
    }

    pageState.cachedObservation = observation;
    observations.push(observation);
  }

  return observations;
}
