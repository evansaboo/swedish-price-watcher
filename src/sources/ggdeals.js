import { normalizeProductIdentity, sleep } from '../lib/utils.js';

/**
 * GG.deals multi-platform game price source.
 *
 * Two discovery modes:
 *
 * 1. STEAM (via GG.deals API + SteamSpy auto-discovery)
 *    - Discovers top 10 000 Steam game IDs via SteamSpy (free, no key).
 *    - IDs refreshed weekly; stored in sourceState.discoveredIds.
 *    - Each scan processes a rotating window of `maxGamesPerScan` IDs
 *      (default 500), advancing sourceState.scanOffset.
 *    - Prices fetched from GG.deals API: 100 IDs/request, 62 s delay
 *      between batches to stay within 100 records/minute rate limit.
 *
 * 2. PS5 / Xbox / Switch (via GG.deals deal-page scraping)
 *    - Scrapes https://gg.deals/deals/?platform={p}&region=se&page={n}
 *      via FlareSolverr (FLARESOLVERR_URL env var).
 *    - `dealsPageCount` pages per platform (default 5, ~250 deals each).
 *    - No API key required for this path.
 *
 * Configure in config/sources.json:
 * {
 *   "id": "gg-deals-games",
 *   "type": "gg-deals-games",
 *   "enabled": true,
 *   "label": "GG.deals – Game Prices",
 *   "apiTokenEnvVar": "GG_DEALS_API_KEY",
 *   "region": "se",
 *   "platforms": ["steam", "ps5", "xbox-series-x"],
 *   "discoverPages": 10,
 *   "discoverIntervalHours": 168,
 *   "maxGamesPerScan": 500,
 *   "dealsPageCount": 5
 * }
 */

const GG_API_BASE = 'https://api.gg.deals/v1/prices/by-steam-app-id/';
const STEAMSPY_API = 'https://steamspy.com/api.php?request=all&page=';
const GG_DEALS_BASE = 'https://gg.deals';
const STEAM_THUMBNAIL = (appId) =>
  `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`;

const API_BATCH_SIZE = 100;
const API_BATCH_DELAY_MS = 62_000; // keep within 100 records/min

const PLATFORM_CATEGORY = {
  steam: 'pc-games',
  ps5: 'ps5-games',
  'xbox-series-x': 'xbox-games',
  'xbox-one': 'xbox-games',
  switch: 'switch-games',
};

const PLATFORM_LABEL = {
  steam: 'PC / Steam',
  ps5: 'PS5',
  'xbox-series-x': 'Xbox',
  'xbox-one': 'Xbox One',
  switch: 'Switch',
};

// ---------------------------------------------------------------------------
// Steam: SteamSpy auto-discovery
// ---------------------------------------------------------------------------

async function discoverSteamIds(pages = 10) {
  const ids = [];
  for (let page = 0; page < pages; page++) {
    if (page > 0) await sleep(1200);
    const res = await fetch(`${STEAMSPY_API}${page}`, {
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`SteamSpy HTTP ${res.status} on page ${page}`);
    const data = await res.json();
    for (const appid of Object.keys(data)) {
      const n = Number(appid);
      if (n > 0) ids.push(n);
    }
    console.log(`[gg-deals] SteamSpy page ${page}: ${Object.keys(data).length} games`);
  }
  console.log(`[gg-deals] SteamSpy discovery complete: ${ids.length} Steam IDs`);
  return ids;
}

// ---------------------------------------------------------------------------
// GG.deals API: batch price lookup for Steam App IDs
// ---------------------------------------------------------------------------

async function ggApiRequest(ids, apiKey, region) {
  const url =
    `${GG_API_BASE}?ids=${encodeURIComponent(ids.join(','))}` +
    `&key=${encodeURIComponent(apiKey)}&region=${encodeURIComponent(region)}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/json' },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`GG.deals API auth error (${res.status}) — check your API key.`);
  }
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`GG.deals rate limit hit: ${body?.data?.message ?? 'Too Many Requests'}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GG.deals API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data?.success) {
    throw new Error(`GG.deals API error: ${data?.data?.message ?? JSON.stringify(data).slice(0, 200)}`);
  }
  return data.data ?? {};
}

