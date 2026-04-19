import { chromium } from 'rebrowser-playwright';
import { normalizeProductIdentity, parseSekValue, sleep } from '../lib/utils.js';

// rebrowser-playwright patches CDP-level detection signals (Runtime.enable, contextId leaks)
// that playwright-extra stealth cannot fix — these are CF Bot Management's #1 detection vectors.

const BASE_URL = 'https://www.proshop.se';
const PAGE_SIZE = 30;
const PAGE_DELAY_MS = 500;
const PAGE_TIMEOUT_MS = 25_000;

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--no-first-run',
  '--disable-blink-features=AutomationControlled',
];

// Don't block images — we need src/data-src attributes for product image URLs.
// Only block media (video/audio) to save bandwidth.
const BLOCKED_RESOURCE_TYPES = new Set(['media']);

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

async function scrapeCategory(page, path, source, now, seen) {
  const observations = [];
  let pageNum = 1;

  while (true) {
    const url = `${BASE_URL}${path}?sortby=0&pagesize=${PAGE_SIZE}&page=${pageNum}`;

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    } catch (err) {
      console.warn(`[proshop] navigation timeout on ${path} page ${pageNum}: ${err.message}`);
      break;
    }

    // Products are AJAX-rendered — wait up to 15 s for them to appear after navigation.
    const found = await page.waitForSelector('li.site-productlist-item, .site-page-not-found', {
      timeout: 15_000,
    }).catch(() => null);

    if (!found) {
      // Log page title to diagnose CF challenge vs real 404
      const title = await page.title().catch(() => '(error)');
      const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 200)).catch(() => '');
      console.warn(`[proshop] ${path} page ${pageNum}: waitForSelector timed out. title="${title}" body="${bodySnippet}"`);
      break;
    }

    const items = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('li.site-productlist-item')).map((el) => {
        const linkEl = el.querySelector('a.site-product-link') || el.querySelector('a');
        const href = linkEl?.getAttribute('href') || '';
        const segments = href.split('/').filter(Boolean);
        const name = segments.length >= 2
          ? segments[segments.length - 2].replace(/-+/g, ' ').trim()
          : el.querySelector('.site-product-link, a')?.textContent?.trim() || '';
        const productId = segments[segments.length - 1] || '';
        const category = segments.length >= 1 ? segments[0].replace(/-+/g, ' ').trim() : '';
        const priceText = el.querySelector('span.site-currency-lg')?.textContent?.trim() || '';
        const origPriceText = el.querySelector('span.site-currency-oldprice, .site-currency-old, .oldprice')?.textContent?.trim() || '';
        const imgEl = el.querySelector('img');
        const imageUrl =
          imgEl?.getAttribute('data-src') ||
          imgEl?.getAttribute('data-lazy-src') ||
          imgEl?.getAttribute('src') || '';
        const imageUrlFull = imageUrl && !imageUrl.startsWith('http') && !imageUrl.startsWith('data:')
          ? 'https://www.proshop.se' + (imageUrl.startsWith('/') ? '' : '/') + imageUrl
          : imageUrl || '';
        if (!name || !priceText) return null;
        return { name, href, priceText, origPriceText, productId: productId || name, category, imageUrl: imageUrlFull };
      }).filter(Boolean);
    });

    if (items.length === 0) break;

    for (const item of items) {
      const obs = mapProshopItem(item, source, now);
      if (!obs || seen.has(obs.externalId)) continue;
      seen.add(obs.externalId);
      observations.push(obs);
    }

    console.log(`[proshop] ${path} page ${pageNum}: ${items.length} products`);
    pageNum += 1;
    await sleep(PAGE_DELAY_MS);
  }

  return observations;
}

/**
 * Collect ProShop outlet+demo products using Playwright directly.
 *
 * ProShop is behind Cloudflare Bot Management which blocks cloud/data-center IPs
 * and AJAX requests from headless browsers. A residential proxy is required for
 * Railway deployments. Configure via:
 *
 *   PROSHOP_PROXY_URL=http://groups-RESIDENTIAL:TOKEN@proxy.apify.com:8000
 *                   (uses your existing Apify token — no extra service needed)
 *   or any SOCKS5/HTTP proxy:
 *   PROSHOP_PROXY_URL=socks5://user:pass@host:port
 *
 * Without a proxy the scraper works from residential IPs (local dev) but will
 * be blocked on Railway. With the Apify proxy it bypasses CF and returns all
 * 1000+ outlet + demo items.
 *
 * Memory: Chromium headless ~200MB peak; closed immediately after scraping.
 */
export async function collectFromProshop({ source, sourceState, now }) {
  // Resolve proxy — prefer explicit env var, fall back to Apify residential proxy
  const proxyUrl =
    process.env.PROSHOP_PROXY_URL?.trim() ||
    (process.env.APIFY_TOKEN?.trim()
      ? `http://groups-RESIDENTIAL:${process.env.APIFY_TOKEN.trim()}@proxy.apify.com:8000`
      : null);

  if (!proxyUrl) {
    console.warn('[proshop] No residential proxy configured. CF may block Railway IP. Set PROSHOP_PROXY_URL or APIFY_TOKEN.');
  } else {
    const safeProxy = proxyUrl.replace(/:([^@/]+)@/, ':***@');
    console.log(`[proshop] Using proxy: ${safeProxy}`);
  }

  const launchOptions = {
    headless: true,
    args: BROWSER_ARGS,
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
  };

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'sv-SE',
      timezoneId: 'Europe/Stockholm',
      extraHTTPHeaders: {
        'accept-language': 'sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
    });
    // JS-level stealth: patch navigator, plugins, languages, permissions to match real Chrome
    await ctx.addInitScript(() => {
      // Hide webdriver
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // Mimic real Chrome plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }],
      });
      Object.defineProperty(navigator, 'languages', { get: () => ['sv-SE', 'sv', 'en-US', 'en'] });
      // Pass permissions query (CF checks this)
      const origQuery = window.navigator.permissions?.query;
      if (origQuery) {
        window.navigator.permissions.query = (parameters) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : origQuery(parameters);
      }
      // Hide headless Chrome tells
      delete window.chrome;
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    });

    const page = await ctx.newPage();
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (BLOCKED_RESOURCE_TYPES.has(type)) return route.abort();
      return route.continue();
    });

    const seen = new Set();
    const observations = [
      ...await scrapeCategory(page, '/Outlet', source, now, seen),
      ...await scrapeCategory(page, '/Demo', source, now, seen),
    ];

    sourceState.lastDiscoveryCount = observations.length;
    console.log(`[proshop] Total: ${observations.length} products`);
    return observations;
  } finally {
    await browser?.close();
  }
}

