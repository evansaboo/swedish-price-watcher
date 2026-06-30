import { normalizeProductIdentity, sleep } from '../lib/utils.js';

// Tradera's public search page. We request the ENDED view (itemStatus=Ended) so the
// displayed price for an auction is the *realized* winning bid — i.e. an actual SOLD
// price, which is a far more accurate resale signal than Blocket's asking prices.
const SEARCH_BASE = 'https://www.tradera.com/search';

// ms between page/keyword requests — Tradera is a normal site, stay polite.
const PAGE_DELAY_MS = 700;

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'sv-SE,sv;q=0.9,en;q=0.8',
};

// High-demand, resellable models the resale engine can match (Apple, GPUs, consoles,
// CPUs, Samsung, handhelds, …). Keeping the set focused keeps Tradera comps relevant
// and the scan polite.
const DEFAULT_KEYWORDS = [
  'rtx 4070',
  'rtx 4080',
  'rtx 4090',
  'rtx 5070',
  'rtx 5080',
  'rtx 3080',
  'playstation 5',
  'xbox series x',
  'nintendo switch',
  'steam deck',
  'rog ally',
  'iphone 15',
  'iphone 14',
  'iphone 13',
  'samsung galaxy s24',
  'samsung galaxy s23',
  'macbook pro',
  'macbook air',
  'ipad pro',
  'ipad air',
  'apple watch',
  'airpods pro',
  'meta quest 3',
  'ryzen 7',
  'ryzen 9',
];

// Tradera item-card types whose displayed ended price represents a realized sale.
// Auction / AuctionBin closed via a winning bid; PureBin/ShopItem are fixed-price
// retailer listings and are excluded as resale comps.
const SOLD_TYPES = new Set(['Auction', 'AuctionBin']);

/**
 * Parse Tradera search-result HTML into raw card records.
 * Each result card is an element `id="item-card-<id>"` containing a
 * `data-item-type`, an item link, a `data-testid="price"` element and an image.
 */
export function parseTraderaCards(html) {
  const cards = [];
  const re = /id="item-card-(\d+)"/g;
  const positions = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    positions.push({ id: m[1], idx: m.index });
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].idx;
    const end = i + 1 < positions.length ? positions[i + 1].idx : html.length;
    const block = html.slice(start, end);

    const typeM = block.match(/data-item-type="([^"]+)"/);
    const hrefM = block.match(/href="(\/item\/[^"]+)"/);
    const titleM = block.match(/title="([^"]+)"/);
    const priceM = block.match(/data-testid="price">([\d\s\u00a0]+)kr/);
    const imgM = block.match(/(https:\/\/img\.tradera\.net\/[^"\s]+)/);

    if (!priceM) continue;
    const price = Number(priceM[1].replace(/[\s\u00a0]/g, ''));
    if (!Number.isFinite(price) || price <= 0) continue;

    cards.push({
      id: positions[i].id,
      type: typeM?.[1] ?? null,
      title: decodeEntities(titleM?.[1] ?? '').trim(),
      url: hrefM ? `https://www.tradera.com${hrefM[1]}` : null,
      priceSek: price,
      imageUrl: imgM?.[1] ?? null,
    });
  }

  return cards;
}

function decodeEntities(str) {
  return String(str ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&#246;/g, 'ö')
    .replace(/&#228;/g, 'ä')
    .replace(/&#229;/g, 'å')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function mapCard(card, source, now, keyword) {
  const title = card.title;
  if (!card.id || !title) return null;

  const keywordCategory = keyword
    ? keyword.charAt(0).toUpperCase() + keyword.slice(1)
    : null;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId: card.id,
    title,
    url: card.url ?? `https://www.tradera.com/item/${card.id}`,
    productKey: normalizeProductIdentity(title),
    priceSek: card.priceSek,
    referencePriceSek: null,
    marketValueSek: null,
    imageUrl: card.imageUrl,
    category: keywordCategory ?? 'Elektronik',
    // condition 'used' folds these into the resale comp index. soldComp + availability
    // 'sold' keep them OUT of the buyable products grid (they are realized sale prices,
    // not things you can buy).
    condition: 'used',
    conditionLabel: 'Såld (Tradera)',
    availability: 'sold',
    soldComp: true,
    seenAt: now,
  };
}

function buildKeywords(source) {
  const seen = new Set();
  const result = [];
  for (const kw of (source.keywords ?? DEFAULT_KEYWORDS)) {
    const t = String(kw ?? '').trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(t);
    }
  }
  return result;
}

async function waitOrAbort(milliseconds, signal) {
  try {
    await sleep(milliseconds, signal);
    return true;
  } catch (error) {
    if (error?.name === 'AbortError') return false;
    throw error;
  }
}

/**
 * Collect Tradera realized sold prices (ended auctions) for high-demand resale models.
 * These observations carry condition 'used' so they enrich the resale comp index used
 * by the flip engine, with availability 'sold' so they never appear as buyable products.
 */
export async function collectFromTradera({ source, fetcher, sourceState, now, signal }) {
  const keywords = buildKeywords(source);
  const maxPagesPerKeyword = source.maxPagesPerKeyword ?? 2;
  const maxProducts = source.maxProducts ?? 1500;
  if (sourceState) sourceState.lastScanPartial = false;

  console.log(`[${source.id}] Searching ${keywords.length} ended-auction keywords (maxPages=${maxPagesPerKeyword})`);

  const observations = [];
  const seenIds = new Set();

  for (const keyword of keywords) {
    if (observations.length >= maxProducts) break;

    for (let page = 1; page <= maxPagesPerKeyword; page++) {
      if (observations.length >= maxProducts) break;

      const url = `${SEARCH_BASE}?q=${encodeURIComponent(keyword)}&itemStatus=Ended&sortBy=EndDateDesc&page=${page}`;
      let html;
      try {
        const result = await fetcher.fetchText(source, null, url, {
          headers: HEADERS,
          skipRobotsCheck: true,
          skipHostDelay: true,
        });
        html = result.body;
        if (!html) {
          console.warn(`[${source.id}] Empty response for keyword="${keyword}" page=${page}`);
          break;
        }
      } catch (err) {
        if (signal?.aborted || /aborted/i.test(err?.message ?? '')) {
          if (sourceState) sourceState.lastScanPartial = true;
          return observations;
        }
        console.warn(`[${source.id}] Fetch error for keyword="${keyword}" page=${page}: ${err.message}`);
        if (sourceState) sourceState.lastScanPartial = true;
        break;
      }

      const cards = parseTraderaCards(html);
      let newOnPage = 0;
      for (const card of cards) {
        if (!SOLD_TYPES.has(card.type)) continue; // realized auction sales only
        if (seenIds.has(card.id)) continue;
        seenIds.add(card.id);
        const obs = mapCard(card, source, now, keyword);
        if (obs) {
          observations.push(obs);
          newOnPage++;
        }
      }

      // No realized sales on this page — stop paginating this keyword.
      if (newOnPage === 0) break;

      if (page < maxPagesPerKeyword && !(await waitOrAbort(PAGE_DELAY_MS, signal))) {
        return observations;
      }
    }

    if (!(await waitOrAbort(PAGE_DELAY_MS, signal))) {
      return observations;
    }
  }

  console.log(`[${source.id}] Total: ${observations.length} sold comps`);
  return observations;
}
