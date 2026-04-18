import { normalizeProductIdentity, sleep } from '../lib/utils.js';

const ALGOLIA_URL =
  'https://z0fl7r8ubh-dsn.algolia.net/1/indexes/*/queries' +
  '?x-algolia-agent=Algolia%20for%20JavaScript' +
  '&x-algolia-api-key=bd55a210cb7ee1126552cab633fc1350' +
  '&x-algolia-application-id=Z0FL7R8UBH';

const INDEX = 'commerce_b2c_OCSEELG';
// PT793 = Elgiganten outlet taxonomy filter
const OUTLET_FILTER = 'productTaxonomy.id:PT793';
const HITS_PER_PAGE = 100;
const PAGE_DELAY_MS = 200;
const MAX_PAGES = 200; // safety cap (~20 000 products)

const ALGOLIA_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'x-algolia-api-key': 'bd55a210cb7ee1126552cab633fc1350',
  'x-algolia-application-id': 'Z0FL7R8UBH',
};

function buildRequestBody(page) {
  return JSON.stringify({
    requests: [
      {
        indexName: INDEX,
        filters: OUTLET_FILTER,
        hitsPerPage: HITS_PER_PAGE,
        page,
        query: '',
        // Only request facets on page 0 to get total count cheaply
        facets: page === 0 ? ['hierarchicalCategories.lvl1', 'brand'] : [],
      },
    ],
  });
}

function mapHit(hit, source, now) {
  const externalId = String(hit.objectID ?? hit.articleNumber ?? '').trim();
  const title = String(hit.title ?? hit.name ?? '').trim();
  if (!externalId || !title) return null;

  // price.amount = outlet price; bItem.aItemPrice = equivalent new-item price
  const priceSek =
    typeof hit.price?.amount === 'number' && hit.price.amount > 0
      ? hit.price.amount
      : null;
  if (!priceSek) return null;

  const referencePriceSek =
    typeof hit.bItem?.aItemPrice === 'number' && hit.bItem.aItemPrice > 0
      ? hit.bItem.aItemPrice
      : null;

  const url = hit.productUrl ?? hit.urlB2C ?? null;
  const imageUrl = hit.imageUrl ?? null;

  const category =
    hit.hierarchicalCategories?.lvl2 ??
    hit.hierarchicalCategories?.lvl1 ??
    hit.hierarchicalCategories?.lvl0 ??
    'electronics';

  // bGradeTitle is a human-readable label, e.g. "Mellanstor skada på höger sida"
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
 * Collect Elgiganten outlet products via the Algolia search API.
 * No Apify/Playwright needed — uses the public search key embedded in the site JS.
 *
 * Reference price (new-item price) comes from hit.bItem.aItemPrice, so discount %
 * is fully computable without any secondary lookup.
 */
export async function collectFromElgiganten({ source, sourceState, fetcher, now }) {
  const maxProducts = source.maxProducts ?? 15000;
  const observations = [];
  const seen = new Set();
  let page = 0;
  let totalPages = MAX_PAGES;

  while (page < totalPages && observations.length < maxProducts) {
    let payload;
    try {
      payload = await fetcher.fetchJsonApi(ALGOLIA_URL, {
        method: 'POST',
        headers: ALGOLIA_HEADERS,
        body: buildRequestBody(page),
        skipHostDelay: true,
      });
    } catch (err) {
      if (observations.length > 0) break; // partial results OK
      throw new Error(`Elgiganten Algolia API failed at page ${page}: ${err.message}`);
    }

    const result = payload?.results?.[0];
    if (!result) break;

    // Set accurate page count on first response
    if (page === 0) {
      totalPages = Math.min(result.nbPages ?? MAX_PAGES, MAX_PAGES);
    }

    const hits = result.hits ?? [];
    if (hits.length === 0) break;

    for (const hit of hits) {
      const obs = mapHit(hit, source, now);
      if (!obs || seen.has(obs.externalId)) continue;
      seen.add(obs.externalId);
      observations.push(obs);
    }

    page++;
    if (page < totalPages) await sleep(PAGE_DELAY_MS);
  }

  sourceState.lastDiscoveryCount = observations.length;
  return observations;
}
