import { normalizeProductIdentity, sleep } from '../lib/utils.js';

/**
 * Elgiganten campaign/sale source — direct Algolia API.
 *
 * Auto-discovers all active campaign IDs via facets each scan, then
 * fetches the products for those campaigns. No ScraperAPI or Apify needed.
 *
 * Key fields:
 *   price.amount    = current sale price (already marked down)
 *   beforePrice     = original/before price  ← used as referencePriceSek
 *   discountAmount  = how much you save (SEK)
 *
 * Configure in config/sources.json:
 * {
 *   "id": "elgiganten-campaigns",
 *   "type": "elgiganten-campaigns",
 *   "enabled": true,
 *   "label": "Elgiganten Weekly Deals",
 *   "campaignTypes": ["W"],          // W=weekly, S=store, R=recurring, B=brand. Omit for all.
 *   "minDiscountPct": 10,            // Skip items with < N% discount. Default 0.
 *   "maxProducts": 5000
 * }
 */

const ALGOLIA_URL =
  'https://z0fl7r8ubh-dsn.algolia.net/1/indexes/*/queries' +
  '?x-algolia-agent=Algolia%20for%20JavaScript' +
  '&x-algolia-api-key=bd55a210cb7ee1126552cab633fc1350' +
  '&x-algolia-application-id=Z0FL7R8UBH';

const INDEX = 'commerce_b2c_OCSEELG';
const HITS_PER_PAGE = 100;
const PAGE_DELAY_MS = 150;

const ALGOLIA_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'x-algolia-api-key': 'bd55a210cb7ee1126552cab633fc1350',
  'x-algolia-application-id': 'Z0FL7R8UBH',
};

function resolveImageUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.hostname === 'next-media.elkjop.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      const blobId = parts[1];
      if (blobId) return `https://media.elkjop.com/assets/image/${blobId}`;
    }
  } catch { /* fall through */ }
  return raw;
}

