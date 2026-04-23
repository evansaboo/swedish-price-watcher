import { load } from 'cheerio';
import { normalizeProductIdentity, parseSekValue, sleep } from '../lib/utils.js';

/**
 * ProShop Outlet + Demo scraper.
 *
 * ProShop is behind Cloudflare Bot Management. Three bypass strategies are supported.
 * FlareSolverr is preferred (free, self-hosted); paid services are fallbacks.
 *
 * Option A — FlareSolverr (FLARESOLVERR_URL) — preferred, free:
 *   Self-hosted real-Chromium bypass. Zero per-request cost.
 *   Deploy ghcr.io/flaresolverr/flaresolverr:latest on Railway.
 *   Set FLARESOLVERR_URL=http://flaresolverr.railway.internal:8080
 *
 * Option B — ScraperAPI (SCRAPERAPI_KEY) — fallback:
 *   5000 free credits/month. render=true = 5 credits/page → ~1000 pages free.
 *   With incremental scanning + 4h interval this fits easily in the free tier.
 *
 * Option C — Scrapfly (SCRAPFLY_API_KEY) — fallback:
 *   1000 free credits/month. asp + render_js = ~10 credits/page.
 *
 * Incremental / delta scanning:
 *   sourceState.knownExternalIds is pre-populated by the scan engine with IDs already
 *   in state. After each page, if all items on that page are already known, we've
 *   "caught up" to the previous scan. Once `incrementalStopPages` (default 2)
 *   consecutive pages are fully-known, pagination stops — saving up to 97% of credits
 *   on repeat scans when the outlet inventory is mostly unchanged.
 */

const BASE_URL = 'https://www.proshop.se';

function buildScraperApiUrl(targetUrl, apiKey, premium) {
  const params = new URLSearchParams({
    api_key: apiKey,
    url: targetUrl,
    render: 'true',
    country_code: 'se',
  });
  if (premium) params.set('premium', 'true');
  return `http://api.scraperapi.com?${params}`;
}

function buildScrapflyUrl(targetUrl, apiKey, renderJs) {
  const params = new URLSearchParams({
    key: apiKey,
    url: targetUrl,
    asp: 'true',
    country: 'se',
  });
  if (renderJs) params.set('render_js', 'true');
  return `https://api.scrapfly.io/scrape?${params}`;
}

async function scrapeViaScraperApi(url, apiKey, premium) {
  const apiUrl = buildScraperApiUrl(url, apiKey, premium);
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ScraperAPI HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.text();
}

async function scrapeViaScrapfly(url, apiKey, renderJs) {
  const apiUrl = buildScrapflyUrl(url, apiKey, renderJs);
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Scrapfly HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  const result = data.result ?? data;
  if (result.status === 'ERROR' || (result.error && result.error !== null)) {
    const reason = result.error?.description ?? result.error ?? 'unknown error';
    throw new Error(`Scrapfly error: ${reason}`);
  }
  return result.content ?? '';
}

