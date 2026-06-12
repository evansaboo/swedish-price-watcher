import { resolveIncrementalMode } from '../lib/incremental.js';
import { normalizeProductIdentity, sleep } from '../lib/utils.js';

const BASE_URL = 'https://www.netonnet.se';
const OUTLET_URL = `${BASE_URL}/art/outlet`;
const FYNDVAROR_URL = `${BASE_URL}/art/fyndvaror`;
const PRODUCTS_PER_PAGE = 48;

// ms to wait between requests — polite but not the global 8s hostDelayMs
const PAGE_DELAY_MS = 400;
const REF_DELAY_MS = 300;

// Category slug → human-readable label
const CATEGORY_MAP = {
  ljud: 'Ljud',
  gaming: 'Gaming',
  'dator-surfplatta': 'Dator & Surfplatta',
  'mobil-smartwatch': 'Mobil & Smartwatch',
  'hem-fritid': 'Hem & Fritid',
  'foto-kamera': 'Foto & Kamera',
  tv: 'TV',
  natverk: 'Nätverk',
  'smarta-hem': 'Smarta Hem',
  outlet: 'Outlet',
  personvard: 'Personvård',
  vitvaror: 'Vitvaror',
  datorkomponenter: 'Datorkomponenter',
  grill: 'Grill',
  refurbished: 'Refurbished',
  'el-verktyg': 'El & Verktyg',
  sport: 'Sport',
  leksaker: 'Leksaker',
};

// NetOnNet blocks non-browser user-agents — must mimic a real browser
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PAGE_HEADERS = {
  'user-agent': BROWSER_UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'sv-SE,sv;q=0.9',
};

