import { normalizeProductIdentity, sleep, slugify, stripText } from '../lib/utils.js';

const BASE_URL = 'https://www.webhallen.com';
const FYNDWARE_API_URL = `${BASE_URL}/api/productdiscovery/search/fyndware`;
const TOPLIST_API_URL = `${BASE_URL}/api/productdiscovery/toplist`;
const PAGE_SIZE = 100;
const TOPLIST_PAGE_SIZE = 24; // toplist API has a fixed page size
const MAX_PAGES = 30; // safety cap (~3000 products)

const AJAX_HEADERS = {
  accept: 'application/json',
  'x-requested-with': 'XMLHttpRequest',
  region: 'se',
  referer: `${BASE_URL}/se/`,
};

function buildProductUrl(product) {
  // Use mainTitle (clean name without fyndware class) for the URL slug
  const cleanTitle = stripText(product.mainTitle || product.name || '')
    .replace(/\s*\(Fyndvara[^)]*\)/gi, '')
    .replace(/\s*-\s*Klass\s*\d+/gi, '')
    .trim();
  const nameSlug = slugify(cleanTitle);
  return `${BASE_URL}/se/product/${product.id}-${nameSlug}`;
}

function resolveCategory(product) {
  const tree = stripText(product.categoryTree ?? '');
  if (!tree) return null;
  // categoryTree is e.g. "Datorer & Tillbehör/Datortillbehör/Gaming headset/Headset PC"
  const parts = tree.split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  // Prefer index 1 or 2 — specific enough to be useful, not so deep it's a model name
  // The last segment can be overly specific (brand/model variant), so pick second-to-last
  // unless it's the only option
  const candidateIdx = Math.min(2, parts.length - 1);
  return parts[candidateIdx] || parts[0];
}

function resolveCondition(product) {
  const cls = product.fyndwareClass;
  if (!cls) return 'outlet';
  // Class 1 = Nyskick (like new), Class 2 = Gott skick (good condition), Class 3+ = Begagnat
  switch (cls.id) {
    case 1: return 'outlet'; // opened/tested, near new
    case 2: return 'outlet'; // good condition, minor wear
    default: return 'used';
  }
}

function resolveConditionLabel(product) {
  const cls = product.fyndwareClass;
  if (!cls) return 'Fyndvara';
  return cls.name ?? `Fyndvara klass ${cls.id}`;
}

function parsePriceSek(priceObj) {
  if (!priceObj?.price) return null;
  const n = parseFloat(priceObj.price);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseImageUrl(product) {
  // Webhallen uses cdn image IDs: https://www.webhallen.com/images/product/{id}/
  if (!product.id) return null;
  return `${BASE_URL}/images/product/${product.id}/`;
}

function mapProduct(product, source, now) {
  const priceSek = parsePriceSek(product.price);
  if (!priceSek) return null;

  const title = stripText(product.name || product.mainTitle || '');
  if (!title) return null;

  // The regularPrice is the non-outlet (new) reference price
  const regularPriceSek = parsePriceSek(product.regularPrice);
  const lowestPriceSek = parsePriceSek(product.lowestPrice);
  const referencePriceSek = regularPriceSek ?? lowestPriceSek ?? null;

  const url = buildProductUrl(product);
  const cleanTitle = title.replace(/\s*\(Fyndvara[^)]*\)/gi, '').replace(/\s*-\s*Klass\s*\d+/gi, '').trim();
  const productKey = normalizeProductIdentity(cleanTitle);

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId: String(product.id),
    productKey,
    title,
    url,
    category: resolveCategory(product),
    condition: resolveCondition(product),
    conditionLabel: resolveConditionLabel(product),
    priceSek,
    marketValueSek: referencePriceSek,
    referencePriceSek,
    referenceUrl: null,
    referenceTitle: null,
    referenceSourceLabel: null,
    availability: product.stock?.web > 0 ? 'in_stock' : 'unknown',
    imageUrl: parseImageUrl(product),
    notes: source.notes ?? null,
    seenAt: now,
  };
}

export async function collectFromWebhallen({ source, fetcher, now }) {
  return source.toplistId != null
    ? collectFromToplist({ source, fetcher, now })
    : collectFromFyndwareSearch({ source, fetcher, now });
}

async function collectFromFyndwareSearch({ source, fetcher, now }) {
  const observations = [];
  let page = 1;
  const interPageDelayMs = source.apiDelayMs ?? 400;

  while (page <= MAX_PAGES) {
    const url = `${FYNDWARE_API_URL}?pageNo=${page}&limit=${PAGE_SIZE}`;

    let payload;
    try {
      payload = await fetcher.fetchJsonApi(url, {
        headers: AJAX_HEADERS,
        skipHostDelay: true, // manage delay ourselves — 8s per page would take 3+ minutes
      });
    } catch (err) {
      if (observations.length > 0) {
        // Partial results are still useful — stop pagination gracefully
        break;
      }
      throw err;
    }

    const products = payload?.products ?? [];
    if (!Array.isArray(products) || products.length === 0) break;

    for (const product of products) {
      if (!product.isFyndware) continue;
      const obs = mapProduct(product, source, now);
      if (obs) observations.push(obs);
    }

    const filteredCount = payload?.filteredProductCount;
    const fetched = (page - 1) * PAGE_SIZE + products.length;
    if (Number.isFinite(filteredCount) && fetched >= filteredCount) break;
    if (products.length < PAGE_SIZE) break;

    page++;
    await sleep(interPageDelayMs);
  }

  return observations;
}

/**
 * Collect products from a Webhallen toplist (e.g. toplist/64 = Fyndvaror,
 * toplist/39 = Datorer deals, toplist/42 = Mobil deals).
 * Page size is fixed at 24 by the API.
 */
async function collectFromToplist({ source, fetcher, now }) {
  const toplistId = source.toplistId;
  const interPageDelayMs = source.apiDelayMs ?? 300;
  const observations = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const url =
      `${TOPLIST_API_URL}/${toplistId}?page=${page}&touchpoint=MOBILE` +
      `&totalProductCountSet=true&engine=voyadoElevate`;

    let payload;
    try {
      payload = await fetcher.fetchJsonApi(url, {
        headers: AJAX_HEADERS,
        skipHostDelay: true,
      });
    } catch (err) {
      if (observations.length > 0) break;
      throw err;
    }

    const products = payload?.products ?? [];
    if (!Array.isArray(products) || products.length === 0) break;

    for (const product of products) {
      const obs = mapProduct(product, source, now);
      if (obs) observations.push(obs);
    }

    const filteredCount = payload?.filteredProductCount;
    const fetched = (page - 1) * TOPLIST_PAGE_SIZE + products.length;
    if (Number.isFinite(filteredCount) && fetched >= filteredCount) break;
    if (products.length < TOPLIST_PAGE_SIZE) break;

    page++;
    await sleep(interPageDelayMs);
  }

  return observations;
}
