import { normalizeProductIdentity, sleep } from '../lib/utils.js';

/**
 * GG.deals Prices API source.
 *
 * Tracks digital game prices for a configured list of Steam App IDs.
 * Requires a GG.deals API key (generate at https://gg.deals/settings/).
 * Set the GG_DEALS_API_KEY environment variable (or source.apiTokenEnvVar).
 *
 * API: GET https://api.gg.deals/v1/prices/by-steam-app-id/
 *   ?ids=<comma-separated Steam App IDs, max 100>
 *   &key=<API key>
 *   &region=<region code>   (default: us; use "se" for SEK prices)
 *
 * Rate limits (free tier): 100 records/minute, 1000 records/hour.
 * We respect these by sleeping 62 seconds between batches when > 1 batch needed.
 *
 * Observation fields:
 *   priceSek            = currentRetail (lowest official store price)
 *   referencePriceSek   = historicalRetail (all-time low — used for deal scoring)
 *   marketValueSek      = historicalRetail
 *   extras.keyshopPrice = currentKeyshops (grey-market key price, for info only)
 *   extras.historicalKeyshopPrice = historicalKeyshops
 *
 * Steam CDN thumbnails (400×186): https://cdn.akamai.steamstatic.com/steam/apps/{id}/header.jpg
 *
 * Configure in config/sources.json:
 * {
 *   "id": "gg-deals-games",
 *   "type": "gg-deals-games",
 *   "enabled": true,
 *   "label": "GG.deals – Game Prices",
 *   "apiTokenEnvVar": "GG_DEALS_API_KEY",
 *   "region": "se",
 *   "steamAppIds": [1091500, 1086940, 1245620, ...]
 * }
 */

const API_BASE = 'https://api.gg.deals/v1/prices/by-steam-app-id/';
const STEAM_THUMBNAIL = (appId) => `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`;
const BATCH_SIZE = 100;
// Pause between batches to stay within 100 records/minute rate limit.
const BATCH_DELAY_MS = 62_000;

function mapGame(appId, data, source, now) {
  const title = String(data.title ?? '').trim();
  if (!title) return null;

  const prices = data.prices ?? {};
  const currentRetail = prices.currentRetail != null ? Number(prices.currentRetail) : null;
  const historicalRetail = prices.historicalRetail != null ? Number(prices.historicalRetail) : null;
  const currentKeyshops = prices.currentKeyshops != null ? Number(prices.currentKeyshops) : null;
  const historicalKeyshops = prices.historicalKeyshops != null ? Number(prices.historicalKeyshops) : null;

  // Skip games with no current price — not on sale right now.
  if (currentRetail == null) return null;

  const url = data.url ?? `https://gg.deals/game/steam/${appId}/`;
  const priceSek = Math.round(currentRetail);
  const refPriceSek = historicalRetail != null ? Math.round(historicalRetail) : null;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId: String(appId),
    title,
    url,
    productKey: normalizeProductIdentity(title),
    priceSek,
    referencePriceSek: refPriceSek,
    marketValueSek: refPriceSek,
    imageUrl: STEAM_THUMBNAIL(appId),
    category: 'games',
    condition: 'digital',
    conditionLabel: 'Digital',
    availability: 'in_stock',
    // Extra pricing context exposed to the deal engine and UI.
    keyshopPriceSek: currentKeyshops != null ? Math.round(currentKeyshops) : null,
    historicalKeyshopPriceSek: historicalKeyshops != null ? Math.round(historicalKeyshops) : null,
    currency: prices.currency ?? 'USD',
    steamAppId: String(appId),
    seenAt: now,
  };
}

export async function collectFromGgDeals({ source, now }) {
  const apiKey =
    (source.apiTokenEnvVar ? process.env[source.apiTokenEnvVar] : null)?.trim() ||
    process.env.GG_DEALS_API_KEY?.trim() ||
    '';

  if (!apiKey) {
    throw new Error(
      `GG.deals API key not set for source "${source.id}". ` +
        `Generate a key at https://gg.deals/settings/ and set ${source.apiTokenEnvVar ?? 'GG_DEALS_API_KEY'}.`
    );
  }

  const rawIds = Array.isArray(source.steamAppIds) ? source.steamAppIds.map(Number).filter(Boolean) : [];
  if (rawIds.length === 0) {
    throw new Error(`Source "${source.id}" has no steamAppIds configured.`);
  }

  const region = String(source.region ?? 'se').toLowerCase();
  const observations = [];
  let totalFetched = 0;

  // Split into batches of 100 (API limit).
  for (let offset = 0; offset < rawIds.length; offset += BATCH_SIZE) {
    const batch = rawIds.slice(offset, offset + BATCH_SIZE);
    const idsParam = batch.join(',');

    if (offset > 0) {
      console.log(`[gg-deals] Rate-limit pause before next batch (${BATCH_DELAY_MS / 1000}s)…`);
      await sleep(BATCH_DELAY_MS);
    }

    const url = `${API_BASE}?ids=${encodeURIComponent(idsParam)}&key=${encodeURIComponent(apiKey)}&region=${encodeURIComponent(region)}`;

    let data;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/json' },
      });

      // Surface rate-limit and auth errors clearly.
      if (response.status === 401 || response.status === 403) {
        throw new Error(`GG.deals API auth error (${response.status}) — check your API key.`);
      }
      if (response.status === 429) {
        const body = await response.json().catch(() => ({}));
        throw new Error(`GG.deals rate limit hit: ${body?.data?.message ?? 'Too Many Requests'}. Try reducing steamAppIds or increasing scanIntervalMinutes.`);
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`GG.deals API HTTP ${response.status}: ${body.slice(0, 200)}`);
      }

      data = await response.json();
    } catch (err) {
      if (err.message.startsWith('GG.deals')) throw err;
      throw new Error(`GG.deals API request failed: ${err.message}`);
    }

    if (!data?.success) {
      const msg = data?.data?.message ?? JSON.stringify(data).slice(0, 200);
      throw new Error(`GG.deals API error: ${msg}`);
    }

    const gameData = data.data ?? {};
    let batchHits = 0;

    for (const appId of batch) {
      const entry = gameData[String(appId)];
      if (!entry) continue; // Not found in GG.deals database

      const obs = mapGame(appId, entry, source, now);
      if (obs) {
        observations.push(obs);
        batchHits += 1;
      }
    }

    totalFetched += batch.length;
    console.log(`[gg-deals] Batch ${offset / BATCH_SIZE + 1}: ${batch.length} requested, ${batchHits} with active prices (region=${region})`);
  }

  console.log(`[gg-deals] Total: ${observations.length} games with prices out of ${totalFetched} requested`);
  return observations;
}