function parseTotalPages(html) {
  // RSC data uses backslash-escaped quotes: \"totalPages\":8
  const m = html.match(/\\"totalPages\\":(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

function resolveCategory(canonicalUrl) {
  if (!canonicalUrl) return null;
  // URL shape: /art/{category-slug}/{subcategory-slug}/...
  const parts = canonicalUrl.replace(/^\/art\//, '').split('/').filter(Boolean);
  const slug = parts[0] ?? null;
  return CATEGORY_MAP[slug] ?? slug ?? null;
}

function buildImageUrl(articleNumber, imageId) {
  if (!articleNumber || !imageId) return null;
  return `${BASE_URL}/GetFile/ProductImagePrimary/(${articleNumber})_${imageId}_largeHD.webp`;
}

function extractProducts(html) {
  // Products are embedded in RSC JSON with backslash-escaped quotes.
  // Marker matches any /art/ category page (outlet, fyndvaror, etc.)
  const marker = '\\"itemListName\\":\\"category=/art/';
  const positions = [];
  let searchFrom = 0;
  while (true) {
    const idx = html.indexOf(marker, searchFrom);
    if (idx === -1) break;
    positions.push(idx);
    searchFrom = idx + marker.length;
  }

  const products = [];
  const seen = new Set();

  for (const pos of positions) {
    // 6KB context is enough for one full product card RSC payload
    const ctx = html.slice(pos, pos + 6000);

    const artM = ctx.match(/\\"articleNumber\\":\\"(\d+)\\"/);
    if (!artM) continue;
    const articleNumber = artM[1];
    if (seen.has(articleNumber)) continue;
    seen.add(articleNumber);

    const priceM = ctx.match(/\\"price\\":\{\\"priceList\\"[^}]+\\"price\\":(\d+(?:\.\d+)?)/);
    const urlM = ctx.match(/\\"canonicalUrl\\":\\"(\/[^"\\]+)\\"/);
    const brandM = ctx.match(/\\"brand\\":\\"([^"\\]+)\\"/);
    const histM = ctx.match(/\\"lowestHistoricalPrice\\":(null|-?\d+(?:\.\d+)?)/);
    const altM = ctx.match(/\\"altDesc\\":\\"([^"\\]+)\\"/);
    // Image src pattern: /GetFile/ProductImagePrimary/(ARTICLENO)_IMAGEID_{0}.{1}
    const imgM = ctx.match(/\\"src\\":\\"\/GetFile\/ProductImagePrimary\/\((\d+)\)_(\d+)_\{0\}/);

    const price = priceM ? parseFloat(priceM[1]) : null;
    if (!price || !urlM) continue;

    const canonicalUrl = urlM[1];
    const historicalPrice = histM && histM[1] !== 'null' ? parseFloat(histM[1]) : null;

    products.push({
      articleNumber,
      name: altM ? altM[1] : null,
      brand: brandM ? brandM[1] : null,
      price,
      lowestHistoricalPrice: historicalPrice,
      canonicalUrl,
      category: resolveCategory(canonicalUrl),
      imageUrl: buildImageUrl(articleNumber, imgM ? imgM[2] : null),
    });
  }

  return products;
}

function mapProduct(product, source, now) {
  const name = product.name ?? '';
  const brand = product.brand ?? '';
  // Avoid duplicating brand when altDesc already starts with brand name
  const title = (name && brand && name.toLowerCase().startsWith(brand.toLowerCase()))
    ? name
    : [brand, name].filter(Boolean).join(' ');
  if (!title || !product.price) return null;

  const productKey = normalizeProductIdentity(product.name ?? title);
  const url = `${BASE_URL}${product.canonicalUrl}`;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId: product.articleNumber,
    productKey,
    title,
    url,
    category: product.category,
    condition: 'outlet',
    conditionLabel: 'Outlet',
    priceSek: product.price,
    // NetOnNet does not always provide a reference price in the outlet listing RSC
    marketValueSek: product.lowestHistoricalPrice ?? null,
    referencePriceSek: product.lowestHistoricalPrice ?? null,
    referenceUrl: null,
    referenceTitle: null,
    referenceSourceLabel: null,
    availability: 'unknown',
    imageUrl: product.imageUrl ?? null,
    notes: source.notes ?? null,
    seenAt: now,
  };
}

// Parse the lowestHistoricalPrice from an individual product page RSC payload
function parseReferencePrice(html) {
  const m = html.match(/\\"lowestHistoricalPrice\\":(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function scrapeAllPages(basePageUrl, source, sourceState, fetcher, now, maxPages, partialFlag, incremental) {
  const observations = [];
  let consecutiveKnownPages = 0;

  function addPage(products) {
    let newOnPage = 0;
    for (const p of products) {
      const obs = mapProduct(p, source, now);
      if (!obs) continue;
      observations.push(obs);
      if (!incremental?.knownIds.has(obs.externalId)) newOnPage++;
    }
    // Incremental stop: enough consecutive fully-known pages mean deeper
    // pages are unchanged since the previous scan.
    if (incremental?.active && products.length > 0) {
      consecutiveKnownPages = newOnPage === 0 ? consecutiveKnownPages + 1 : 0;
      if (consecutiveKnownPages >= incremental.stopPages) {
        console.log(`[${source.id}] ${basePageUrl}: ${consecutiveKnownPages} consecutive fully-known pages — stopping early (incremental)`);
        if (partialFlag) partialFlag.partial = true;
        return false;
      }
    }
    return true;
  }

  const firstResult = await fetcher.fetchText(source, sourceState, basePageUrl, {
    headers: PAGE_HEADERS,
    skipRobotsCheck: true,
    skipHostDelay: true,
  });

  if (firstResult.notModified) return observations;

  const firstHtml = firstResult.body;
  const totalPages = Math.min(parseTotalPages(firstHtml), maxPages);

  if (!addPage(extractProducts(firstHtml))) return observations;

  for (let pageIdx = 1; pageIdx < totalPages; pageIdx++) {
    const pageUrl = `${basePageUrl}?p=${pageIdx}`;
    let result;
    try {
      result = await fetcher.fetchText(source, null, pageUrl, {
        headers: PAGE_HEADERS,
        skipRobotsCheck: true,
        skipHostDelay: true,
      });
    } catch (err) {
      if (observations.length > 0) {
        if (partialFlag) partialFlag.partial = true;
        break;
      }
      throw err;
    }

    const products = extractProducts(result.body);
    if (products.length === 0) break;

    if (!addPage(products)) break;

    await sleep(PAGE_DELAY_MS);

    if (products.length < PRODUCTS_PER_PAGE) break;
  }

  return observations;
}

export async function collectFromNetonnet({ source, sourceState, fetcher, now }) {
  const maxPages = source.maxPages ?? 25;
  const partialFlag = { partial: false };
  const incremental = resolveIncrementalMode(source, sourceState);
  if (incremental.active) console.log(`[${source.id}] Incremental mode (${incremental.knownIds.size} known IDs)`);

  // Scrape both /art/outlet (~8 pages) and /art/fyndvaror (~18 pages)
  const [outletObs, fyndvarorObs] = await Promise.all([
    scrapeAllPages(OUTLET_URL, source, sourceState, fetcher, now, maxPages, partialFlag, incremental).catch((err) => {
      console.warn(`[netonnet] outlet scrape failed: ${err.message}`);
      partialFlag.partial = true;
      return [];
    }),
    scrapeAllPages(FYNDVAROR_URL, source, sourceState, fetcher, now, maxPages, partialFlag, incremental).catch((err) => {
      console.warn(`[netonnet] fyndvaror scrape failed: ${err.message}`);
      partialFlag.partial = true;
      return [];
    }),
  ]);
  sourceState.lastScanPartial = partialFlag.partial;

  // Deduplicate by externalId (same product can appear in both sections)
  const seen = new Set();
  const observations = [];
  for (const obs of [...outletObs, ...fyndvarorObs]) {
    if (!seen.has(obs.externalId)) {
      seen.add(obs.externalId);
      observations.push(obs);
    }
  }

  // ── Reference price lookup ─────────────────────────────────────────────────
  // The outlet list page omits lowestHistoricalPrice for most items.
  // Fetch individual product pages to resolve missing reference prices,
  // caching results in sourceState so subsequent scans avoid re-fetching.
  // Batch parallel fetches (5 at a time) to reduce total wall-clock time.
  const refCache = sourceState.referencePriceCache ?? (sourceState.referencePriceCache = {});
  const maxLookups = source.maxReferenceLookups ?? 40;
  const REF_BATCH_SIZE = 5;
  const REF_BATCH_DELAY_MS = 500; // pause between batches to stay polite

  // Apply cache hits first
  for (const obs of observations) {
    if (obs.referencePriceSek != null) continue;
    const articleNo = obs.externalId;
    if (articleNo && refCache[articleNo] != null) {
      obs.referencePriceSek = refCache[articleNo];
      obs.marketValueSek = refCache[articleNo];
    }
  }

  // Collect items that still need a network lookup
  const toLookup = observations
    .filter((obs) => obs.referencePriceSek == null && obs.externalId && obs.url)
    .slice(0, maxLookups);

  for (let i = 0; i < toLookup.length; i += REF_BATCH_SIZE) {
    const batch = toLookup.slice(i, i + REF_BATCH_SIZE);
    await Promise.all(batch.map(async (obs) => {
      try {
        const result = await fetcher.fetchText(source, {}, obs.url, {
          headers: PAGE_HEADERS,
          skipRobotsCheck: true,
          skipHostDelay: true,
        });
        const refPrice = parseReferencePrice(result.body ?? '');
        if (refPrice != null && refPrice > 0) {
          refCache[obs.externalId] = refPrice;
          obs.referencePriceSek = refPrice;
          obs.marketValueSek = refPrice;
        }
      } catch {
        // Non-fatal — missing reference price is fine
      }
    }));
    if (i + REF_BATCH_SIZE < toLookup.length) await sleep(REF_BATCH_DELAY_MS);
  }

  return observations;
}
