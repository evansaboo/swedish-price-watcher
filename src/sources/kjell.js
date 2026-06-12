// ═══════════════════════════════════════════════════════════════
// Kjell & Company Outlet — direct JSON API
//
// kjell.com serves its outlet listing as JSON when requested with
// XHR headers (accept: application/json + x-requested-with), no
// Cloudflare bypass or API key needed.
//
//   Page 1:  GET /se/outlet           → { products: { products: [...60], totalProductCount } }
//   Page N:  GET /se/outlet?page=N    → [ ...60 products ] (flat array)
//
// ~3 300 outlet products at 60/page. Each product carries
// price.currentInclVat (outlet price), price.originalInclVat
// (reference price) and an outlet grade (?outlet=a|b in the URL).
// ═══════════════════════════════════════════════════════════════

import { resolveIncrementalMode } from '../lib/incremental.js';
import { normalizeProductIdentity, sleep, stripText } from '../lib/utils.js';

const BASE_URL = 'https://www.kjell.com';
const OUTLET_PATH = '/se/outlet';
const PAGE_SIZE = 60;
const PAGE_DELAY_MS = 400;

const JSON_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json',
  'x-requested-with': 'XMLHttpRequest',
  'accept-language': 'sv-SE,sv;q=0.9',
  referer: `${BASE_URL}${OUTLET_PATH}`,
};

// Top-level outlet category slugs → readable labels. Unknown slugs fall back to de-slugging.
const CATEGORY_MAP = {
  'ljud-bild': 'Ljud & Bild',
  'dator-kringutrustning': 'Dator & Kringutrustning',
  'mobilt-wearables': 'Mobilt & Wearables',
  'hem-kontor-fritid': 'Hem, Kontor & Fritid',
  'smarta-hem': 'Smarta Hem',
  'natverk-internet': 'Nätverk & Internet',
  'el-verktyg': 'El & Verktyg',
  'kablar-kontakter': 'Kablar & Kontakter',
  gaming: 'Gaming',
  belysning: 'Belysning',
  batterier: 'Batterier',
};

