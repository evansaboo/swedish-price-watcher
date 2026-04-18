import { ApifyClient } from 'apify-client';
import { parseSekValue } from '../lib/utils.js';

/**
 * The pageFunction executed inside Apify's playwright-scraper actor.
 * Runs in a real Chromium browser (bypasses Cloudflare JS challenges).
 * Extracts products from ProShop outlet/demo listing pages and enqueues
 * the next page dynamically, stopping naturally when a page is empty.
 */
const PLAYWRIGHT_PAGE_FUNCTION = /* js */ `
async function pageFunction(context) {
  const { page, request, enqueueRequest } = context;

  // Wait for product grid to render
  await page.waitForSelector('li.site-productlist-item', { timeout: 15000 }).catch(() => {});

  const products = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('li.site-productlist-item')).map(el => {
      const linkEl = el.querySelector('a.site-product-link') || el.querySelector('a');
      const href = linkEl?.getAttribute('href') || '';
      const segments = href.split('/').filter(Boolean);
      // URL shape: /Category-Name/Product-Name/12345
      const name = segments.length >= 2
        ? segments[segments.length - 2].replace(/-+/g, ' ').trim()
        : '';
      const productId = segments[segments.length - 1] || '';
      const category = segments.length >= 1 ? segments[0].replace(/-+/g, ' ').trim() : '';
      const priceText = el.querySelector('span.site-currency-lg')?.textContent?.trim() || '';
      const origPriceText = el.querySelector('span.site-currency-oldprice, .site-currency-old, .oldprice')?.textContent?.trim() || '';
      const imageUrl = el.querySelector('img')?.src || '';
      if (!name || !priceText) return null;
      return { name, href, priceText, origPriceText, productId: productId || name, category, imageUrl };
    }).filter(Boolean);
  });

  if (products.length > 0) {
    const urlObj = new URL(request.url);
    const currentPage = parseInt(urlObj.searchParams.get('page') || '1', 10);
    urlObj.searchParams.set('page', String(currentPage + 1));
    await enqueueRequest({ url: urlObj.href });
    return products;
  }

  // Empty page = past last page, stop naturally. Emit debug only for page 1.
  const pg = request.url.match(/[?&]page=(\d+)/)?.[1] || '1';
  if (pg === '1') {
    return [{ _debug: true, url: request.url, title: await page.title() }];
  }
  return [];
}
`;

function mapProshopItem(item, source, now) {
  if (item._debug) return null;

  const { name, href, priceText, origPriceText, productId, category } = item;
  if (!name || !priceText) return null;

  const price = parseSekValue(priceText);
  if (price == null) return null;

  const originalPrice = parseSekValue(origPriceText) || null;
  const fullUrl = href
    ? href.startsWith('http')
      ? href
      : `https://www.proshop.se${href}`
    : null;

  const externalId = String(productId || name).trim();
  if (!externalId) return null;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    externalId,
    title: name,
    url: fullUrl,
    priceSek: price,
    referencePriceSek: originalPrice,
    marketValueSek: originalPrice,
    imageUrl: item.imageUrl || null,
    category: category || 'outlet',
    condition: 'outlet',
    seenAt: now,
  };
}

/**
 * Collect ProShop outlet+demo products via Apify's playwright-scraper actor.
 *
 * ProShop is Cloudflare-protected — cheerio-scraper gets 403 after a few pages.
 * playwright-scraper with RESIDENTIAL proxies runs a real Chromium browser that
 * passes CF's JS challenge on every page. Pages are enqueued dynamically.
 *
 * Tested: 1750+ products collected (70 pages) with zero failures at concurrency 2.
 * Full run (38 Outlet + 61 Demo pages) completes in ~7 minutes.
 */
export async function collectFromProshop({ source, fetcher, sourceState, now, _ApifyClient }) {
  const maxRequestsPerCrawl = Number.isFinite(source.maxRequestsPerCrawl)
    ? source.maxRequestsPerCrawl
    : 150;

  const token = _ApifyClient
    ? 'stub'
    : (process.env[source.apiTokenEnvVar ?? 'APIFY_TOKEN']?.trim() ?? process.env.APIFY_TOKEN?.trim() ?? '');
  if (!token) throw new Error(`No Apify token configured for ${source.label ?? source.id}.`);

  const ClientClass = _ApifyClient ?? ApifyClient;
  const client = new ClientClass({ token });

  const run = await client.actor('apify/playwright-scraper').call(
    {
      startUrls: [
        { url: 'https://www.proshop.se/Outlet?sortby=0&pagesize=30&page=1' },
        { url: 'https://www.proshop.se/Demo?sortby=0&pagesize=30&page=1' },
      ],
      pageFunction: PLAYWRIGHT_PAGE_FUNCTION,
      proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
      maxRequestsPerCrawl,
      maxConcurrency: 2,
    },
    {
      timeout: Math.floor((source.actorTimeoutMs ?? 600_000) / 1000),
      memory: source.actorMemoryMb ?? 2048,
    }
  );

  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: 9999 });

  const debugItems = items.filter((it) => it._debug);
  if (debugItems.length > 0) {
    console.warn(`[proshop] ${debugItems.length} debug item(s):`, debugItems[0]);
  }

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

