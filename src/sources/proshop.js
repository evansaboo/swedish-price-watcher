import { ApifyClient } from 'apify-client';
import { normalizeProductIdentity, parseSekValue } from '../lib/utils.js';

/**
 * ProShop Outlet + Demo scraper via Apify's playwright-scraper actor.
 *
 * ProShop is behind Cloudflare Bot Management (managed challenge). Local headless
 * Chromium — even with rebrowser-playwright CDP patches and a residential proxy —
 * fails because CF's JS fingerprinting detects context mismatches before stealth
 * patches fire. Apify's playwright-scraper runs in their managed infrastructure
 * which uses residential IPs and has CF-specific handling built in.
 *
 * This is the same pattern used by the Power scraper — generate all page URLs
 * upfront (up to maxPages), fan them out to the Apify actor in one run, and
 * collect all returned product items. Duplicate-proof by externalId.
 */

const BASE_URL = 'https://www.proshop.se';
const PAGE_SIZE = 48;

// Inline page function sent to Apify. Runs inside Playwright-managed Chromium.
// Waits for either product list items or the not-found page, then extracts all
// product fields from the DOM. Returns an array of raw product objects.
const PAGE_FUNCTION = /* javascript */ `
async function pageFunction({ page, request }) {
  const TIMEOUT = 30000;

  // Wait for products or a not-found sentinel
  const found = await page
    .waitForSelector('li.site-productlist-item, .site-page-not-found, #no-products-found', { timeout: TIMEOUT })
    .catch(() => null);

  // If Cloudflare challenge page is still active, bail — Apify will retry
  if (!found) {
    const title = await page.title().catch(() => '');
    if (title.includes('Just a moment') || title === '') {
      throw new Error('CF challenge not resolved');
    }
    return [];
  }

  return page.evaluate(() => {
    const items = [];
    document.querySelectorAll('li.site-productlist-item').forEach((el) => {
      const linkEl = el.querySelector('a.site-product-link') || el.querySelector('a');
      const href = linkEl?.getAttribute('href') || '';
      const segments = href.split('/').filter(Boolean);

      // Segment pattern: /CategorySlug/ProductNameSlug/ProductID
      const productId = segments[segments.length - 1] || '';
      const nameSlugs = segments.length >= 2 ? segments[segments.length - 2] : '';
      const name =
        linkEl?.getAttribute('title') ||
        linkEl?.textContent?.trim() ||
        nameSlugs.replace(/-+/g, ' ').trim();
      const category = segments.length >= 1 ? segments[0].replace(/-+/g, ' ').trim() : '';

      const priceText =
        el.querySelector('span.site-currency-lg')?.textContent?.trim() || '';
      const origPriceText =
        el.querySelector('span.site-currency-oldprice, .site-currency-old, .oldprice, .site-currency-before')
          ?.textContent?.trim() || '';

      const imgEl = el.querySelector('img');
      let imageUrl =
        imgEl?.getAttribute('data-src') ||
        imgEl?.getAttribute('data-lazy-src') ||
        imgEl?.getAttribute('src') ||
        '';
      if (imageUrl && !imageUrl.startsWith('http') && !imageUrl.startsWith('data:')) {
        imageUrl = 'https://www.proshop.se' + (imageUrl.startsWith('/') ? '' : '/') + imageUrl;
      }

      if (!name || !priceText) return;
      items.push({ name, href, priceText, origPriceText, productId: productId || name, category, imageUrl });
    });
    return items;
  });
}
`;

function mapProshopItem(item, source, now) {
  const { name, href, priceText, origPriceText, productId, category, imageUrl } = item;
  if (!name || !priceText) return null;

  const price = parseSekValue(priceText);
  if (price == null) return null;

  const originalPrice = parseSekValue(origPriceText) || null;
  const fullUrl = href
    ? href.startsWith('http') ? href : `${BASE_URL}${href}`
    : null;

  const externalId = String(productId || name).trim();
  if (!externalId) return null;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId,
    title: name,
    url: fullUrl,
    productKey: normalizeProductIdentity(name),
    priceSek: price,
    referencePriceSek: originalPrice,
    marketValueSek: originalPrice,
    imageUrl: imageUrl || null,
    category: category || 'outlet',
    condition: 'outlet',
    conditionLabel: 'Outlet',
    availability: 'in_stock',
    seenAt: now,
  };
}

export async function collectFromProshop({ source, sourceState, now }) {
  const token =
    process.env[source.apiTokenEnvVar ?? 'APIFY_TOKEN']?.trim() ??
    process.env.APIFY_TOKEN?.trim() ??
    '';
  if (!token) throw new Error(`No Apify token configured for ${source.label ?? source.id}.`);

  const maxPages = source.maxPages ?? 25; // 25 pages × 48 items = up to 1200 products/section

  // Build start URLs for /Outlet and /Demo, each paginated
  const startUrls = [];
  for (const section of ['/Outlet', '/Demo']) {
    for (let page = 1; page <= maxPages; page++) {
      startUrls.push({ url: `${BASE_URL}${section}?sortby=0&pagesize=${PAGE_SIZE}&page=${page}` });
    }
  }

  const client = new ApifyClient({ token });
  const run = await client.actor('apify/playwright-scraper').call({
    startUrls,
    pageFunction: PAGE_FUNCTION,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    maxRequestsPerCrawl: startUrls.length + 5,
    launchContext: {
      launchOptions: {
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      },
    },
  }, { timeout: Math.floor((source.actorTimeoutMs ?? 480_000) / 1000) });

  const { items: rawItems } = await client.dataset(run.defaultDatasetId).listItems();

  // Flatten and deduplicate
  const seen = new Set();
  const observations = [];
  for (const pageResult of rawItems) {
    const products = Array.isArray(pageResult) ? pageResult : [];
    for (const item of products) {
      const obs = mapProshopItem(item, source, now);
      if (!obs || seen.has(obs.externalId)) continue;
      seen.add(obs.externalId);
      observations.push(obs);
    }
  }

  sourceState.lastDiscoveryCount = observations.length;
  console.log(`[proshop] Total: ${observations.length} products`);
  return observations;
}


