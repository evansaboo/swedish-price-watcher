/**
 * Catalogue of Elgiganten's product taxonomy and brands, used to populate the
 * hotlist category picker.
 *
 * The whole catalogue (≈700 categories, 1000 brands) arrives in a single
 * facet-only Algolia request, so it is fetched on demand and cached for hours
 * rather than queried per keystroke.
 */

import { getSharedAlgoliaApiKey } from './elgigantenAuth.js';

const ALGOLIA_URL =
  'https://z0fl7r8ubh-dsn.algolia.net/1/indexes/*/queries' +
  '?x-algolia-agent=Algolia%20for%20JavaScript';
const INDEX = 'commerce_b2c_OCSEELG';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_FACET_VALUES = 1000;

let cache = null;
let inFlight = null;

function toSortedEntries(facet) {
  return Object.entries(facet ?? {})
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

async function fetchCatalog(fetcher) {
  const apiKey = await getSharedAlgoliaApiKey('[elgiganten-taxonomy]');
  const url = `${ALGOLIA_URL}&x-algolia-api-key=${apiKey}&x-algolia-application-id=Z0FL7R8UBH`;
  const response = await fetcher.fetchJsonApi(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-algolia-api-key': apiKey,
      'x-algolia-application-id': 'Z0FL7R8UBH',
      Referer: 'https://www.elgiganten.se/',
      Origin: 'https://www.elgiganten.se',
    },
    body: JSON.stringify({
      requests: [{
        indexName: INDEX,
        query: '',
        hitsPerPage: 0,
        facets: ['productTaxonomy.name', 'brand'],
        maxValuesPerFacet: MAX_FACET_VALUES,
      }],
    }),
    skipHostDelay: true,
  });

  const facets = response?.results?.[0]?.facets ?? {};
  return {
    fetchedAt: new Date().toISOString(),
    categories: toSortedEntries(facets['productTaxonomy.name']),
    brands: toSortedEntries(facets.brand),
  };
}

export async function getTaxonomyCatalog(fetcher, { force = false } = {}) {
  if (!force && cache && Date.now() - cache.cachedAtMs < CACHE_TTL_MS) {
    return cache.data;
  }
  // Collapse concurrent requests (e.g. a settings modal opening twice) into one.
  if (!inFlight) {
    inFlight = fetchCatalog(fetcher)
      .then((data) => {
        cache = { data, cachedAtMs: Date.now() };
        return data;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

export function searchCatalog(catalog, { query = '', limit = 50 } = {}) {
  const needle = String(query).trim().toLowerCase();
  const filter = (entries) => {
    const matched = needle
      ? entries.filter((entry) => entry.value.toLowerCase().includes(needle))
      : entries;
    return matched.slice(0, limit);
  };
  return {
    fetchedAt: catalog.fetchedAt,
    categories: filter(catalog.categories),
    brands: filter(catalog.brands),
    totals: { categories: catalog.categories.length, brands: catalog.brands.length },
  };
}

export function resetTaxonomyCatalogCache() {
  cache = null;
  inFlight = null;
}
