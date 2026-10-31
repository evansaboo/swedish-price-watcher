// ═══════════════════════════════════════════════════════════════
// Inet Fyndhörnan (Bargain Corner) — Direct HTML fetch + parse
// Server-rendered React with hydrate JSON embedded in script tags.
// No Apify needed — just fetch HTML and extract the JSON payload.
// ═══════════════════════════════════════════════════════════════

const BASE_URL = 'https://www.inet.se/fyndhornan';
const IMAGE_BASE = 'https://cdn.inet.se/product/500x500/';
const PRODUCT_BASE = 'https://www.inet.se/produkt/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function extractProducts(html) {
  // Find: hydrate("BargainPage", JSON.parse("..."), ...)
  const marker = 'hydrate("BargainPage"';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return [];

  // Find the first JSON.parse(" after the marker
  const parseMarker = 'JSON.parse("';
  const parseIdx = html.indexOf(parseMarker, markerIdx);
  if (parseIdx === -1) return [];

  const contentStart = parseIdx + parseMarker.length;
  // Find closing ") — the end of the JSON string argument
  const closingIdx = html.indexOf('")', contentStart);
  if (closingIdx === -1) return [];

  const rawJsonStr = html.substring(contentStart, closingIdx);

  // Decode escaped JSON: \" → " and \\ → \
  const decoded = rawJsonStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

  let data;
  try {
    data = JSON.parse(decoded);
  } catch {
    return [];
  }

  const vm = data.productListWithDynamicFilterViewModel;
  if (!vm || !vm.products) return [];

  // products is a dict keyed by product ID
  const productsDict = vm.products;
  return Object.values(productsDict);
}

function totalQty(qtyObj) {
  if (!qtyObj || typeof qtyObj !== 'object') return null;
  let total = 0;
  for (const warehouse of Object.values(qtyObj)) {
    if (warehouse && typeof warehouse.qty === 'number' && !warehouse.blocked) {
      total += warehouse.qty;
    }
  }
  return total;
}

export async function collectFromInet({ source, fetcher, sourceState, now, signal }) {
  const maxPages = source.maxPages ?? 7;
  const allProducts = [];
  const seen = new Set();
  sourceState.lastScanPartial = false;

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? BASE_URL : `${BASE_URL}?page=${page}`;
    console.log(`[inet] Fetching page ${page}/${maxPages}: ${url}`);

    let html;
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
        },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
      });
      if (!response.ok) {
        console.warn(`[inet] Page ${page} returned ${response.status}, stopping.`);
        sourceState.lastScanPartial = true;
        break;
      }
      html = await response.text();
    } catch (err) {
      console.warn(`[inet] Page ${page} fetch failed: ${err.message}`);
      sourceState.lastScanPartial = true;
      break;
    }

    const products = extractProducts(html);
    if (products.length === 0) {
      console.log(`[inet] Page ${page}: no products found, stopping.`);
      break;
    }

    for (const p of products) {
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      allProducts.push(p);
    }

    console.log(`[inet] Page ${page}: ${products.length} products (total: ${allProducts.length})`);

    // Polite delay between pages
    if (page < maxPages) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  console.log(`[inet] Total collected: ${allProducts.length} products`);

  // Map to observations
  const observations = [];
  for (const p of allProducts) {
    const price = p.price?.price ?? null;
    if (!price || typeof price !== 'number') continue;

    const listPrice = p.price?.listPrice ?? null;
    const qty = totalQty(p.qty);
    const availability = qty === null ? 'unknown'
      : qty > 5 ? 'in_stock'
      : qty > 0 ? 'few_left'
      : 'out_of_stock';

    const imageUrl = p.image
      ? `${IMAGE_BASE}${p.image}`
      : null;

    observations.push({
      sourceId: source.id,
      sourceLabel: source.label || 'Inet Fyndhörnan',
      sourceType: source.type,
      externalId: String(p.id),
      title: p.name || '',
      url: p.urlName ? `${PRODUCT_BASE}${p.id}/${p.urlName}` : `${PRODUCT_BASE}${p.id}`,
      priceSek: price,
      referencePriceSek: listPrice && listPrice > price ? listPrice : null,
      category: mapCategory(p.categoryId) || 'Övrigt',
      condition: 'outlet',
      conditionLabel: p.sellingPoint || 'Fyndhörnan',
      availability,
      imageUrl,
      seenAt: now
    });
  }

  return observations;
}

// Basic category mapping from Inet categoryIds
function mapCategory(categoryId) {
  const map = {
    30: 'Bildskärmar',
    27: 'Datorer',
    34: 'Komponenter',
    31: 'Kringutrustning',
    32: 'Nätverk',
    33: 'Lagring',
    35: 'Ljud & Bild',
    36: 'Foto & Video',
    37: 'Mobiltelefoner',
    38: 'Surfplattor',
    39: 'Gaming',
    40: 'Smarta hem',
    41: 'Kablar',
    1079: 'Kylning',
    1324: 'Begagnade datorer',
    1365: 'Begagnade mobiler',
  };
  return map[categoryId] || null;
}
