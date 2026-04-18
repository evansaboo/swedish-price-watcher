import { ApifyClient } from 'apify-client';
import { parseSekValue } from '../lib/utils.js';

/**
 * The pageFunction executed inside Apify's playwright-scraper actor.
 * Power.se is an Angular SPA — we intercept network responses to capture
 * the product API payload, then scroll to load all pages via infinite scroll.
 */
const PLAYWRIGHT_PAGE_FUNCTION = /* js */ `
async function pageFunction(context) {
  const { page } = context;
  const capturedProducts = [];
  const seenProductCodes = new Set();

  function addProducts(products) {
    for (const p of products) {
      const key = String(p.code ?? p.id ?? p.productId ?? p.name ?? '').trim();
      if (key && !seenProductCodes.has(key)) {
        seenProductCodes.add(key);
        capturedProducts.push(p);
      }
    }
  }

  // Intercept API responses — set up BEFORE reload so we catch everything
  page.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    if (
      ct.includes('application/json') &&
      !url.includes('analytics') &&
      !url.includes('gtm') &&
      !url.includes('clarity') &&
      !url.includes('cookie')
    ) {
      try {
        const data = await response.json();
        const products =
          data.products ||
          data.items ||
          data.results ||
          data.productList ||
          data.hits ||
          null;
        if (Array.isArray(products) && products.length > 0) {
          addProducts(products);
        }
      } catch {}
    }
  });

  // Inject consent cookie so the Angular app doesn't show the cookie banner
  await page.evaluate(() => {
    const consent = JSON.stringify({
      consents_approved: ['cookie_cat_necessary', 'cookie_cat_functional', 'cookie_cat_statistic', 'cookie_cat_marketing'],
      consents_denied: [],
      user_uid: 'auto',
      timestamp: new Date().toISOString()
    });
    document.cookie = 'CookieInformationConsent=' + encodeURIComponent(consent) + '; path=/; max-age=86400';
  });

  // Reload so Angular starts fresh with consent already set and we capture all API calls
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));

  // Scroll repeatedly to trigger infinite scroll / lazy loading
  // Keep scrolling until no new products are loaded for 2 consecutive rounds
  let previousCount = 0;
  let noNewRounds = 0;
  const maxScrollRounds = 40;

  for (let round = 0; round < maxScrollRounds; round++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));

    // Also try clicking a "load more" button if present
    const loadMoreClicked = await page.evaluate(() => {
      const btn = document.querySelector(
        'button[class*="load-more"], button[class*="loadMore"], .load-more button, ' +
        '[data-test*="load-more"], button:not([disabled])[class*="show-more"]'
      );
      if (btn) { btn.click(); return true; }
      return false;
    }).catch(() => false);
    if (loadMoreClicked) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    const currentCount = capturedProducts.length;
    if (currentCount === previousCount) {
      noNewRounds++;
      if (noNewRounds >= 2) break; // No new products for 2 rounds — done
    } else {
      noNewRounds = 0;
    }
    previousCount = currentCount;
  }

  if (capturedProducts.length > 0) {
    return capturedProducts;
  }

  // Fallback: extract from rendered DOM
  return await page.evaluate(() => {
    const items = document.querySelectorAll(
      'app-product-list-item, app-product-card, power-product-card, ' +
      '[data-test="product-list-item"], .product-list-item, ' +
      '[class*="product-card__"], [class*="ProductCard"]'
    );

    if (items.length === 0) {
      return [
        {
          _debug: true,
          title: document.title,
          bodySnippet: document.body.innerHTML.substring(0, 5000),
        },
      ];
    }

    return Array.from(items)
      .map((el) => {
        const nameEl = el.querySelector('[data-test*="name"], [class*="name"], h2, h3, .product-name');
        const priceEl = el.querySelector('[data-test*="price"], [class*="price"], .price');
        const oldPriceEl = el.querySelector('[class*="original"], [class*="was"], [class*="crossed"], s, del');
        const linkEl = el.querySelector('a');
        const imgEl = el.querySelector('img');

        return {
          name: nameEl?.textContent?.trim() || '',
          href: linkEl?.getAttribute('href') || '',
          price: priceEl?.textContent?.replace(/[^0-9]/g, '') || '',
          originalPrice: oldPriceEl?.textContent?.replace(/[^0-9]/g, '') || '',
          imageUrl: imgEl?.getAttribute('src') || '',
        };
      })
      .filter((p) => p.name && p.price);
  });
}
`;

