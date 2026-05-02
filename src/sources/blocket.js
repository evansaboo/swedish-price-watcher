import { normalizeProductIdentity, sleep } from '../lib/utils.js';

// Blocket's internal BFF search API — no auth required, same-origin session
const API_BASE =
  'https://www.blocket.se/recommerce/forsale/search/api/search/SEARCH_ID_BAP_COMMON';

// Default sort: newest listings first (RELEVANCE also available)
const DEFAULT_SORT = 'PUBLISHED_DESC';

// ms to wait between page/keyword requests
const PAGE_DELAY_MS = 600;

const API_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json',
  referer: 'https://www.blocket.se/recommerce/forsale/search',
};

const DEFAULT_KEYWORDS = [
  'grafikkort',
  'gaming laptop',
  'playstation 5',
  'xbox series',
  'iphone',
  'samsung galaxy',
  'macbook',
  'hörlurar',
  'bildskärm',
  'cpu',
  'gaming headset',
  'nintendo switch',
  'kamera',
  'datorkomponenter',
];

function mapDoc(doc, source, now) {
  const id = String(doc.id ?? '').trim();
  const title = (doc.heading ?? '').trim();
  if (!id || !title) return null;

  const price = doc.price?.amount;
  if (!price || isNaN(price)) return null;

  const url =
    doc.canonical_url ?? `https://www.blocket.se/recommerce/forsale/item/${id}`;
  const imageUrl = doc.image?.url ?? null;

  // ad_type 67 = "Säljes" (for sale); sub_category_id / category_id not always present
  const category = doc.category_name ?? doc.subject ?? 'Elektronik';

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId: id,
    title,
    url,
    productKey: normalizeProductIdentity(title),
    priceSek: price,
    referencePriceSek: null,
    marketValueSek: null,
    imageUrl,
    category,
    condition: 'used',
    conditionLabel: 'Begagnad',
    availability: 'in_stock',
    location: doc.location ?? null,
    seenAt: now,
  };
}

/**
 * Build the merged, deduplicated keyword list for this scan:
 * 1. Static keywords from source config
 * 2. Enabled keyword alert terms from preferences
 * 3. Favorite category names from preferences
 * 4. Category webhook patterns from preferences
 */
function buildKeywords(source, preferences) {
  const seen = new Set();
  const result = [];

  function add(term) {
    const t = String(term ?? '').trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(t);
    }
  }

  // 1. Static keywords from source config
  for (const kw of (source.keywords ?? DEFAULT_KEYWORDS)) add(kw);

  // 2. Enabled keyword alert terms
  const kwAlerts = preferences?.notificationSettings?.keywords ?? [];
  for (const k of kwAlerts) {
    if (k.enabled !== false && typeof k.keyword === 'string') add(k.keyword);
  }

  // 3. Favorite categories
  const favCats = preferences?.favoriteCategories ?? [];
  for (const cat of favCats) add(cat);

  // 4. Category webhook patterns
  const catWebhooks = preferences?.notificationSettings?.categoryWebhooks ?? [];
  for (const cw of catWebhooks) {
    if (typeof cw.pattern === 'string') add(cw.pattern);
  }

  return result;
}


/**
 * Collect Blocket second-hand electronics listings via the internal BFF JSON API.
 * No API key required — the endpoint is public and unauthenticated.
 * Paginates up to maxPagesPerKeyword pages for each search keyword.
 * Keywords are merged from: source config + enabled keyword alerts + favorite categories + category webhook patterns.
 */
export async function collectFromBlocket({ source, fetcher, preferences, now }) {
  const keywords = buildKeywords(source, preferences);
  const maxPagesPerKeyword = source.maxPagesPerKeyword ?? 3;
  const maxProducts = source.maxProducts ?? 2000;

  const observations = [];
  const seenIds = new Set();

  for (const keyword of keywords) {
    if (observations.length >= maxProducts) break;

    const lastPage = Math.min(maxPagesPerKeyword, 37); // API caps at page 37
    for (let page = 1; page <= lastPage; page++) {
      if (observations.length >= maxProducts) break;

      const sort = source.sort ?? DEFAULT_SORT;
      const url = `${API_BASE}?q=${encodeURIComponent(keyword)}&sort=${sort}&page=${page}`;
      let data;
      try {
        const result = await fetcher.fetchText(source, null, url, {
          headers: API_HEADERS,
          skipRobotsCheck: true,
          skipHostDelay: true,
        });
        data = JSON.parse(result.body);
      } catch {
        break; // non-fatal — skip remaining pages for this keyword
      }

      const docs = data?.docs ?? [];
      const totalPages = data?.metadata?.paging?.last ?? 1;

      let newOnPage = 0;
      for (const doc of docs) {
        if (seenIds.has(doc.id)) continue;
        seenIds.add(doc.id);
        const obs = mapDoc(doc, source, now);
        if (obs) {
          observations.push(obs);
          newOnPage++;
        }
      }

      // No new results or reached end of pagination — stop this keyword
      if (newOnPage === 0 || page >= totalPages) break;

      if (page < lastPage) await sleep(PAGE_DELAY_MS);
    }

    await sleep(PAGE_DELAY_MS);
  }

  return observations;
}
