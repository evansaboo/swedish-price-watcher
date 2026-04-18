import { ApifyClient } from 'apify-client';
import { parseSekValue } from '../lib/utils.js';

/**
 * The pageFunction executed inside Apify's cheerio-scraper actor.
 * Runs on Apify infrastructure (bypasses Cloudflare) and extracts products
 * from ProShop outlet listing pages.
 */
const CHEERIO_PAGE_FUNCTION = /* js */ `
async function pageFunction(context) {
  const { $, request } = context;
  const products = [];

  // Correct class: site-productlist-item
  $('li.site-productlist-item').each((i, el) => {
    const $el = $(el);
    const linkEl = $el.find('a.site-product-link').first();
    const href = linkEl.attr('href') || $el.find('a').first().attr('href') || '';

    // Clean name from href path: /Category-Name/Product-Name/12345 → second-to-last segment
    const segments = href.split('/').filter(Boolean);
    const nameFromHref = segments.length >= 2
      ? segments[segments.length - 2].replace(/-+/g, ' ').trim()
      : '';
    const name = nameFromHref || (linkEl.attr('title') || '').split(' - ')[0].trim();

    // Product ID: last segment of href (numeric)
    const productId = segments[segments.length - 1] || '';

    // Category: first path segment (URL-encoded Swedish, keep as-is)
    const category = segments.length >= 1 ? segments[0].replace(/-+/g, ' ').trim() : '';

    // Price from span.site-currency-lg (main price)
    const priceText = $el.find('span.site-currency-lg').first().text().trim();

    // Old/original price
    const originalPriceText =
      $el.find('span.site-currency-oldprice, .site-currency-old, .oldprice').first().text().trim();

    if (name && priceText) {
      products.push({ name, href, priceText, originalPriceText, productId: productId || name, category });
    }
  });

  if (products.length > 0) {
    return products;
  }

  // Fallback: try JSON-LD with @type: Product
  const jsonLdProducts = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const data = JSON.parse($(el).html());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'Product' && item.name) {
          jsonLdProducts.push({
            name: item.name,
            href: item.url || '',
            priceText: String(item.offers?.price ?? ''),
            originalPriceText: '',
            productId: String(item.productID || item.sku || ''),
            category: item.category || '',
            _source: 'jsonld',
          });
        }
      }
    } catch {}
  });

  if (jsonLdProducts.length > 0) {
    return jsonLdProducts;
  }

  // Nothing found — return debug info so we can diagnose
  return [{ _debug: true, url: request.url, bodySnippet: context.body.substring(0, 3000) }];
}
`;

function mapProshopItem(item, source, now) {
  if (item._debug) return null;

  const { name, href, priceText, originalPriceText, productId, category } = item;
  if (!name || !priceText) return null;

  const price = parseSekValue(priceText);
  if (price == null) return null;

  const originalPrice = parseSekValue(originalPriceText) || null;
  const fullUrl = href
    ? href.startsWith('http')
      ? href
      : `https://www.proshop.se${href}`
    : null;

  const externalId = String(productId || name).trim();
  if (!externalId) return null;

  return {
    sourceId: source.id,
    externalId,
    title: name,
    url: fullUrl,
    currentPriceSek: price,
    comparisonPriceSek: originalPrice,
    referencePriceSek: originalPrice,
    marketValueSek: originalPrice,
    imageUrl: null,
    category: category || 'outlet',
    condition: 'outlet',
    scannedAt: now,
  };
}

/**
 * Collect ProShop outlet products via Apify's cheerio-scraper actor.
 *
 * ProShop is Cloudflare-protected so direct fetch fails from Railway.
 * The actor runs on Apify infrastructure with rotating proxies, bypassing CF.
 */
export async function collectFromProshop({ source, fetcher, sourceState, now, _ApifyClient }) {
  const maxPages = Number.isFinite(source.maxPages) ? source.maxPages : 10;
  const baseUrl = 'https://www.proshop.se/Outlet';

  const token = _ApifyClient
    ? 'stub'
    : (process.env[source.apiTokenEnvVar ?? 'APIFY_TOKEN']?.trim() ?? process.env.APIFY_TOKEN?.trim() ?? '');
  if (!token) throw new Error(`No Apify token configured for ${source.label ?? source.id}.`);

  const startUrls = [];
  for (let page = 1; page <= maxPages; page++) {
    startUrls.push({ url: `${baseUrl}?sortby=0&pagesize=30&page=${page}` });
  }

  const ClientClass = _ApifyClient ?? ApifyClient;
  const client = new ClientClass({ token });

  const run = await client.actor('apify/cheerio-scraper').call(
    {
      startUrls,
      pageFunction: CHEERIO_PAGE_FUNCTION,
      proxyConfiguration: { useApifyProxy: true },
      maxRequestsPerCrawl: maxPages + 2,
    },
    { timeout: Math.floor((source.actorTimeoutMs ?? 240_000) / 1000) }
  );

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  // Log debug items and skip them
  const debugItems = items.filter((it) => it._debug);
  if (debugItems.length > 0) {
    console.warn(`[proshop] ${debugItems.length} debug item(s) — selectors may need updating.`);
    for (const d of debugItems) {
      console.warn(`[proshop] debug url=${d.url} snippet=`, d.bodySnippet?.substring(0, 500));
    }
  }

  // Deduplicate by externalId
  const seen = new Set();
  const observations = [];

  for (const item of items) {
    if (item._debug) continue;
    const obs = mapProshopItem(item, source, now);
    if (!obs) continue;
    if (seen.has(obs.externalId)) continue;
    seen.add(obs.externalId);
    observations.push(obs);
  }

  sourceState.lastDiscoveryCount = observations.length;
  return observations;
}