function mapSteamGame(appId, entry, source, now) {
  const title = String(entry.title ?? '').trim();
  if (!title) return null;

  const prices = entry.prices ?? {};
  const currentRetail = prices.currentRetail != null ? Number(prices.currentRetail) : null;
  if (currentRetail == null) return null; // not on sale

  const historicalRetail =
    prices.historicalRetail != null ? Math.round(Number(prices.historicalRetail)) : null;
  const currentKeyshops =
    prices.currentKeyshops != null ? Math.round(Number(prices.currentKeyshops)) : null;
  const historicalKeyshops =
    prices.historicalKeyshops != null ? Math.round(Number(prices.historicalKeyshops)) : null;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId: `steam:${appId}`,
    title,
    url: entry.url ?? `https://gg.deals/game/steam/${appId}/`,
    productKey: normalizeProductIdentity(title),
    priceSek: Math.round(currentRetail),
    referencePriceSek: historicalRetail,
    marketValueSek: historicalRetail,
    imageUrl: STEAM_THUMBNAIL(appId),
    category: PLATFORM_CATEGORY.steam,
    condition: 'digital',
    conditionLabel: PLATFORM_LABEL.steam,
    availability: 'in_stock',
    keyshopPriceSek: currentKeyshops,
    historicalKeyshopPriceSek: historicalKeyshops,
    currency: prices.currency ?? 'SEK',
    steamAppId: String(appId),
    seenAt: now,
  };
}

async function collectSteamGames({ source, sourceState, apiKey, region, now }) {
  const discoverPages = source.discoverPages ?? 10;
  const discoverIntervalMs = (source.discoverIntervalHours ?? 168) * 3_600_000;
  const maxGamesPerScan = source.maxGamesPerScan ?? 500;

  const needsRefresh =
    !sourceState.discoveredIds?.length ||
    !sourceState.idsDiscoveredAt ||
    Date.now() - Date.parse(sourceState.idsDiscoveredAt) > discoverIntervalMs;

  if (needsRefresh) {
    console.log('[gg-deals] Refreshing Steam game list via SteamSpy…');
    sourceState.discoveredIds = await discoverSteamIds(discoverPages);
    sourceState.idsDiscoveredAt = new Date().toISOString();
    sourceState.scanOffset = 0;
  }

  const allIds = sourceState.discoveredIds;
  const offset = sourceState.scanOffset ?? 0;
  const batchIds = allIds.slice(offset, offset + maxGamesPerScan);
  const nextOffset = offset + batchIds.length >= allIds.length ? 0 : offset + batchIds.length;
  sourceState.scanOffset = nextOffset;

  console.log(
    `[gg-deals] Steam: processing IDs [${offset}…${offset + batchIds.length - 1}] / ${allIds.length} (next offset: ${nextOffset})`
  );

  const observations = [];
  for (let i = 0; i < batchIds.length; i += API_BATCH_SIZE) {
    const chunk = batchIds.slice(i, i + API_BATCH_SIZE);
    if (i > 0) {
      console.log(`[gg-deals] Rate-limit pause before batch ${i / API_BATCH_SIZE + 1} (${API_BATCH_DELAY_MS / 1000}s)…`);
      await sleep(API_BATCH_DELAY_MS);
    }
    const gameData = await ggApiRequest(chunk, apiKey, region);
    let hits = 0;
    for (const appId of chunk) {
      const entry = gameData[String(appId)];
      if (!entry) continue;
      const obs = mapSteamGame(appId, entry, source, now);
      if (obs) { observations.push(obs); hits++; }
    }
    console.log(`[gg-deals] API batch ${i / API_BATCH_SIZE + 1}: ${chunk.length} IDs → ${hits} priced`);
  }

  return observations;
}

// ---------------------------------------------------------------------------
// PS5 / Xbox / Switch: scrape GG.deals deal pages via FlareSolverr
// ---------------------------------------------------------------------------

async function scrapeViaFlaresolverr(url, flareSolverrUrl) {
  const res = await fetch(`${flareSolverrUrl}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60_000 }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`FlareSolverr HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'ok') throw new Error(`FlareSolverr error: ${json.message ?? json.status}`);
  return json.solution?.response ?? '';
}

/** Parse Swedish price strings: "259,00 kr", "1 099 kr", "Free" → number or null */
function parseSePrice(text) {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  if (t === 'free' || t === 'gratis') return 0;
  // Remove currency symbol, thousands spaces, then swap decimal comma
  const cleaned = t.replace(/\s/g, '').replace(/[a-z]+/g, '').replace(',', '.');
  const val = parseFloat(cleaned);
  return Number.isFinite(val) ? Math.round(val) : null;
}

