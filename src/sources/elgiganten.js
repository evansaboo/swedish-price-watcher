import { normalizeProductIdentity, sleep } from '../lib/utils.js';

const ALGOLIA_URL =
  'https://z0fl7r8ubh-dsn.algolia.net/1/indexes/*/queries' +
  '?x-algolia-agent=Algolia%20for%20JavaScript' +
  '&x-algolia-api-key=bd55a210cb7ee1126552cab633fc1350' +
  '&x-algolia-application-id=Z0FL7R8UBH';

const INDEX = 'commerce_b2c_OCSEELG';
const OUTLET_FILTER = 'productTaxonomy.id:PT793';
const HITS_PER_PAGE = 100;
// Algolia's paginationLimitedTo is 1500 for this index — any single query/filter
// returns at most 1500 results. We split by brand (607 brands, max 867 per brand)
// to retrieve all ~13 000 outlet products.
const BRAND_QUERY_CONCURRENCY = 3; // parallel brand queries — keep low to limit memory spike
const PAGE_DELAY_MS = 150;

const ALGOLIA_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'x-algolia-api-key': 'bd55a210cb7ee1126552cab633fc1350',
  'x-algolia-application-id': 'Z0FL7R8UBH',
};

/**
 * Transform a next-media.elkjop.com URL to the direct media.elkjop.com CDN URL.
 * next-media is a Next.js image optimizer that serves with Content-Disposition: attachment
 * which prevents Discord from rendering the image in embeds.
 *
 * Input:  https://next-media.elkjop.com/image/{blobId}/{articleNo}/{filename}
 * Output: https://media.elkjop.com/assets/image/{blobId}
 */
function resolveImageUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.hostname === 'next-media.elkjop.com') {
      // Path: /image/{blobId}/...
      const parts = url.pathname.split('/').filter(Boolean);
      const blobId = parts[1]; // index 0 = "image", index 1 = blobId
      if (blobId) return `https://media.elkjop.com/assets/image/${blobId}`;
    }
  } catch {
    // fall through
  }
  return raw;
}

async function algoliaPost(fetcher, body) {
  return fetcher.fetchJsonApi(ALGOLIA_URL, {
    method: 'POST',
    headers: ALGOLIA_HEADERS,
    body: JSON.stringify(body),
    skipHostDelay: true,
  });
}

/** Fetch all brand names from facets — returns Map<brand, count>. */
async function fetchBrands(fetcher) {
  const payload = await algoliaPost(fetcher, {
    requests: [
      {
        indexName: INDEX,
        filters: OUTLET_FILTER,
        hitsPerPage: 0,
        page: 0,
        query: '',
        facets: ['brand'],
        maxValuesPerFacet: 1000,
      },
    ],
  });
  const brandFacets = payload?.results?.[0]?.facets?.brand ?? {};
  return new Map(Object.entries(brandFacets));
}

/** Paginate all outlet products for a single brand. */
async function fetchBrandProducts(fetcher, brand) {
  const brandFilter = `${OUTLET_FILTER} AND brand:"${brand.replace(/"/g, '\\"')}"`;
  const hits = [];
  let page = 0;

  for (;;) {
    let result;
    try {
      const payload = await algoliaPost(fetcher, {
        requests: [{ indexName: INDEX, filters: brandFilter, hitsPerPage: HITS_PER_PAGE, page, query: '' }],
      });
      result = payload?.results?.[0];
    } catch (err) {
      // Partial is fine — a single brand failure is not fatal
      break;
    }

    const pageHits = result?.hits ?? [];
    hits.push(...pageHits);

    const totalPages = result?.nbPages ?? 1;
    page++;
    if (page >= totalPages || pageHits.length === 0) break;
    await sleep(PAGE_DELAY_MS);
  }

  return hits;
}

function mapHit(hit, source, now, cgmCategoryMap = {}) {
  const externalId = String(hit.objectID ?? hit.articleNumber ?? '').trim();
  const title = String(hit.title ?? hit.name ?? '').trim();
  if (!externalId || !title) return null;

  const priceSek =
    typeof hit.price?.amount === 'number' && hit.price.amount > 0
      ? hit.price.amount
      : null;
  if (!priceSek) return null;

  // bItem.aItemPrice = equivalent new (A-grade) item price → used for discount %
  const referencePriceSek =
    typeof hit.bItem?.aItemPrice === 'number' && hit.bItem.aItemPrice > 0
      ? hit.bItem.aItemPrice
      : null;

  const url = hit.productUrl ?? hit.urlB2C ?? null;
  const imageUrl = resolveImageUrl(hit.imageUrl);
  const category = resolveCategory(hit, cgmCategoryMap);

  const conditionLabel = hit.bItem?.bGradeTitle ?? hit.bItem?.bGrade ?? 'Outlet';
  const grade = hit.bItem?.bGrade ?? null;
  const inStock = hit.isBuyableOnline ?? hit.isBuyableInternet ?? false;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId,
    productKey: normalizeProductIdentity(title),
    title,
    url,
    category,
    condition: 'outlet',
    conditionLabel,
    grade,
    priceSek,
    marketValueSek: referencePriceSek,
    referencePriceSek,
    referenceUrl: null,
    referenceTitle: null,
    referenceSourceLabel: null,
    availability: inStock ? 'in_stock' : 'unknown',
    imageUrl,
    notes: source.notes ?? null,
    seenAt: now,
  };
}

