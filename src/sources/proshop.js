import { load } from 'cheerio';
import { normalizeProductIdentity, parseSekValue, sleep } from '../lib/utils.js';

/**
 * ProShop Outlet + Demo scraper.
 *
 * ProShop is behind Cloudflare Bot Management (cType: 'managed'). All direct
 * browser approaches fail. Two managed-scraping options are supported:
 *
 * Option A — ScraperAPI (recommended, free tier):
 *   Sign up free at scraperapi.com → 5000 credits/month.
 *   render=true costs 5 credits/page → ~1000 pages free/month (~10 full scans).
 *   Set SCRAPERAPI_KEY env var in Railway.
 *
 * Option B — Scrapfly (fallback, if SCRAPFLY_API_KEY is set):
 *   asp + render_js = ~10 credits per page. Free tier: 1000 credits/month.
 *   Sign up at scrapfly.io.
 *
 * URL format (discovered empirically):
 *   Page 1: /Outlet            Page N: /Outlet?pn=N
 *   Demo:   /Demoprodukter     Demo N: /Demoprodukter?pn=N
 *   Outlet: ~39 pages, Demo: ~60 pages (25 items/page; pagesize param ignored).
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

    const imgEl = $(el).find('img').first();
    let imageUrl =
      imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || imgEl.attr('src') || '';
    if (imageUrl && !imageUrl.startsWith('http') && !imageUrl.startsWith('data:')) {
      imageUrl = 'https://www.proshop.se' + (imageUrl.startsWith('/') ? '' : '/') + imageUrl;
    }

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
      imageUrl: imageUrl || null,
      category: category || 'outlet',
      condition: 'outlet',
      conditionLabel: 'Outlet',
      availability: 'in_stock',
      seenAt: now,
    });
  });

  return observations;
}

async function scrapeViaScraperApi(url, apiKey, premium) {
  const apiUrl = buildScraperApiUrl(url, apiKey, premium);
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ScraperAPI HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  // ScraperAPI returns the scraped HTML directly
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

export async function collectFromProshop({ source, sourceState, now }) {
  // Prefer ScraperAPI (free: 5000 credits/month, 5 credits/page with render=true).
  // Fall back to Scrapfly if only that key is configured.
  const scraperApiKey =
    (source.apiTokenEnvVar === 'SCRAPERAPI_KEY' ? process.env.SCRAPERAPI_KEY : null)?.trim() ||
    process.env.SCRAPERAPI_KEY?.trim() ||
    '';
  const scrapflyKey =
    (source.apiTokenEnvVar === 'SCRAPFLY_API_KEY' ? process.env.SCRAPFLY_API_KEY : null)?.trim() ||
    process.env.SCRAPFLY_API_KEY?.trim() ||
    '';

  const useScraperApi = Boolean(scraperApiKey);
  const useScrapfly = !useScraperApi && Boolean(scrapflyKey);

  if (!useScraperApi && !useScrapfly) {
    throw new Error(
      `No scraping API key for ${source.label ?? source.id}. ` +
        `Set SCRAPERAPI_KEY (free at scraperapi.com, 5000 credits/month) ` +
        `or SCRAPFLY_API_KEY (free at scrapfly.io, 1000 credits/month).`
    );
  }

  const pageDelayMs = source.pageDelayMs ?? 1500;
  const premium = source.premiumProxy === true;
  const renderJs = source.renderJs !== false;

  const sections = [
    { path: '/Outlet', maxPages: source.maxOutletPages ?? 40 },
    { path: '/Demoprodukter', maxPages: source.maxDemoPages ?? 65 },
  ];

  const seen = new Set();
  const observations = [];

  for (const { path, maxPages } of sections) {
    for (let page = 1; page <= maxPages; page++) {
      const url =
        page === 1 ? `${BASE_URL}${path}` : `${BASE_URL}${path}?pn=${page}`;

      let html;
      try {
        html = useScraperApi
          ? await scrapeViaScraperApi(url, scraperApiKey, premium)
          : await scrapeViaScrapfly(url, scrapflyKey, renderJs);
      } catch (err) {
        console.warn(`[proshop] ${path} page ${page} failed: ${err.message}`);
        break;
      }

      const pageObservations = parseProshopPage(html, source, now, seen);
      observations.push(...pageObservations);
      console.log(`[proshop] ${path} page ${page}: ${pageObservations.length} products`);

      if (pageObservations.length === 0) break;

      if (page < maxPages) await sleep(pageDelayMs);
    }
  }

  sourceState.lastDiscoveryCount = observations.length;
  console.log(`[proshop] Total: ${observations.length} products`);
  return observations;
}
