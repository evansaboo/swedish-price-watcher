import { normalizeProductIdentity, parseSekValue, sleep } from '../lib/utils.js';

const API_BASE = 'https://www.power.se/api/v2/productlists';
const IMAGE_CDN = 'https://media.power-cdn.net';
// The Power API returns ~1.65× the requested size per call, so size=500 yields
// ~800 products/request — roughly 13 requests for 10k products vs 100 requests
// at size=100. Use actual returned count as the from= increment to avoid gaps.
const PAGE_SIZE = 500;
const PAGE_DELAY_MS = 100;

// s=5 = sort by deal score; o=true = outlet/returned products only; cd=false = include discontinued.
// outletOnly=false in source config switches to regular campaign deals (o=false).
function buildApiParams(source) {
  const outletOnly = source.outletOnly !== false;
  return `s=5&o=${outletOnly}&cd=false`;
}

/**
 * Build a product image URL from the productImage object.
 * Prefer 600×600 webp, fall back to any variant.
 */
function buildImageUrl(productImage) {
  if (!productImage?.basePath || !Array.isArray(productImage.variants)) return null;
  const variant =
    productImage.variants.find((v) => v.width === 600 && v.filename?.endsWith('.webp')) ??
    productImage.variants.find((v) => v.width === 300) ??
    productImage.variants[0];
  if (!variant) return null;
  return `${IMAGE_CDN}${productImage.basePath}/${variant.filename}`;
}

function mapProduct(item, source, now) {
  const externalId = String(item.productId ?? '').trim();
  const title = String(item.title ?? '').trim();
  if (!externalId || !title) return null;

  const price = parseSekValue(item.price);
  if (price == null) return null;

  const refPrice =
    parseSekValue(item.outletProductNormalPrice) ??
    parseSekValue(item.previousPrice) ??
    null;

  const href = item.url ?? '';
  const url = href.startsWith('http') ? href : `https://www.power.se${href}`;
  const outletOnly = source.outletOnly !== false;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId,
    title,
    url,
    productKey: normalizeProductIdentity(title),
    priceSek: price,
    referencePriceSek: refPrice,
    marketValueSek: refPrice,
    imageUrl: buildImageUrl(item.productImage),
    category: item.categoryName ?? 'electronics',
    condition: outletOnly ? 'outlet' : 'deal',
    conditionLabel: item.outletReason ?? (outletOnly ? 'Outlet' : 'Kampanj'),
    availability: 'in_stock',
    outletReason: item.outletReason ?? null,
    gtin: item.eanGtin12 ?? item.barcode ?? null,
    manufacturerArticleNumber: item.productManufactorIdentity ?? null,
    seenAt: now,
  };
}

/**
 * Collect Power.se outlet products via their REST API.
 * No Apify/Playwright needed — the API is public and unauthenticated.
 */
export async function collectFromPower({ source, sourceState, fetcher, now }) {
  const maxProducts = source.maxProducts ?? 5000;
  const observations = [];
  const seen = new Set();
  let from = 0;
  sourceState.lastScanPartial = false;

  while (observations.length < maxProducts) {
    const url = `${API_BASE}?size=${PAGE_SIZE}&from=${from}&${buildApiParams(source)}`;
    let data;
    try {
      const result = await fetcher.fetchText(source, null, url, {
        headers: { Accept: 'application/json', 'Accept-Language': 'sv-SE' },
        skipRobotsCheck: true,
        skipHostDelay: true,
      });
      data = JSON.parse(result.body);
    } catch (err) {
      if (observations.length > 0) {
        // Partial snapshot — flag it so the engine skips pruning unseen items.
        sourceState.lastScanPartial = true;
        break;
      }
      throw new Error(`Power.se API failed at from=${from}: ${err.message}`);
    }

    const products = data.products ?? [];
    const outletOnly = source.outletOnly !== false;
    const minDiscountPct = Number.isFinite(source.minDiscountPct) ? source.minDiscountPct : 0;
    for (const item of products) {
      const obs = mapProduct(item, source, now);
      if (!obs || seen.has(obs.externalId)) continue;
      // Campaign mode: only keep items with a real markdown (previousPrice above current).
      if (!outletOnly) {
        if (!Number.isFinite(obs.referencePriceSek) || obs.referencePriceSek <= obs.priceSek) continue;
        const discountPct = (1 - obs.priceSek / obs.referencePriceSek) * 100;
        if (discountPct < minDiscountPct) continue;
      }
      seen.add(obs.externalId);
      observations.push(obs);
    }

    if (data.isLastPage || products.length === 0) break;

    if (observations.length >= maxProducts) {
      // Stopped at the cap with pages remaining — snapshot is incomplete.
      sourceState.lastScanPartial = true;
      break;
    }

    // from advances by PAGE_SIZE (the unique-product offset step).
    // The API bundles extra related products per page, so returned count > PAGE_SIZE,
    // but the actual unique-product cursor advances by exactly PAGE_SIZE.
    from += PAGE_SIZE;
    await sleep(PAGE_DELAY_MS);
  }

  sourceState.lastDiscoveryCount = observations.length;
  return observations;
}
