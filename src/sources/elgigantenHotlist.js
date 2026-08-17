import { normalizeProductIdentity } from '../lib/utils.js';
import { getSharedAlgoliaApiKey } from './elgigantenAuth.js';
import { resolveImageUrl } from './elgiganten.js';

/**
 * Elgiganten "hotlist" — a fast, narrow poller for product categories that hold
 * their value on the Swedish second-hand market (GPUs, RAM, SSDs, MacBooks, iPhones).
 *
 * Design goals:
 *  - **Fast**: every configured watch group is packed into a SINGLE Algolia
 *    multi-query request, so a full poll is one HTTP round-trip (~1s).
 *  - **Low detection risk**: one request per scan cycle (~288/day) against the
 *    plain Algolia CDN, which is not behind Elgiganten's Vercel bot mitigation.
 *    The signed API key is shared/cached via `getSharedAlgoliaApiKey`, so this
 *    source adds no extra load on the protected key-issuing endpoint.
 *  - **High signal**: only emits listings that carry a real discount signal,
 *    either a B-grade (outlet) unit priced below the new price, or an active
 *    campaign price below `beforePrice`.
 *
 * Unlike `elgiganten-outlet`, this source filters on `productTaxonomy.id`, so
 * every hit carries its true category (the outlet taxonomy collapses everything
 * under "Outlet" and needs a separate cgm lookup).
 */

const ALGOLIA_BASE_URL =
  'https://z0fl7r8ubh-dsn.algolia.net/1/indexes/*/queries' +
  '?x-algolia-agent=Algolia%20for%20JavaScript';

const INDEX = 'commerce_b2c_OCSEELG';
const DEFAULT_HITS_PER_GROUP = 100;
const DEFAULT_MIN_DISCOUNT_PCT = 15;
const MAX_HITS_PER_GROUP = 200;

/**
 * Categories that reliably resell. Taxonomy IDs were resolved from the live
 * index; `brands` narrows a broad category down (e.g. PT254 "Laptop" → MacBook).
 */
const DEFAULT_WATCH_GROUPS = [
  { label: 'Grafikkort (GPU)', taxonomyIds: ['PT263'] },
  { label: 'RAM-minne', taxonomyIds: ['PT269'] },
  { label: 'Intern SSD', taxonomyIds: ['PT277'] },
  { label: 'MacBook', taxonomyIds: ['PT254'], brands: ['Apple'] },
  { label: 'iPhone', taxonomyIds: ['PT238'], brands: ['Apple'] },
];

function buildAlgoliaHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-algolia-api-key': apiKey,
    'x-algolia-application-id': 'Z0FL7R8UBH',
    Referer: 'https://www.elgiganten.se/',
    Origin: 'https://www.elgiganten.se',
  };
}

async function algoliaPost(fetcher, apiKey, body) {
  const url = `${ALGOLIA_BASE_URL}&x-algolia-api-key=${apiKey}&x-algolia-application-id=Z0FL7R8UBH`;
  return fetcher.fetchJsonApi(url, {
    method: 'POST',
    headers: buildAlgoliaHeaders(apiKey),
    body: JSON.stringify(body),
    skipHostDelay: true,
  });
}

