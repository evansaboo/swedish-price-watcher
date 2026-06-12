// ═══════════════════════════════════════════════════════════════
// Dustin Home Fyndvaror — Cloudflare bypass + embedded JSON parsing
//
// dustinhome.se hard-403s direct requests (Cloudflare Bot Management),
// so pages are fetched through FlareSolverr / ScraperAPI / Scrapfly.
//
// Listing pages embed complete `"searchResultProduct":{...}` JSON
// objects (Next.js SSR payload + hydrated panels) carrying numeric
// prices, originalPrice, availability, manufacturer part numbers and
// image ids — far more stable than scraping the DOM.
//
// NOTE: written against a Wayback-archived capture of
// /group/ovrigt/fyndvaror (Aug 2025). Pagination (?page=N) and the
// live payload shape need verification on the Pi where FlareSolverr
// runs — the source ships disabled by default.
// ═══════════════════════════════════════════════════════════════

import { normalizeProductIdentity, sleep, stripText } from '../lib/utils.js';
import { resolveBypassBackend } from '../lib/bypassFetch.js';

const BASE_URL = 'https://www.dustinhome.se';
const IMAGE_CDN = 'https://cf-images.dustin.eu/cdn-cgi/image/fit=contain,format=auto,quality=75,width=384/image';

/**
 * Extract every balanced JSON object following `marker` in the HTML.
 * Marker must end with '{' (e.g. '"searchResultProduct":{').
 */
export function extractJsonObjects(html, marker, limit = 500) {
  const out = [];
  let from = 0;

  while (out.length < limit) {
    const i = html.indexOf(marker, from);
    if (i === -1) break;
    const start = i + marker.length - 1; // index of the opening '{'

    let depth = 0;
    let inString = false;
    let j = start;
    for (; j < html.length; j++) {
      const ch = html[j];
      if (inString) {
        if (ch === '\\') j++; // skip escaped char
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }

    try {
      out.push(JSON.parse(html.slice(start, j + 1)));
    } catch {
      // Malformed fragment — skip it
    }
    from = j + 1;
  }

  return out;
}

// Observed live values: IMMEDIATE_SHIPPING (in own warehouse), EXTERNAL_STOCK
// (orderable from supplier), OUT_OF_STOCK. IN_STOCK kept as a defensive alias.
function resolveAvailability(availability) {
  const status = availability?.availabilityStatus ?? '';
  if (status === 'IMMEDIATE_SHIPPING' || status === 'IN_STOCK') return 'in_stock';
  if (status === 'OUT_OF_STOCK') return 'out_of_stock';
  return 'unknown';
}

function buildImageUrl(product) {
  const imageId = String(product.primaryImageId ?? '').replace(/\.(jpe?g|png|webp)$/i, '');
  if (!imageId) return null;
  const slug = product.nameSlug || 'product';
  return `${IMAGE_CDN}/${imageId}/${slug}.jpg`;
}

export function mapDustinProduct(product, source, now) {
  if (!product || typeof product !== 'object') return null;

  const externalId = String(product.id ?? product.productErpIdentifier ?? '').trim();
  const displayName = stripText(product.displayName ?? '');
  if (!externalId || !displayName) return null;

  const price = product.price?.price;
  if (!Number.isFinite(price) || price <= 0) return null;

  // Skip products that can no longer be bought — fyndvaror sell out for good.
  if (product.availability?.isAvailableForSale === false) return null;

  const original = product.price?.originalPrice;
  const referencePriceSek = Number.isFinite(original) && original > price ? Math.round(original) : null;

  const manufacturer = stripText(product.manufacturerName ?? '');
  const title = manufacturer && !displayName.toLowerCase().startsWith(manufacturer.toLowerCase())
    ? `${manufacturer} ${displayName}`
    : displayName;

  // "(Fyndvara klass 2)" → condition label; stripped for cross-store identity
  const klassMatch = displayName.match(/fyndvara(?:\s+klass\s*(\d))?/i);
  const conditionLabel = klassMatch
    ? (klassMatch[1] ? `Fyndvara klass ${klassMatch[1]}` : 'Fyndvara')
    : 'Fyndvara';
  const cleanTitle = title.replace(/\s*[-–]?\s*\(?fyndvara[^)]*\)?/gi, ' ').replace(/\s+/g, ' ').trim();

  const slug = product.nameSlug ? String(product.nameSlug) : '';
  const url = `${BASE_URL}/product/${externalId}${slug ? `/${slug}` : ''}`;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId,
    productKey: normalizeProductIdentity(cleanTitle || title),
    title,
    url,
    category: stripText(product.categoryName ?? '') || source.categoryLabel || 'Fyndvaror',
    condition: 'outlet',
    conditionLabel,
    priceSek: Math.round(price),
    marketValueSek: referencePriceSek,
    referencePriceSek,
    referenceUrl: null,
    referenceTitle: null,
    referenceSourceLabel: null,
    manufacturerArticleNumber: stripText(product.manufacturerProductIdentifier ?? '') || null,
    availability: resolveAvailability(product.availability),
    imageUrl: buildImageUrl(product),
    notes: source.notes ?? null,
    seenAt: now,
  };
}