async function scrapeViaFlaresolverr(url, flareSolverrUrl) {
  const response = await fetch(`${flareSolverrUrl}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 90_000 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`FlareSolverr HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  if (data.status !== 'ok') {
    throw new Error(`FlareSolverr error: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.solution?.response ?? '';
}

function parseProshopPage(html, source, now, seen) {
  const $ = load(html);
  const observations = [];

  $('li.site-productlist-item').each((_, el) => {
    const linkEl = $(el).find('a.site-product-link, a').first();
    const href = linkEl.attr('href') || '';
    const segments = href.split('/').filter(Boolean);

    const productId = segments[segments.length - 1] || '';
    const name =
      linkEl.attr('title') ||
      linkEl.text().trim() ||
      (segments.length >= 2 ? segments[segments.length - 2].replace(/-+/g, ' ').trim() : '');
    const category = segments.length >= 1 ? segments[0].replace(/-+/g, ' ').trim() : '';

    const priceText = $(el).find('span.site-currency-lg').first().text().trim();
    const origPriceText =
      $(el).find('span.site-currency-oldprice, .site-currency-old, .oldprice, .site-currency-before').first().text().trim();

    // ProShop images are behind Cloudflare and return 403 to external requests.
    if (!name || !priceText) return;
    const price = parseSekValue(priceText);
    if (price == null) return;

    const externalId = String(productId || name).trim();
    if (!externalId || seen.has(externalId)) return;
    seen.add(externalId);

    observations.push({
      sourceId: source.id,
      sourceLabel: source.label ?? source.id,
      sourceType: source.type,
      externalId,
      title: name,
      url: href ? (href.startsWith('http') ? href : `${BASE_URL}${href}`) : null,
      productKey: normalizeProductIdentity(name),
      priceSek: price,
      referencePriceSek: parseSekValue(origPriceText) || null,
      marketValueSek: parseSekValue(origPriceText) || null,
      imageUrl: null,
      category: category || 'outlet',
      condition: 'outlet',
      conditionLabel: 'Outlet',
      availability: 'in_stock',
      seenAt: now,
    });
  });

  return observations;
}

export async function collectFromProshop({ source, sourceState, now }) {
  // Priority: FlareSolverr (free, self-hosted) → ScraperAPI → Scrapfly
  // FlareSolverr is preferred when configured — it has zero per-request cost.
  // Paid services act as fallbacks for when FlareSolverr is unavailable.
  const flareSolverrUrl = process.env.FLARESOLVERR_URL?.trim() || '';
  const scraperApiKey =
    (source.apiTokenEnvVar === 'SCRAPERAPI_KEY' ? process.env.SCRAPERAPI_KEY : null)?.trim() ||
    process.env.SCRAPERAPI_KEY?.trim() ||
    '';
  const scrapflyKey =
    (source.apiTokenEnvVar === 'SCRAPFLY_API_KEY' ? process.env.SCRAPFLY_API_KEY : null)?.trim() ||
    process.env.SCRAPFLY_API_KEY?.trim() ||
    '';

  const useFlaresolverr = Boolean(flareSolverrUrl);
  const useScraperApi = !useFlaresolverr && Boolean(scraperApiKey);
  const useScrapfly = !useFlaresolverr && !useScraperApi && Boolean(scrapflyKey);

  if (!useScraperApi && !useScrapfly && !useFlaresolverr) {
    throw new Error(
      `No scraping backend for ${source.label ?? source.id}. ` +
        `Set one of: SCRAPERAPI_KEY (scraperapi.com, 5000 free credits/mo), ` +
        `SCRAPFLY_API_KEY (scrapfly.io, 1000 free credits/mo), ` +
        `or FLARESOLVERR_URL (self-hosted, free — deploy ghcr.io/flaresolverr/flaresolverr:latest).`
    );
  }

  const pageDelayMs = source.pageDelayMs ?? 1500;
  const premium = source.premiumProxy === true;
  const renderJs = source.renderJs !== false;
  // How many consecutive all-known pages before stopping (incremental mode).
  const incrementalStopPages = source.incrementalStopPages ?? 2;

  // Known IDs from the previous scan — used for incremental/delta pagination.
  const knownIds = sourceState.knownExternalIds instanceof Set
    ? sourceState.knownExternalIds
    : new Set();

  const backendLabel = useScraperApi ? 'ScraperAPI' : useScrapfly ? 'Scrapfly' : 'FlareSolverr';
  console.log(`[proshop] Using ${backendLabel}; known IDs: ${knownIds.size}`);

  const sections = [
    { path: '/Outlet', maxPages: source.maxOutletPages ?? 40 },
    { path: '/Demoprodukter', maxPages: source.maxDemoPages ?? 65 },
  ];

  const seen = new Set();
  const observations = [];

  for (const { path, maxPages } of sections) {
    let consecutiveKnownPages = 0;

    for (let page = 1; page <= maxPages; page++) {
      const url =
        page === 1 ? `${BASE_URL}${path}` : `${BASE_URL}${path}?pn=${page}`;

      let html;
      try {
        if (useScraperApi) html = await scrapeViaScraperApi(url, scraperApiKey, premium);
        else if (useScrapfly) html = await scrapeViaScrapfly(url, scrapflyKey, renderJs);
        else html = await scrapeViaFlaresolverr(url, flareSolverrUrl);
      } catch (err) {
        console.warn(`[proshop] ${path} page ${page} failed: ${err.message}`);
        break;
      }

      const pageObservations = parseProshopPage(html, source, now, seen);
      observations.push(...pageObservations);

      // Count items that are genuinely new (not seen in previous scan).
      const newOnPage = pageObservations.filter((o) => !knownIds.has(o.externalId)).length;
      console.log(`[proshop] ${path} page ${page}: ${pageObservations.length} items, ${newOnPage} new`);

      if (pageObservations.length === 0) break; // Page is empty — end of listing

      // Incremental stop: if the entire page consists of already-known items,
      // we've caught up to where the previous scan left off.
      if (knownIds.size > 0 && newOnPage === 0) {
        consecutiveKnownPages += 1;
        if (consecutiveKnownPages >= incrementalStopPages) {
          console.log(`[proshop] ${path}: ${consecutiveKnownPages} consecutive fully-known pages — stopping early (incremental mode)`);
          break;
        }
      } else {
        consecutiveKnownPages = 0;
      }

      if (page < maxPages) await sleep(pageDelayMs);
    }
  }

  sourceState.lastDiscoveryCount = observations.length;
  console.log(`[proshop] Total: ${observations.length} products`);
  return observations;
}
