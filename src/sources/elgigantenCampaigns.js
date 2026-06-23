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

const ALGOLIA_BASE_URL =
  'https://z0fl7r8ubh-dsn.algolia.net/1/indexes/*/queries' +
  '?x-algolia-agent=Algolia%20for%20JavaScript';

const SIGNED_KEY_URL = 'https://www.elgiganten.se/api/algolia/signed-api-key';

const INDEX = 'commerce_b2c_OCSEELG';
const HITS_PER_PAGE = 100;
const PAGE_DELAY_MS = 150;

/**
 * Fetch a signed Algolia API key via Elgiganten's nonce-based auth endpoint.
 * Cached in sourceState.algoliaApiKey until within 60s of expiry.
 */
async function getAlgoliaApiKey(sourceState) {
  const now = Date.now();
  if (sourceState.algoliaApiKey && sourceState.algoliaKeyExpiry > now + 60_000) {
    return sourceState.algoliaApiKey;
  }

  const baseHeaders = {
    Referer: 'https://www.elgiganten.se/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    Origin: 'https://www.elgiganten.se',
  };

  // Step 1: attempt direct fetch — newer deployments return 200 + apiKey immediately.
  const res1 = await fetch(SIGNED_KEY_URL, { headers: baseHeaders, signal: AbortSignal.timeout(15_000) });

  let body1 = null;
  try { body1 = await res1.clone().json(); } catch { /* not JSON */ }

  if (res1.ok && body1?.apiKey) {
    // Direct 200 path — no nonce required
    return cacheCampaignsKey(sourceState, body1.apiKey, now);
  }

  // 401 nonce-challenge path
  const setCookie = res1.headers.get('set-cookie') ?? '';
  const m = /algolia-refresh-nonce=([a-f0-9-]{36})/i.exec(setCookie);
  const nonce = m?.[1] ?? null;
  if (!nonce) {
    const snippet = body1 ? JSON.stringify(body1) : (await res1.text().catch(() => '(unreadable)'));
    throw new Error(`Elgiganten campaigns: no apiKey and no nonce (status ${res1.status}): ${snippet.slice(0, 200)}`);
  }

  const anonM = /anonymous-id=([^;]+)/i.exec(setCookie);
  const cookieHeader = [
    `algolia-refresh-nonce=${nonce}`,
    anonM ? `anonymous-id=${anonM[1]}` : null,
  ].filter(Boolean).join('; ');

  const res2 = await fetch(SIGNED_KEY_URL, {
    headers: { ...baseHeaders, 'x-algolia-refresh-nonce': nonce, Cookie: cookieHeader },
    signal: AbortSignal.timeout(15_000),
  });
  const body2 = await res2.json();
  if (!body2?.apiKey) throw new Error(`Elgiganten campaigns: signed-api-key returned no apiKey: ${JSON.stringify(body2)}`);

  return cacheCampaignsKey(sourceState, body2.apiKey, now);
}

function cacheCampaignsKey(sourceState, apiKey, now) {
  let expiry = now + 10 * 60_000;
  try {
    const decoded = Buffer.from(apiKey, 'base64').toString('utf8');
    const vm = /validUntil=(\d+)/.exec(decoded);
    if (vm) expiry = Number(vm[1]) * 1000;
  } catch { /* keep default */ }
  sourceState.algoliaApiKey = apiKey;
  sourceState.algoliaKeyExpiry = expiry;
  console.log(`[elgiganten-campaigns] Obtained fresh Algolia API key (valid until ${new Date(expiry).toISOString()})`);
  return apiKey;
}