/**
 * Build a cgm (category group ID) → human-readable category name mapping by querying
 * the non-outlet Algolia index. Each cgm maps to a product category like "Grafikkort (GPU)".
 * Results are cached in sourceState to avoid redundant API calls across scans.
 */
async function buildCategoryMap(fetcher, cgmIds, sourceState) {
  if (!sourceState.categoryByGroupId || typeof sourceState.categoryByGroupId !== 'object') {
    sourceState.categoryByGroupId = {};
  }
  const cache = sourceState.categoryByGroupId;

  // Only look up cgm values we haven't seen before
  const missing = cgmIds.filter((id) => id && !(id in cache));
  if (missing.length === 0) return cache;

  // Batch into multi-requests of up to 20 per Algolia call
  const BATCH = 20;
  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH);
    const requests = chunk.map((cgm) => ({
      indexName: INDEX,
      filters: `cgm:${cgm} AND NOT ${OUTLET_FILTER}`,
      hitsPerPage: 1,
      page: 0,
      attributesToRetrieve: ['hierarchicalCategories', 'cgm'],
    }));
    try {
      const payload = await algoliaPost(fetcher, { requests });
      for (let j = 0; j < chunk.length; j++) {
        const hit = payload?.results?.[j]?.hits?.[0];
        const cat =
          hit?.hierarchicalCategories?.lvl3 ??
          hit?.hierarchicalCategories?.lvl2 ??
          hit?.hierarchicalCategories?.lvl1 ??
          null;
        // Store even null entries so we don't retry on future scans
        cache[chunk[j]] = cat;
      }
    } catch {
      // Non-fatal — leave missing entries unresolved
    }
    if (i + BATCH < missing.length) await sleep(PAGE_DELAY_MS);
  }

  return cache;
}

/**
 * Resolve a human-readable category from a cgm lookup map.
 * Falls back progressively to the deepest lvl available in the outlet hit.
 */
function resolveCategory(hit, cgmCategoryMap) {
  const cgm = hit.cgm != null ? String(hit.cgm) : null;
  if (cgm && cgmCategoryMap[cgm]) {
    // Strip leading path prefix (e.g. "Gaming > Datorkomponenter > Grafikkort (GPU)" → "Grafikkort (GPU)")
    const full = cgmCategoryMap[cgm];
    const parts = full.split('>').map((p) => p.trim()).filter(Boolean);
    return parts.at(-1) ?? full;
  }
  // Outlet hits only have lvl1 = 'Outlet', so this is almost always 'Outlet'
  return (
    hit.hierarchicalCategories?.lvl2 ??
    hit.hierarchicalCategories?.lvl1 ??
    hit.hierarchicalCategories?.lvl0 ??
    'electronics'
  );
}

/**
 * Collect Elgiganten outlet products via the Algolia search API.
 *
 * Algolia enforces a paginationLimitedTo of 1500 results per query, so a single
 * paginated query only yields ~1500 products out of 13 000+. We work around this
 * by splitting on brand: fetch all ~607 brand names first, then query each brand
 * independently (max ~867 products/brand, well under 1500). Results are deduplicated
 * by externalId before returning.
 *
 * After collection, cgm codes are resolved to real category names (e.g. "Grafikkort (GPU)")
 * by querying the non-outlet index. The mapping is cached in sourceState across scans.
 */
export async function collectFromElgiganten({ source, sourceState, fetcher, now }) {
  const maxProducts = source.maxProducts ?? 15000;
  const seen = new Set();
  const rawHits = [];

  // Step 1: discover all brands
  let brands;
  try {
    brands = await fetchBrands(fetcher);
  } catch (err) {
    throw new Error(`Elgiganten: failed to fetch brand facets — ${err.message}`);
  }

  const brandList = [...brands.keys()];

  // Step 2: fetch products per brand in small parallel batches
  for (let i = 0; i < brandList.length && rawHits.length < maxProducts; i += BRAND_QUERY_CONCURRENCY) {
    const batch = brandList.slice(i, i + BRAND_QUERY_CONCURRENCY);
    const results = await Promise.all(batch.map((brand) => fetchBrandProducts(fetcher, brand)));

    for (const hits of results) {
      for (const hit of hits) {
        const id = String(hit.objectID ?? hit.articleNumber ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rawHits.push(hit);
      }
    }
  }

  // Step 3: resolve cgm → category name for all unique cgm values
  const cgmIds = [...new Set(rawHits.map((h) => h.cgm != null ? String(h.cgm) : null).filter(Boolean))];
  const cgmCategoryMap = await buildCategoryMap(fetcher, cgmIds, sourceState);

  // Step 4: map hits to observations using resolved categories
  const observations = rawHits
    .map((hit) => mapHit(hit, source, now, cgmCategoryMap))
    .filter(Boolean);

  sourceState.lastDiscoveryCount = observations.length;
  return observations;
}