function deslug(slug) {
  const text = String(slug ?? '').replace(/-/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
}

/** Resolve a category from the product URL: /se/outlet/{cat}/{subcat}/.../{product}?outlet=a */
export function resolveKjellCategory(url) {
  const path = String(url ?? '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  // parts: ['se', 'outlet', cat, subcat, ..., product-slug]
  if (parts.length < 4) return 'Outlet';
  const cat = parts[2];
  // Prefer the subcategory when present (more specific than the top category,
  // not as noisy as the leaf product-type segment).
  const sub = parts.length >= 5 ? parts[3] : null;
  if (sub) return CATEGORY_MAP[sub] ?? deslug(sub);
  return CATEGORY_MAP[cat] ?? deslug(cat) ?? 'Outlet';
}

/**
 * Best category for a product: the GA tracking payload carries proper
 * Swedish names with diacritics ("TV & tillbehör"); URL slugs are the
 * ASCII fallback ("tv-tillbehor").
 */
function resolveCategory(product, relUrl) {
  const t = product.trackingProduct;
  const tracked = stripText(t?.item_category3 ?? t?.item_category2 ?? t?.item_category ?? '');
  return tracked || resolveKjellCategory(relUrl);
}

/** Outlet grade from the URL query (?outlet=a / ?outlet=b). */
function resolveGrade(url) {
  const m = String(url ?? '').match(/[?&]outlet=([a-z])/i);
  return m ? m[1].toUpperCase() : null;
}

export function mapKjellProduct(product, source, now) {
  if (!product || typeof product !== 'object') return null;

  const relUrl = String(product.url ?? '');
  if (!relUrl.startsWith('/se/outlet')) return null;

  const price = product.price?.currentInclVat;
  if (!Number.isFinite(price) || price <= 0) return null;

  const baseTitle = stripText(product.title ?? '');
  if (!baseTitle) return null;
  const brand = stripText(product.brandName ?? '');
  const title = brand && !baseTitle.toLowerCase().startsWith(brand.toLowerCase())
    ? `${brand} ${baseTitle}`
    : baseTitle;

  const grade = resolveGrade(relUrl);
  const productCode = stripText(product.productCode ?? product.code ?? '');
  // The same product can exist as both an A- and a B-grade outlet item — the
  // grade must be part of the identity or one overwrites the other.
  const externalId = productCode ? `${productCode}${grade ? `-${grade}` : ''}` : null;
  if (!externalId) return null;

  const original = product.price?.originalInclVat;
  const referencePriceSek = Number.isFinite(original) && original > price ? Math.round(original) : null;

  const rawImg = product.imageUrls?.[0]?.url ?? null;
  const imageUrl = rawImg ? (rawImg.startsWith('http') ? rawImg : `${BASE_URL}${rawImg}`) : null;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId,
    productKey: normalizeProductIdentity(baseTitle),
    title,
    url: `${BASE_URL}${relUrl}`,
    category: resolveCategory(product, relUrl),
    condition: 'outlet',
    conditionLabel: grade ? `Outlet ${grade}` : 'Outlet',
    priceSek: Math.round(price),
    marketValueSek: referencePriceSek,
    referencePriceSek,
    referenceUrl: null,
    referenceTitle: null,
    referenceSourceLabel: null,
    availability: product.anyVariantBuyableOnline === false ? 'unknown' : 'in_stock',
    imageUrl,
    notes: source.notes ?? null,
    seenAt: now,
  };
}

/** Both response shapes: page 1 nests products.products; page ≥2 is a flat array. */
export function extractKjellProducts(payload) {
  if (Array.isArray(payload)) return payload;
  const nested = payload?.products?.products;
  return Array.isArray(nested) ? nested : [];
}

export async function collectFromKjell({ source, sourceState, fetcher, now }) {
  const maxPages = source.maxPages ?? 60;
  const maxProducts = source.maxProducts ?? 5000;
  const incremental = resolveIncrementalMode(source, sourceState);
  const observations = [];
  const seen = new Set();
  let totalProductCount = null;
  let consecutiveKnownPages = 0;
  sourceState.lastScanPartial = false;
  if (incremental.active) console.log(`[${source.id}] Incremental mode (${incremental.knownIds.size} known IDs)`);

  for (let page = 1; page <= maxPages && observations.length < maxProducts; page++) {
    const url = page === 1 ? `${BASE_URL}${OUTLET_PATH}` : `${BASE_URL}${OUTLET_PATH}?page=${page}`;

    let payload;
    try {
      payload = await fetcher.fetchJsonApi(url, {
        headers: JSON_HEADERS,
        skipHostDelay: true,
        timeoutMs: 45_000,
      });
    } catch (err) {
      if (observations.length > 0) {
        console.warn(`[${source.id}] Page ${page} failed (${err.message}) — keeping partial snapshot.`);
        sourceState.lastScanPartial = true;
        break;
      }
      throw new Error(`Kjell outlet failed on page ${page}: ${err.message}`);
    }

    if (page === 1) {
      const total = payload?.products?.totalProductCount;
      if (Number.isFinite(total)) totalProductCount = total;
    }

    const products = extractKjellProducts(payload);
    if (products.length === 0) break;

    let newOnPage = 0;
    for (const product of products) {
      const obs = mapKjellProduct(product, source, now);
      if (!obs || seen.has(obs.externalId)) continue;
      seen.add(obs.externalId);
      observations.push(obs);
      if (!incremental.knownIds.has(obs.externalId)) newOnPage++;
    }

    // Incremental stop: consecutive fully-known pages mean we've caught up
    // with the previous scan — deeper pages are unchanged.
    if (incremental.active) {
      consecutiveKnownPages = newOnPage === 0 ? consecutiveKnownPages + 1 : 0;
      if (consecutiveKnownPages >= incremental.stopPages) {
        console.log(`[${source.id}] ${consecutiveKnownPages} consecutive fully-known pages — stopping early (incremental)`);
        sourceState.lastScanPartial = true;
        break;
      }
    }

    if (Number.isFinite(totalProductCount) && page * PAGE_SIZE >= totalProductCount) break;
    if (products.length < PAGE_SIZE) break;
    if (page >= maxPages || observations.length >= maxProducts) {
      // Stopped at a cap with pages remaining — snapshot is incomplete.
      sourceState.lastScanPartial = true;
      break;
    }
    await sleep(PAGE_DELAY_MS);
  }

  // ── Reference price lookup ───────────────────────────────────────────────
  // Outlet listings carry no new-item price, but the product detail JSON does
  // (outletOriginalVariation.price.currentInclVat). Resolve a capped number per
  // scan and cache results in sourceState so the catalog fills in over time.
  const refCache = sourceState.referencePriceCache ?? (sourceState.referencePriceCache = {});
  // Manufacturer part numbers (modelNumber on the detail page) — cached for
  // cross-store identity matching.
  const modelCache = sourceState.modelNumberCache ?? (sourceState.modelNumberCache = {});
  const maxLookups = source.maxReferenceLookups ?? 40;
  const REF_BATCH_SIZE = 5;
  const REF_BATCH_DELAY_MS = 500;

  for (const obs of observations) {
    if (obs.referencePriceSek == null && refCache[obs.externalId] != null) {
      obs.referencePriceSek = refCache[obs.externalId];
      obs.marketValueSek = refCache[obs.externalId];
    }
    if (modelCache[obs.externalId]) {
      obs.manufacturerArticleNumber = modelCache[obs.externalId];
    }
  }

  const toLookup = observations
    .filter((obs) => obs.referencePriceSek == null && !(obs.externalId in refCache))
    .slice(0, maxLookups);

  for (let i = 0; i < toLookup.length; i += REF_BATCH_SIZE) {
    const batch = toLookup.slice(i, i + REF_BATCH_SIZE);
    await Promise.all(batch.map(async (obs) => {
      try {
        const detail = await fetcher.fetchJsonApi(obs.url, {
          headers: JSON_HEADERS,
          skipHostDelay: true,
          timeoutMs: 30_000,
        });
        const original = detail?.outletOriginalVariation?.price?.currentInclVat;
        // Cache misses as null too, so unresolvable items aren't refetched every scan.
        const refPrice = Number.isFinite(original) && original > obs.priceSek ? Math.round(original) : null;
        refCache[obs.externalId] = refPrice;
        if (refPrice != null) {
          obs.referencePriceSek = refPrice;
          obs.marketValueSek = refPrice;
        }
        const modelNumber = stripText(detail?.modelNumber ?? '');
        if (modelNumber) {
          modelCache[obs.externalId] = modelNumber;
          obs.manufacturerArticleNumber = modelNumber;
        }
      } catch {
        // Non-fatal — missing reference price is fine; retry next scan.
      }
    }));
    if (i + REF_BATCH_SIZE < toLookup.length) await sleep(REF_BATCH_DELAY_MS);
  }

  sourceState.lastDiscoveryCount = observations.length;
  console.log(`[${source.id}] Collected ${observations.length} outlet products${totalProductCount ? ` of ~${totalProductCount}` : ''}.`);
  return observations;
}