function parseDealPage(html, platform, source, now) {
  const observations = [];

  // Walk through game-list-item containers using regex (no DOM dep needed)
  const cardRe = /<li[^>]*class="[^"]*game-list-item[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const card = m[0];

    const gameId = (card.match(/data-container-game-id="([^"]+)"/) ?? [])[1];
    const title = (card.match(/data-game-title="([^"]+)"/) ?? [])[1];
    const gameSlug = (card.match(/data-game-name="([^"]+)"/) ?? [])[1];

    if (!gameId || !title) continue;

    // Current price: <span class="price price-hl">...</span>  or  <span class="price">...</span>
    const priceMatch = card.match(/<span[^>]*class="[^"]*\bprice\b[^"]*"[^>]*>([^<]+)<\/span>/);
    const priceText = priceMatch?.[1];
    const priceSek = parseSePrice(priceText);
    if (priceSek == null) continue;

    // Base/original price
    const baseMatch = card.match(/<span[^>]*class="[^"]*\bbase-price\b[^"]*"[^>]*>([^<]+)<\/span>/);
    const referencePriceSek = parseSePrice(baseMatch?.[1]);

    // Best image src in the card
    const imgMatch = card.match(/<img[^>]+src="(https:\/\/img\.gg\.deals\/[^"]+)"/);
    const imageUrl = imgMatch?.[1] ?? null;

    const gameUrl = gameSlug
      ? `https://gg.deals/game/${gameSlug}/`
      : `https://gg.deals/se/deals/?platform=${platform}`;

    observations.push({
      sourceId: source.id,
      sourceLabel: source.label ?? source.id,
      sourceType: source.type,
      externalId: `${platform}:${gameId}`,
      title: decodeHtmlEntities(title),
      url: gameUrl,
      productKey: normalizeProductIdentity(title),
      priceSek,
      referencePriceSek,
      marketValueSek: referencePriceSek,
      imageUrl,
      category: PLATFORM_CATEGORY[platform] ?? 'games',
      condition: 'digital',
      conditionLabel: PLATFORM_LABEL[platform] ?? platform,
      availability: 'in_stock',
      currency: 'SEK',
      steamAppId: null,
      seenAt: now,
    });
  }

  return observations;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

async function collectDealPages({ source, platforms, now }) {
  const flareSolverrUrl =
    (process.env.FLARESOLVERR_URL ?? '').replace(/\/$/, '').trim();
  if (!flareSolverrUrl) {
    throw new Error(
      `FLARESOLVERR_URL env var is required for non-Steam platforms (${platforms.join(', ')}). ` +
        'Set it to your FlareSolverr service URL.'
    );
  }

  const region = source.region ?? 'se';
  const dealsPageCount = source.dealsPageCount ?? 5;
  const pageDelayMs = source.pageDelayMs ?? 3000;
  const observations = [];

  for (const platform of platforms) {
    let platformTotal = 0;
    for (let page = 1; page <= dealsPageCount; page++) {
      const url = `${GG_DEALS_BASE}/deals/?platform=${platform}&region=${region}&page=${page}`;
      console.log(`[gg-deals] Scraping ${platform} page ${page}: ${url}`);
      const html = await scrapeViaFlaresolverr(url, flareSolverrUrl);
      const pageObs = parseDealPage(html, platform, source, now);
      console.log(`[gg-deals] ${platform} page ${page}: ${pageObs.length} deals`);
      observations.push(...pageObs);
      platformTotal += pageObs.length;
      if (pageObs.length === 0) break; // no more pages
      if (page < dealsPageCount) await sleep(pageDelayMs);
    }
    console.log(`[gg-deals] ${platform} total: ${platformTotal} deals`);
  }

  return observations;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function collectFromGgDeals({ source, sourceState, now }) {
  const platforms = Array.isArray(source.platforms) ? source.platforms : ['steam'];
  const region = String(source.region ?? 'se').toLowerCase();

  const apiKey =
    (source.apiTokenEnvVar ? process.env[source.apiTokenEnvVar] : null)?.trim() ||
    process.env.GG_DEALS_API_KEY?.trim() ||
    '';

  const results = [];

  if (platforms.includes('steam')) {
    if (!apiKey) {
      throw new Error(
        `GG.deals API key not set for source "${source.id}". ` +
          `Generate a key at https://gg.deals/settings/ and set ${source.apiTokenEnvVar ?? 'GG_DEALS_API_KEY'}.`
      );
    }
    const steamObs = await collectSteamGames({ source, sourceState, apiKey, region, now });
    console.log(`[gg-deals] Steam: ${steamObs.length} priced games in this scan`);
    results.push(...steamObs);
  }

  const webPlatforms = platforms.filter((p) => p !== 'steam');
  if (webPlatforms.length > 0) {
    const webObs = await collectDealPages({ source, platforms: webPlatforms, now });
    results.push(...webObs);
  }

  console.log(`[gg-deals] Scan complete: ${results.length} total observations`);
  return results;
}