function isApiProduct(item) {
  // API-captured products have structured fields; DOM-extracted have name/href/price strings
  return (
    item.code != null ||
    item.id != null ||
    item.productId != null ||
    item.salesPrice != null ||
    item.currentPrice != null ||
    (item.price != null && typeof item.price === 'object')
  );
}

function mapApiProduct(item, source, now) {
  const externalId = String(item.code ?? item.id ?? item.productId ?? '').trim();
  const name = String(item.name ?? item.title ?? '').trim();
  if (!externalId || !name) return null;

  const price = parseSekValue(
    item.price?.value ?? item.salesPrice ?? item.currentPrice ?? item.price ?? null
  );
  if (price == null) return null;

  const refPrice = parseSekValue(
    item.priceBeforeSale ?? item.originalPrice ?? item.listPrice ?? item.price?.regular ?? null
  );

  const href = item.url ?? item.href ?? '';
  const fullUrl = href
    ? href.startsWith('http')
      ? href
      : `https://www.power.se${href}`
    : null;

  return {
    sourceId: source.id,
    externalId,
    title: name,
    url: fullUrl,
    priceSek: price,
    referencePriceSek: refPrice,
    marketValueSek: refPrice,
    imageUrl: item.image ?? item.imageUrl ?? item.img ?? null,
    category: item.category ?? item.mainCategory ?? 'electronics',
    condition: 'outlet',
    seenAt: now,
  };
}

function mapDomProduct(item, source, now) {
  const name = String(item.name ?? '').trim();
  if (!name) return null;

  const price = parseSekValue(item.price);
  if (price == null) return null;

  const refPrice = parseSekValue(item.originalPrice) || null;
  const href = item.href ?? '';
  const fullUrl = href
    ? href.startsWith('http')
      ? href
      : `https://www.power.se${href}`
    : null;

  // Use name as a fallback ID since DOM items don't expose product codes
  const externalId = String(item.productId ?? name).trim();

  return {
    sourceId: source.id,
    externalId,
    title: name,
    url: fullUrl,
    priceSek: price,
    referencePriceSek: refPrice,
    marketValueSek: refPrice,
    imageUrl: item.imageUrl || null,
    category: 'electronics',
    condition: 'outlet',
    seenAt: now,
  };
}

/**
 * Collect Power Erbjudanden products via Apify's playwright-scraper actor.
 *
 * Power.se is a client-side Angular SPA that requires JavaScript rendering.
 * The playwright-scraper intercepts product API responses and falls back to
 * DOM extraction if the API response is not captured.
 */
export async function collectFromPower({ source, fetcher, sourceState, now, _ApifyClient }) {
  const token = _ApifyClient
    ? 'stub'
    : (process.env[source.apiTokenEnvVar ?? 'APIFY_TOKEN']?.trim() ?? process.env.APIFY_TOKEN?.trim() ?? '');
  if (!token) throw new Error(`No Apify token configured for ${source.label ?? source.id}.`);

  const ClientClass = _ApifyClient ?? ApifyClient;
  const client = new ClientClass({ token });

  const run = await client.actor('apify/playwright-scraper').call(
    {
      startUrls: [{ url: 'https://www.power.se/kampanj/erbjudanden/' }],
      pageFunction: PLAYWRIGHT_PAGE_FUNCTION,
      proxyConfiguration: { useApifyProxy: true },
      maxRequestsPerCrawl: 1,
    },
    { timeout: Math.floor((source.actorTimeoutMs ?? 180_000) / 1000) }
  );

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  // Log debug items and skip them
  const debugItems = items.filter((it) => it._debug);
  if (debugItems.length > 0) {
    console.warn(`[power] ${debugItems.length} debug item(s) — selectors or API intercept may need updating.`);
    for (const d of debugItems) {
      console.warn(`[power] debug title=${d.title} snippet=`, d.bodySnippet?.substring(0, 500));
    }
  }

  // Deduplicate by externalId
  const seen = new Set();
  const observations = [];

  for (const item of items) {
    if (item._debug) continue;

    const obs = isApiProduct(item)
      ? mapApiProduct(item, source, now)
      : mapDomProduct(item, source, now);

    if (!obs) continue;
    if (seen.has(obs.externalId)) continue;
    seen.add(obs.externalId);
    observations.push(obs);
  }

  sourceState.lastDiscoveryCount = observations.length;
  return observations;
}