async function algoliaPost(body) {
  const res = await fetch(ALGOLIA_URL, {
    method: 'POST',
    headers: ALGOLIA_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Algolia HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Fetch active campaign IDs grouped by type from Algolia facets. */
async function discoverCampaigns(filterTypes) {
  const payload = await algoliaPost({
    requests: [{
      indexName: INDEX,
      hitsPerPage: 0,
      page: 0,
      query: '',
      facets: ['articleCampaigns.campaignId', 'articleCampaigns.campaignType'],
      maxValuesPerFacet: 200,
    }],
  });

  const facets = payload?.results?.[0]?.facets ?? {};
  const campaignIds = Object.keys(facets['articleCampaigns.campaignId'] ?? {});
  const campaignTypes = facets['articleCampaigns.campaignType'] ?? {};

  // Map each campaign ID back to its type by fetching one product per campaign
  // (we need type to filter; batch 10 at a time with multi-requests)
  const idToType = {};
  const BATCH = 10;
  for (let i = 0; i < campaignIds.length; i += BATCH) {
    const chunk = campaignIds.slice(i, i + BATCH);
    const requests = chunk.map((cid) => ({
      indexName: INDEX,
      filters: `articleCampaigns.campaignId:${cid}`,
      hitsPerPage: 1,
      page: 0,
      attributesToRetrieve: ['articleCampaigns'],
    }));
    const data = await algoliaPost({ requests });
    for (let j = 0; j < chunk.length; j++) {
      const hit = data?.results?.[j]?.hits?.[0];
      const campaigns = hit?.articleCampaigns ?? [];
      const match = campaigns.find((c) => c.campaignId === chunk[j]);
      if (match) idToType[chunk[j]] = match.campaignType;
    }
    if (i + BATCH < campaignIds.length) await sleep(PAGE_DELAY_MS);
  }

  // Filter by requested types (or return all)
  const activeIds = campaignIds.filter((id) => {
    if (!filterTypes || filterTypes.length === 0) return true;
    return filterTypes.includes(idToType[id]);
  });

  console.log(
    `[elgiganten-campaigns] Discovered ${campaignIds.length} active campaigns; ` +
    `${activeIds.length} match type filter [${filterTypes?.join(',') ?? 'all'}]`
  );

  return activeIds;
}

/** Paginate all products for a given Algolia filter string. Respects 1500-hit cap. */
async function fetchAllPages(filter) {
  const hits = [];
  let page = 0;

  for (;;) {
    const payload = await algoliaPost({
      requests: [{
        indexName: INDEX,
        hitsPerPage: HITS_PER_PAGE,
        page,
        query: '',
        filters: filter,
        attributesToRetrieve: [
          'objectID', 'articleNumber', 'title', 'name', 'brand',
          'price', 'beforePrice', 'discountAmount', 'savePrice',
          'hierarchicalCategories', 'cgm', 'imageUrl', 'urlB2C', 'productUrl',
          'isBuyableOnline', 'isBuyableInternet',
          'articleCampaigns',
        ],
      }],
    });

    const result = payload?.results?.[0];
    const pageHits = result?.hits ?? [];
    hits.push(...pageHits);

    const totalPages = result?.nbPages ?? 1;
    page++;
    if (page >= totalPages || pageHits.length === 0) break;
    await sleep(PAGE_DELAY_MS);
  }

  return hits;
}

function mapCampaignHit(hit, source, now, minDiscountPct) {
  const externalId = String(hit.objectID ?? hit.articleNumber ?? '').trim();
  const title = String(hit.title ?? hit.name ?? '').trim();
  if (!externalId || !title) return null;

  const priceSek =
    typeof hit.price?.amount === 'number' && hit.price.amount > 0
      ? hit.price.amount
      : null;
  if (!priceSek) return null;

  const referencePriceSek =
    typeof hit.beforePrice === 'number' && hit.beforePrice > 0
      ? hit.beforePrice
      : null;

  // Apply minimum discount filter
  if (minDiscountPct > 0 && referencePriceSek != null) {
    const pct = ((referencePriceSek - priceSek) / referencePriceSek) * 100;
    if (pct < minDiscountPct) return null;
  }

  // Pick the most relevant campaign for the label
  const campaigns = hit.articleCampaigns ?? [];
  const activeCampaign = campaigns.find((c) => c.campaignType === 'W')
    ?? campaigns.find((c) => c.campaignType === 'S')
    ?? campaigns[0];
  const conditionLabel = activeCampaign?.campaignText
    ? `Sale: ${activeCampaign.campaignText}`
    : 'Sale';

  const url = hit.productUrl ?? hit.urlB2C ?? null;
  const imageUrl = resolveImageUrl(hit.imageUrl);
  const inStock = hit.isBuyableOnline ?? hit.isBuyableInternet ?? false;

  const category =
    hit.hierarchicalCategories?.lvl3 ??
    hit.hierarchicalCategories?.lvl2 ??
    hit.hierarchicalCategories?.lvl1 ??
    hit.hierarchicalCategories?.lvl0 ??
    'electronics';

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId,
    productKey: normalizeProductIdentity(title),
    title,
    url,
    category,
    condition: 'deal',
    conditionLabel,
    priceSek,
    referencePriceSek,
    marketValueSek: referencePriceSek,
    availability: inStock ? 'in_stock' : 'unknown',
    imageUrl,
    seenAt: now,
  };
}

export async function collectFromElgigantenCampaigns({ source, now }) {
  const campaignTypes = Array.isArray(source.campaignTypes) ? source.campaignTypes : ['W'];
  const pinnedIds = Array.isArray(source.campaignIds) ? source.campaignIds : [];
  const minDiscountPct = typeof source.minDiscountPct === 'number' ? source.minDiscountPct : 0;
  const maxProducts = source.maxProducts ?? 5000;

  // Step 1: collect campaign IDs — pinned IDs + auto-discovered by type
  let discoveredIds = [];
  try {
    discoveredIds = await discoverCampaigns(campaignTypes);
  } catch (err) {
    throw new Error(`Elgiganten campaigns: failed to discover campaign IDs — ${err.message}`);
  }

  // Merge pinned IDs (deduped), pinned first so they always run
  const campaignIds = [...new Set([...pinnedIds, ...discoveredIds])];

  if (campaignIds.length === 0) {
    console.log('[elgiganten-campaigns] No active campaigns found for the configured types.');
    return [];
  }

  // Step 2: fetch all products, one query per campaign ID (avoids 1500-hit cap overlap)
  const seen = new Set();
  const rawHits = [];

  for (const cid of campaignIds) {
    if (rawHits.length >= maxProducts) break;
    const filter = `articleCampaigns.campaignId:${cid}`;
    try {
      const hits = await fetchAllPages(filter);
      for (const h of hits) {
        const id = String(h.objectID ?? h.articleNumber ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rawHits.push(h);
      }
      console.log(`[elgiganten-campaigns] Campaign ${cid}: ${hits.length} products (running total: ${rawHits.length})`);
    } catch (err) {
      console.warn(`[elgiganten-campaigns] Skipping campaign ${cid}: ${err.message}`);
    }
  }

  // Step 3: map and filter observations
  const observations = rawHits
    .map((hit) => mapCampaignHit(hit, source, now, minDiscountPct))
    .filter(Boolean);

  console.log(`[elgiganten-campaigns] ${observations.length} sale items (${rawHits.length - observations.length} skipped by discount filter)`);
  return observations;
}