async function algoliaPost(apiKey, body) {
  const url = `${ALGOLIA_BASE_URL}&x-algolia-api-key=${apiKey}&x-algolia-application-id=Z0FL7R8UBH`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-algolia-api-key': apiKey,
      'x-algolia-application-id': 'Z0FL7R8UBH',
      Referer: 'https://www.elgiganten.se/',
      Origin: 'https://www.elgiganten.se',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Algolia HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

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

/** Fetch active campaign IDs grouped by type from Algolia facets. */
/**
 * Parse the ISO week from a campaign ID like SSA2617W01 → { year: 2026, week: 17 }.
 * Returns null if the ID doesn't match the expected format.
 */
function parseCampaignWeek(campaignId) {
  const match = /^SSA(\d{2})(\d{2})/.exec(campaignId);
  if (!match) return null;
  return { year: 2000 + Number(match[1]), week: Number(match[2]) };
}

/**
 * Return the last day (Sunday UTC) of ISO week `week` in `year`.
 * ISO week 1 is the week containing Jan 4.
 */
function isoWeekEndDate(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7; // 1=Mon … 7=Sun
  const weekOneMonday = new Date(Date.UTC(year, 0, 4 - dayOfWeek + 1));
  const end = new Date(weekOneMonday);
  end.setUTCDate(weekOneMonday.getUTCDate() + (week - 1) * 7 + 6); // +6 = Sunday
  return end;
}

async function discoverCampaigns(apiKey, filterTypes, filterGraceDays) {
  const payload = await algoliaPost(apiKey, {
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

  // Map each campaign ID back to its type and end date
  // (batch 10 at a time with multi-requests)
  const idToMeta = {}; // { [id]: { type, endDate } }
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
    const data = await algoliaPost(apiKey, { requests });
    for (let j = 0; j < chunk.length; j++) {
      const hit = data?.results?.[j]?.hits?.[0];
      const campaigns = hit?.articleCampaigns ?? [];
      const match = campaigns.find((c) => c.campaignId === chunk[j]);
      if (match) {
        idToMeta[chunk[j]] = {
          type: match.campaignType,
          endDate: match.campaignOnlineEnd ?? null,
        };
      }
    }
    if (i + BATCH < campaignIds.length) await sleep(PAGE_DELAY_MS);
  }

  const nowMs = Date.now();
  // Grace period after campaign end before we stop fetching (default 7 days = 1 week)
  const graceDays = filterGraceDays ?? 7;
  const graceMs = graceDays * 24 * 60 * 60 * 1000;

  // Filter by requested types and expiry
  const activeIds = campaignIds.filter((id) => {
    const meta = idToMeta[id];
    if (!meta) return false;

    if (filterTypes && filterTypes.length > 0 && !filterTypes.includes(meta.type)) {
      return false;
    }

    // Determine end date: prefer Algolia field, fall back to week parsed from campaign ID
    let endDate = meta.endDate ? new Date(meta.endDate) : null;
    if (!endDate) {
      const parsed = parseCampaignWeek(id);
      if (parsed) endDate = isoWeekEndDate(parsed.year, parsed.week);
    }

    if (endDate && Number.isFinite(endDate.getTime())) {
      if (endDate.getTime() + graceMs < nowMs) return false;
    }

    return true;
  });

  const skipped = campaignIds.length - activeIds.length;
  console.log(
    `[elgiganten-campaigns] Discovered ${campaignIds.length} campaigns; ` +
    `${activeIds.length} active after type/expiry filter (${skipped} skipped)`
  );

  return activeIds;
}

/** Paginate all products for a given Algolia filter string. Respects 1500-hit cap. */
async function fetchAllPages(apiKey, filter) {
  const hits = [];
  let page = 0;

  for (;;) {
    const payload = await algoliaPost(apiKey, {
      requests: [{
        indexName: INDEX,
        hitsPerPage: HITS_PER_PAGE,
        page,
        query: '',
        filters: filter,
        attributesToRetrieve: [
          'objectID', 'articleNumber', 'title', 'name', 'brand',
          'price', 'beforePrice', 'discountAmount', 'savePrice', 'singleFuturePrice',
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

/** Parse a Swedish price string like "1499:-" or "1 499 kr" → integer SEK, or null. */
function parseSwedishPrice(str) {
  if (!str || typeof str !== 'string') return null;
  const cleaned = str.replace(/[^\d,.]/g, '').replace(',', '.');
  const val = parseFloat(cleaned);
  return Number.isFinite(val) && val > 0 ? Math.round(val) : null;
}

/** Build a short human-readable label from a campaign entry. */
function buildCampaignLabel(campaign) {
  if (!campaign) return 'Sale';
  const text = campaign.campaignText ?? '';
  // Shorten long internal texts like "Huvudkampanj vecka 17 för Elgiganten SE" → "Veckans deals v.17"
  const weekMatch = text.match(/vecka\s+(\d+)/i);
  if (weekMatch) return `Veckans deals v.${weekMatch[1]}`;
  // Use campaign text as-is if it's short enough
  if (text.length <= 40) return text;
  return text.slice(0, 37) + '…';
}

function mapCampaignHit(hit, campaignId, source, now, minDiscountPct) {
  const externalId = String(hit.objectID ?? hit.articleNumber ?? '').trim();
  const title = String(hit.title ?? hit.name ?? '').trim();
  if (!externalId || !title) return null;

  const regularPriceSek =
    typeof hit.price?.amount === 'number' && hit.price.amount > 0
      ? hit.price.amount
      : null;
  if (!regularPriceSek) return null;

  // Find the matching campaign entry to get its specific campaignPrice
  const allCampaigns = hit.articleCampaigns ?? [];
  const matchedCampaign = allCampaigns.find((c) => c.campaignId === campaignId);
  const campaignPrice =
    matchedCampaign?.campaignPrice != null && matchedCampaign.campaignPrice > 0
      ? matchedCampaign.campaignPrice
      : null;

  // singleFuturePrice carries the deal price as a formatted string e.g. "1499:-"
  const sfp = hit.singleFuturePrice ?? null;
  const futurePriceSek = parseSwedishPrice(sfp?.price);

  // Priority for sale price: campaignPrice > singleFuturePrice > regularPrice
  const priceSek = campaignPrice ?? futurePriceSek ?? regularPriceSek;

  // Reference (original) price: beforePrice field → singleFuturePrice.beforePrice → regularPriceSek if discounted
  const sfpBeforeSek = parseSwedishPrice(sfp?.beforePrice);
  const referencePriceSek =
    typeof hit.beforePrice === 'number' && hit.beforePrice > 0 ? hit.beforePrice
    : sfpBeforeSek != null ? sfpBeforeSek
    : priceSek < regularPriceSek ? regularPriceSek
    : null;

  // Apply minimum discount filter
  if (minDiscountPct > 0 && referencePriceSek != null) {
    const pct = ((referencePriceSek - priceSek) / referencePriceSek) * 100;
    if (pct < minDiscountPct) return null;
  }

  // Label: use the matched campaign's text for clarity
  const conditionLabel = buildCampaignLabel(matchedCampaign ?? allCampaigns[0]);

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
    // Include campaignId in externalId so the same product can appear under different campaigns
    externalId: `${externalId}:${campaignId}`,
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

export async function collectFromElgigantenCampaigns({ source, sourceState, now }) {
  const campaignTypes = Array.isArray(source.campaignTypes) ? source.campaignTypes : ['W'];
  const pinnedIds = Array.isArray(source.campaignIds) ? source.campaignIds : [];
  const minDiscountPct = typeof source.minDiscountPct === 'number' ? source.minDiscountPct : 0;
  const maxProducts = source.maxProducts ?? 5000;
  // Grace period after campaign end before we stop fetching it (default 3 days)
  const campaignGraceDays = typeof source.campaignGraceDays === 'number' ? source.campaignGraceDays : 3;

  // Step 0: obtain a fresh signed Algolia API key via the nonce flow
  let apiKey;
  try {
    apiKey = await getAlgoliaApiKey(sourceState);
  } catch (err) {
    throw new Error(`Elgiganten campaigns: failed to obtain Algolia API key — ${err.message}`);
  }

  // Step 1: collect campaign IDs — pinned IDs + auto-discovered by type
  let discoveredIds = [];
  try {
    discoveredIds = await discoverCampaigns(apiKey, campaignTypes, campaignGraceDays);
  } catch (err) {
    throw new Error(`Elgiganten campaigns: failed to discover campaign IDs — ${err.message}`);
  }

  // Merge pinned IDs (deduped), pinned first so they always run
  const campaignIds = [...new Set([...pinnedIds, ...discoveredIds])];

  if (campaignIds.length === 0) {
    console.log('[elgiganten-campaigns] No active campaigns found for the configured types.');
    return [];
  }

  // Step 2: fetch all products per campaign, tracking which campaign each hit belongs to
  // Dedup by externalId+campaignId so the same product can appear under different campaigns
  const seen = new Set();
  const taggedHits = []; // [{hit, campaignId}]

  for (const cid of campaignIds) {
    if (taggedHits.length >= maxProducts) break;
    const filter = `articleCampaigns.campaignId:${cid}`;
    try {
      const hits = await fetchAllPages(apiKey, filter);
      for (const h of hits) {
        const id = String(h.objectID ?? h.articleNumber ?? '');
        const key = `${id}:${cid}`;
        if (!id || seen.has(key)) continue;
        seen.add(key);
        taggedHits.push({ hit: h, campaignId: cid });
      }
      console.log(`[elgiganten-campaigns] Campaign ${cid}: ${hits.length} products (running total: ${taggedHits.length})`);
    } catch (err) {
      console.warn(`[elgiganten-campaigns] Skipping campaign ${cid}: ${err.message}`);
    }
  }

  // Step 3: map and filter observations
  const observations = taggedHits
    .map(({ hit, campaignId: cid }) => mapCampaignHit(hit, cid, source, now, minDiscountPct))
    .filter(Boolean);

  console.log(`[elgiganten-campaigns] ${observations.length} sale items (${taggedHits.length - observations.length} skipped by discount filter)`);
  return observations;
}