function quoteFacetValue(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

/**
 * Turn a watch group into an Algolia filter expression, e.g.
 * `(productTaxonomy.id:"PT254") AND (brand:"Apple")`.
 */
export function buildGroupFilters(group) {
  const clauses = [];

  const taxonomyIds = Array.isArray(group.taxonomyIds) ? group.taxonomyIds.filter(Boolean) : [];
  if (taxonomyIds.length) {
    clauses.push(`(${taxonomyIds.map((id) => `productTaxonomy.id:${quoteFacetValue(id)}`).join(' OR ')})`);
  }

  const brands = Array.isArray(group.brands) ? group.brands.filter(Boolean) : [];
  if (brands.length) {
    clauses.push(`(${brands.map((b) => `brand:${quoteFacetValue(b)}`).join(' OR ')})`);
  }

  if (typeof group.filters === 'string' && group.filters.trim()) {
    clauses.push(`(${group.filters.trim()})`);
  }

  return clauses.join(' AND ');
}

export function normalizeWatchGroups(rawGroups) {
  const groups = Array.isArray(rawGroups) && rawGroups.length ? rawGroups : DEFAULT_WATCH_GROUPS;
  return groups
    .filter((group) => group && group.enabled !== false)
    .map((group, index) => ({
      label: String(group.label ?? `Group ${index + 1}`),
      query: typeof group.query === 'string' ? group.query : '',
      taxonomyIds: group.taxonomyIds,
      brands: group.brands,
      filters: group.filters,
      minDiscountPct: group.minDiscountPct,
      minPriceSek: group.minPriceSek,
      maxPriceSek: group.maxPriceSek,
      hitsPerPage: group.hitsPerPage,
    }))
    .filter((group) => group.query || buildGroupFilters(group));
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Pick the deepest (most specific) taxonomy name, e.g. "Grafikkort (GPU)".
 */
function resolveCategory(hit, fallbackLabel) {
  const taxonomy = Array.isArray(hit.productTaxonomy) ? hit.productTaxonomy : [];
  if (taxonomy.length) {
    const deepest = taxonomy.reduce(
      (best, node) => (!best || (node?.level ?? 0) >= (best?.level ?? 0) ? node : best),
      null,
    );
    if (deepest?.name) return String(deepest.name);
  }
  return fallbackLabel ?? null;
}

/**
 * Select the best purchasable offer on a hit.
 *
 * A B-grade (outlet) unit is preferred when present because it is both the
 * cheaper buy and the stronger resale margin; `price.amount` is then the honest
 * reference (what the same item costs new right now).
 */
export function selectOffer(hit) {
  const newPrice = positiveNumber(hit.price?.amount);
  if (!newPrice) return null;

  const bItemPrice = positiveNumber(hit.cheapestBItem?.price);
  if (bItemPrice && bItemPrice < newPrice) {
    return {
      kind: 'outlet',
      priceSek: bItemPrice,
      referencePriceSek: newPrice,
      articleNumber: hit.cheapestBItem?.articleNumber ?? null,
    };
  }

  const beforePrice = positiveNumber(hit.beforePrice);
  if (beforePrice && beforePrice > newPrice) {
    return {
      kind: 'deal',
      priceSek: newPrice,
      referencePriceSek: beforePrice,
      articleNumber: null,
    };
  }

  return null;
}

/**
 * Build the URL of the B-grade unit itself.
 *
 * A hit from the catalogue index describes the A-grade product; `cheapestBItem`
 * only carries the discounted price. Linking to the A-grade page would send a
 * buyer — or the cart-staging browser — to the full-price item, so the outlet
 * URL is derived from the product slug and the B-grade SKU.
 *
 * Verified against 24 live B-grade products: every derived URL matched the one
 * the index stores for that SKU.
 */
export function buildOutletUrl(productUrl, articleNumber) {
  if (!productUrl || !articleNumber) return null;
  const match = String(productUrl).match(
    /^(https:\/\/www\.elgiganten\.se)\/product\/.*\/([^/]+)\/\d+\/?$/
  );
  if (!match) return null;
  return `${match[1]}/product/outlet/${match[2]}/${articleNumber}`;
}

function mapHit(hit, offer, { source, group, now }) {
  const title = String(hit.title ?? hit.name ?? '').trim();
  const baseId = String(hit.objectID ?? hit.articleNumber ?? '').trim();
  if (!title || !baseId) return null;

  // For a B-grade offer prefer the outlet SKU so the listing key tracks the
  // actual purchasable unit rather than the A-grade catalogue entry.
  const externalId = offer.kind === 'outlet' && offer.articleNumber
    ? String(offer.articleNumber)
    : baseId;

  const discountPct = Math.round((1 - offer.priceSek / offer.referencePriceSek) * 100);

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId,
    productKey: normalizeProductIdentity(title),
    title,
    // For a B-grade offer this must be the outlet unit, not the A-grade page:
    // the price shown in the alert is the B-grade price.
    url: (offer.kind === 'outlet'
      ? buildOutletUrl(hit.productUrl ?? hit.urlB2C, offer.articleNumber)
      : null) ?? hit.productUrl ?? hit.urlB2C ?? null,
    category: resolveCategory(hit, group.label),
    condition: offer.kind,
    conditionLabel: offer.kind === 'outlet'
      ? (hit.cheapestBItem?.bGradeTitle ?? 'Fyndvara')
      : 'Kampanj',
    grade: hit.cheapestBItem?.bGrade ?? null,
    priceSek: offer.priceSek,
    marketValueSek: offer.referencePriceSek,
    referencePriceSek: offer.referencePriceSek,
    referenceUrl: null,
    referenceTitle: null,
    referenceSourceLabel: null,
    availability: 'in_stock',
    imageUrl: resolveImageUrl(hit.imageUrl),
    notes: source.notes ?? null,
    seenAt: now,
    watchGroup: group.label,
    discountPct,
  };
}

export async function collectFromElgigantenHotlist({ source, sourceState = {}, fetcher, now }) {
  const apiKey = await getSharedAlgoliaApiKey('[elgiganten-hotlist]');
  return collectHotlistWithKey({ source, sourceState, fetcher, now, apiKey });
}

/**
 * Pipeline without key acquisition — exported so tests can drive it with a mock
 * fetcher instead of launching a real browser to sign an Algolia key.
 */
export async function collectHotlistWithKey({ source, sourceState = {}, fetcher, now, apiKey }) {
  const groups = normalizeWatchGroups(source.watchGroups);
  if (!groups.length) {
    console.warn('[elgiganten-hotlist] No watch groups configured — nothing to poll.');
    return [];
  }

  const defaultHits = Math.min(
    Math.max(Number(source.hitsPerGroup) || DEFAULT_HITS_PER_GROUP, 1),
    MAX_HITS_PER_GROUP,
  );

  // Every watch group travels in one multi-query request — a single round-trip
  // per poll keeps this source fast and effectively invisible to rate limiting.
  const requests = groups.map((group) => ({
    indexName: INDEX,
    query: group.query ?? '',
    filters: buildGroupFilters(group),
    hitsPerPage: Math.min(Math.max(Number(group.hitsPerPage) || defaultHits, 1), MAX_HITS_PER_GROUP),
    page: 0,
  }));

  const startedAt = Date.now();
  const response = await algoliaPost(fetcher, apiKey, { requests });
  const results = Array.isArray(response?.results) ? response.results : [];

  const globalMinDiscount = Number.isFinite(Number(source.minDiscountPct))
    ? Number(source.minDiscountPct)
    : DEFAULT_MIN_DISCOUNT_PCT;

  const observations = [];
  const seenIds = new Set();
  const groupStats = [];

  results.forEach((result, index) => {
    const group = groups[index];
    if (!group) return;
    const hits = Array.isArray(result?.hits) ? result.hits : [];

    const minDiscountPct = Number.isFinite(Number(group.minDiscountPct))
      ? Number(group.minDiscountPct)
      : globalMinDiscount;
    const minPriceSek = positiveNumber(Number(group.minPriceSek ?? source.minPriceSek));
    const maxPriceSek = positiveNumber(Number(group.maxPriceSek ?? source.maxPriceSek));

    let kept = 0;
    for (const hit of hits) {
      // Only surface things that can actually be bought right now.
      if (hit.isBuyableOnline === false) continue;

      const offer = selectOffer(hit);
      if (!offer) continue;

      const discountPct = (1 - offer.priceSek / offer.referencePriceSek) * 100;
      if (discountPct < minDiscountPct) continue;
      if (minPriceSek && offer.priceSek < minPriceSek) continue;
      if (maxPriceSek && offer.priceSek > maxPriceSek) continue;

      const observation = mapHit(hit, offer, { source, group, now });
      if (!observation) continue;
      if (seenIds.has(observation.externalId)) continue;

      seenIds.add(observation.externalId);
      observations.push(observation);
      kept += 1;
    }

    groupStats.push(`${group.label}:${kept}/${hits.length}`);
  });

  sourceState.lastPollAt = now;
  sourceState.lastGroupStats = groupStats.join(' ');

  console.log(
    `[elgiganten-hotlist] ${observations.length} deal(s) from ${groups.length} group(s) ` +
    `in ${Date.now() - startedAt}ms — ${groupStats.join(' ')}`,
  );

  return observations;
}

export { DEFAULT_WATCH_GROUPS };
