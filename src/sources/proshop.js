import { load } from 'cheerio';
import { normalizeProductIdentity, parseSekValue, sleep } from '../lib/utils.js';

/**
 * ProShop Outlet + Demo scraper via Scrapfly API.
 *
 * ProShop is behind Cloudflare Bot Management (cType: 'managed'). All browser-
 * based approaches (rebrowser-playwright, Apify playwright-scraper + residential
 * proxy) fail because CF fingerprints the browser context and returns
 * ERR_TUNNEL_CONNECTION_FAILED or 60s navigation timeouts.
 *
 * Scrapfly's Anti Scraping Protection (asp=true) bypasses CF at the infrastructure
 * level without running a browser on our side. Set SCRAPFLY_API_KEY in Railway.
 *
 * Sign up: https://scrapfly.io (free tier: 1000 credits/month)
 * asp + render_js = ~10 credits per page
 */

const BASE_URL = 'https://www.proshop.se';
const PAGE_SIZE = 48;
const SCRAPFLY_API = 'https://api.scrapfly.io/scrape';

function buildScrapflyUrl(targetUrl, apiKey, renderJs) {
  const params = new URLSearchParams({
    key: apiKey,
    url: targetUrl,
    asp: 'true',
    country: 'se',
  });
  if (renderJs) params.set('render_js', 'true');
  return `${SCRAPFLY_API}?${params}`;
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

async function scrapePage(url, apiKey, renderJs) {
  const apiUrl = buildScrapflyUrl(url, apiKey, renderJs);
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(60_000) });

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
  const apiKey =
    process.env[source.apiTokenEnvVar ?? 'SCRAPFLY_API_KEY']?.trim() ??
    process.env.SCRAPFLY_API_KEY?.trim() ??
    '';
  if (!apiKey) {
    throw new Error(`No Scrapfly API key configured for ${source.label ?? source.id}. Set SCRAPFLY_API_KEY env var. Sign up at https://scrapfly.io`);
  }

  const renderJs = source.renderJs !== false;
  const pageDelayMs = source.pageDelayMs ?? 1000;

  // Outlet: up to 39 pages. Demo: up to 60 pages (25 items/page, no pagesize param).
  // URL format: page 1 = /Section, page N = /Section?pn=N
  const sections = [
    { path: '/Outlet', maxPages: source.maxOutletPages ?? 40 },
    { path: '/Demoprodukter', maxPages: source.maxDemoPages ?? 65 },
  ];

  const seen = new Set();
  const observations = [];

  for (const { path, maxPages } of sections) {
    for (let page = 1; page <= maxPages; page++) {
      const url = page === 1
        ? `${BASE_URL}${path}`
        : `${BASE_URL}${path}?pn=${page}`;

      let html;
      try {
        html = await scrapePage(url, apiKey, renderJs);
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