/**
 * Parse one listing page: pull every embedded searchResultProduct and keep
 * those matching `requirePattern` (filters out unrelated promo-panel products
 * that share the page with the listing).
 */
export function parseDustinPage(html, source, now, seen, requirePattern) {
  const observations = [];

  for (const product of extractJsonObjects(html, '"searchResultProduct":{')) {
    const obs = mapDustinProduct(product, source, now);
    if (!obs || seen.has(obs.externalId)) continue;
    if (requirePattern && !requirePattern.test(obs.title)) continue;
    seen.add(obs.externalId);
    observations.push(obs);
  }

  return observations;
}

export async function collectFromDustin({ source, sourceState, now }) {
  const backend = resolveBypassBackend(source, { renderJs: source.renderJs !== false });
  const listPaths = Array.isArray(source.listPaths) && source.listPaths.length
    ? source.listPaths
    : ['/group/ovrigt/fyndvaror'];
  const maxPages = source.maxPages ?? 10;
  const pageDelayMs = source.pageDelayMs ?? 1500;
  // Promo panels on listing pages contain unrelated products — keep only titles
  // matching this pattern (set to "" in config to disable filtering).
  const requirePattern = source.requireTitlePattern === ''
    ? null
    : new RegExp(source.requireTitlePattern || 'fyndvara', 'i');

  console.log(`[${source.id}] Using ${backend.label}`);
  const seen = new Set();
  const observations = [];
  sourceState.lastScanPartial = false;

  for (const path of listPaths) {
    for (let page = 1; page <= maxPages; page++) {
      const url = page === 1 ? `${BASE_URL}${path}` : `${BASE_URL}${path}?page=${page}`;

      let html;
      try {
        html = await backend.fetchPage(url);
      } catch (err) {
        console.warn(`[${source.id}] ${path} page ${page} failed: ${err.message}`);
        if (observations.length > 0) sourceState.lastScanPartial = true;
        break;
      }

      const pageObservations = parseDustinPage(html, source, now, seen, requirePattern);
      console.log(`[${source.id}] ${path} page ${page}: ${pageObservations.length} new products`);

      // No new products → either the end of the listing or a page format we
      // don't understand; stop this path.
      if (pageObservations.length === 0) break;
      observations.push(...pageObservations);

      if (page === maxPages) sourceState.lastScanPartial = true;
      else await sleep(pageDelayMs);
    }
  }

  sourceState.lastDiscoveryCount = observations.length;
  console.log(`[${source.id}] Total: ${observations.length} products${sourceState.lastScanPartial ? ' (partial)' : ''}`);
  return observations;
}
