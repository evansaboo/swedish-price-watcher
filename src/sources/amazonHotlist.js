import * as cheerio from 'cheerio';
import { normalizeProductIdentity } from '../lib/utils.js';
import { titleMatchesKeyword, normalizeWatchGroups } from './elgigantenHotlist.js';
import { resolveBypassBackend } from '../lib/bypassFetch.js';
import { buildFingerprint, buildStealthScript, buildLaunchArgs } from './browserFingerprint.js';

/**
 * Amazon.se Hotlist — a targeted, fast poller for hot product categories and
 * deals on Amazon Sweden (e.g. GPUs, SSDs, RAM, MacBooks, iPhones).
 *
 * Design goals:
 *  - **Targeted**: Runs queries specifically for active Hotlist Watch Groups
 *    rather than crawling the full catalog.
 *  - **Server-side discount filter**: Uses Amazon's `pct-off=X-` and `s=discount-rank`
 *    URL parameters so Amazon returns already-discounted items.
 *  - **Anti-bot resilience**: Seamlessly routes through `bypassFetch`
 *    (FlareSolverr / ScraperAPI / Scrapfly) or stealth Playwright Chromium.
 *  - **High signal**: Only emits listings with verified discount signals
 *    (strikethrough list price vs. current buy price).
 */

const AMAZON_SE_BASE_URL = 'https://www.amazon.se';
const DEFAULT_MIN_DISCOUNT_PCT = 15;

let cachedPlaywrightBrowser = null;
let cachedContext = null;
let cachedPage = null;

async function getAmazonStealthPage() {
  const { chromium } = await import('playwright');
  if (!cachedPlaywrightBrowser || !cachedPlaywrightBrowser.isConnected()) {
    cachedPlaywrightBrowser = await chromium.launch({
      headless: true,
      args: buildLaunchArgs()
    });
    cachedContext = null;
    cachedPage = null;
  }

  if (!cachedContext || !cachedPage || cachedPage.isClosed()) {
    const fingerprint = buildFingerprint(cachedPlaywrightBrowser.version(), {
      platform: process.platform === 'darwin' ? 'macOS' : 'Linux'
    });
    cachedContext = await cachedPlaywrightBrowser.newContext({
      userAgent: fingerprint.userAgent,
      locale: 'sv-SE',
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: {
        'Accept-Language': 'sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7',
        'sec-ch-ua': fingerprint.secChUa,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': fingerprint.secChUaPlatform
      }
    });
    cachedPage = await cachedContext.newPage();
    await cachedPage.addInitScript(buildStealthScript(fingerprint));
  }

  return cachedPage;
}

export async function fetchAmazonViaPlaywright(targetUrl, { signal = null, timeoutMs = 15000 } = {}) {
  const page = await getAmazonStealthPage();

  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });

    await page.waitForSelector('[data-component-type="s-search-result"], .s-result-item, #noResultsTitle, .a-row.s-result-list-parent-container', {
      timeout: 3500
    }).catch(() => {});

    const html = await page.content();
    return html;
  } catch (err) {
    cachedPage = null;
    cachedContext = null;
    throw err;
  }
}

/**
 * Parse Swedish Kronor price strings from Amazon.
 * Handles formats like:
 *   "1 499,00 kr", "1.499,00 kr", "1499 kr", "1499:-", "1,499.00 kr", "1499"
 */
export function parseAmazonPrice(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw);
  if (!raw) return null;
  const str = String(raw).trim();
  if (!str) return null;

  // Remove currency labels
  let cleaned = str.replace(/kr|sek|:-|\$/gi, '').trim();

  // Swedish format: "1 499,00" or "1.499,00" (spaces/dots thousands, comma decimal)
  if (/\d+[\s.]\d{3},\d{2}/.test(cleaned)) {
    cleaned = cleaned.replace(/[\s.]/g, '').replace(',', '.');
  } else if (/\d+,\d{3}\.\d{2}/.test(cleaned)) {
    cleaned = cleaned.replace(/,/g, '');
  } else if (/\d+,\d{2}$/.test(cleaned)) {
    cleaned = cleaned.replace(/\s+/g, '').replace(',', '.');
  } else {
    cleaned = cleaned.replace(/[\s,]/g, '');
  }

  const val = Number.parseFloat(cleaned);
  return Number.isFinite(val) && val > 0 ? Math.round(val) : null;
}

/**
 * Clean category name for Amazon search engine (e.g. "Grafikkort (GPU)" -> "Grafikkort").
 */
export function cleanCategoryForAmazon(categoryName) {
  if (!categoryName) return '';
  return String(categoryName)
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build Amazon.se targeted search URL for a query with discount and deal parameters.
 */
export function buildAmazonSearchUrl(query, minDiscountPct = DEFAULT_MIN_DISCOUNT_PCT, brands = []) {
  const discount = Math.max(0, Math.min(99, Math.round(minDiscountPct)));
  const params = new URLSearchParams({
    k: query,
    'pct-off': `${discount}-`,
    s: 'discount-rank'
  });
  if (Array.isArray(brands) && brands.length) {
    const cleanBrands = brands.map((b) => String(b).trim()).filter(Boolean);
    if (cleanBrands.length) {
      params.set('rh', `p_89:${cleanBrands.join('|')}`);
    }
  }
  return `${AMAZON_SE_BASE_URL}/s?${params.toString()}`;
}

/**
 * Extract product ASIN from data attributes or URL.
 */
export function extractAsin(asinAttr, url) {
  if (asinAttr && typeof asinAttr === 'string' && /^[A-Z0-9]{10}$/i.test(asinAttr.trim())) {
    return asinAttr.trim().toUpperCase();
  }
  if (!url) return null;
  const match = String(url).match(/(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Parse Amazon search results HTML into normalized deal listings.
 */
export function parseAmazonSearchResultsHtml(html, {
  source,
  group = {},
  query = '',
  now = new Date().toISOString(),
  minDiscountPct = DEFAULT_MIN_DISCOUNT_PCT
} = {}) {
  if (!html || typeof html !== 'string') return [];

  const $ = cheerio.load(html);
  const items = [];
  const seenAsins = new Set();

  // Amazon wraps each result in a div with data-component-type="s-search-result"
  // or .s-result-item[data-asin]
  const resultCards = $('div[data-component-type="s-search-result"], div.s-result-item[data-asin]');

  resultCards.each((_, el) => {
    const $el = $(el);
    const rawAsin = $el.attr('data-asin');
    const titleLink = $el.find('h2 a, .s-title-instructions-style h2 a').first();
    const href = titleLink.attr('href') || $el.find('a.a-link-normal').first().attr('href');
    const asin = extractAsin(rawAsin, href);

    if (!asin || seenAsins.has(asin)) return;

    // Extract Title
    const title = $el.find('h2 a span, h2 span, .s-title-instructions-style h2 span').first().text().trim()
      || titleLink.text().trim();
    if (!title || title.length < 3) return;

    // Filter by keyword relevance if query provided
    if (query && !titleMatchesKeyword(title, query)) {
      return;
    }

    // Extract Current Price
    // Current price is inside .a-price (excluding strikethrough .a-text-price)
    let currentPriceText = $el.find('.a-price:not(.a-text-price) .a-offscreen').first().text();
    if (!currentPriceText) {
      const whole = $el.find('.a-price:not(.a-text-price) .a-price-whole').first().text().replace(/[,.]/g, '').trim();
      const fraction = $el.find('.a-price:not(.a-text-price) .a-price-fraction').first().text().trim() || '00';
      if (whole) currentPriceText = `${whole},${fraction} kr`;
    }
    const priceSek = parseAmazonPrice(currentPriceText);
    if (!priceSek || priceSek <= 0) return;

    // Extract Reference / Strikethrough Price
    let referencePriceSek = null;
    const refPriceText = $el.find('.a-price.a-text-price .a-offscreen, span[data-a-strike="true"] .a-offscreen, .a-text-strike').first().text();
    if (refPriceText) {
      referencePriceSek = parseAmazonPrice(refPriceText);
    }
    if (!referencePriceSek) {
      const secondaryText = $el.find('.a-size-small.a-color-secondary, .a-color-secondary, .a-size-base.a-color-secondary').text();
      const match = secondaryText.match(/(?:Median|Rek(?:\.\s*pris)?|Tidigare|Typiskt pris)[:\s]+([\d\s.,]+)\s*kr/i);
      if (match) {
        referencePriceSek = parseAmazonPrice(match[1]);
      }
    }

    // Calculate discount percentage
    let discountPct = 0;
    if (referencePriceSek && referencePriceSek > priceSek) {
      discountPct = Math.round((1 - priceSek / referencePriceSek) * 100);
    } else {
      // Try parsing discount badge (e.g. "-20%", "Spara 25%")
      const badgeText = $el.find('.a-badge-text, .a-badge-label, span.a-color-price').text();
      const match = badgeText.match(/-?(\d+)%/);
      if (match) {
        discountPct = Number.parseInt(match[1], 10);
      }
    }

    // Filter by minimum discount requirement
    const requiredDiscount = group.minDiscountPct ?? minDiscountPct;
    if (discountPct < requiredDiscount) {
      return;
    }

    // Filter by price constraints if configured
    if (group.minPriceSek && priceSek < group.minPriceSek) return;
    if (group.maxPriceSek && priceSek > group.maxPriceSek) return;

    // Filter by brands if configured
    if (Array.isArray(group.brands) && group.brands.length) {
      const titleLower = title.toLowerCase();
      const brandMatch = group.brands.some((b) => titleLower.includes(b.toLowerCase().trim()));
      if (!brandMatch) {
        const brandTag = $el.find('.a-size-small.a-color-base, .a-row.a-size-base.a-color-secondary, .a-size-base-plus').text().toLowerCase();
        if (!group.brands.some((b) => brandTag.includes(b.toLowerCase().trim()))) {
          return;
        }
      }
    }

    // Extract Image URL
    const imageUrl = $el.find('img.s-image').first().attr('src') || null;

    // Condition (Warehouse vs New Deal)
    const isWarehouse = /begagnad|warehouse|fyndvara/i.test($el.text());
    const condition = isWarehouse ? 'outlet' : 'deal';
    const conditionLabel = isWarehouse ? 'Amazon Fyndvara' : 'Amazon Deal';

    const sourceId = source?.id || 'amazon-hotlist';
    const sourceLabel = source?.label || 'Amazon.se';
    const sourceType = source?.type || 'amazon-hotlist';

    seenAsins.add(asin);

    items.push({
      sourceId,
      sourceLabel,
      sourceType,
      externalId: asin,
      productKey: normalizeProductIdentity(title),
      title,
      url: `${AMAZON_SE_BASE_URL}/dp/${asin}`,
      category: group.label || 'Electronics',
      condition,
      conditionLabel,
      grade: null,
      priceSek,
      marketValueSek: referencePriceSek || priceSek,
      referencePriceSek: referencePriceSek || null,
      referenceUrl: null,
      referenceTitle: null,
      referenceSourceLabel: null,
      availability: 'in_stock',
      imageUrl,
      discountPct,
      scannedAt: now,
      isBuyable: true
    });
  });

  return items;
}

/**
 * Fetches real-time keyword suggestions from Amazon Sweden (zero credentials required).
 */
export async function fetchAmazonSuggestions(prefix) {
  if (!prefix || typeof prefix !== 'string' || !prefix.trim()) return [];
  const url = `https://completion.amazon.se/api/2017/suggestions?prefix=${encodeURIComponent(prefix.trim())}&mid=A2NODRKZP88ZB9&alias=aps`;
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.suggestions ?? []).map((s) => s.value).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Collects hot deals from Amazon.se matching configured watch groups
 * using targeted stealth Playwright browser scraping.
 */
export async function collectFromAmazonHotlist({
  source,
  fetcher,
  preferences,
  now = new Date().toISOString(),
  signal = null
}) {
  const start = Date.now();
  const hotlistConfig = preferences?.hotlist ?? {};
  const groups = normalizeWatchGroups(hotlistConfig.groups ?? source.watchGroups ?? [], 'amazon-hotlist');
  const minDiscountPct = Number(hotlistConfig.minDiscountPct ?? source.minDiscountPct ?? DEFAULT_MIN_DISCOUNT_PCT);

  if (!groups.length) {
    return [];
  }

  // Resolve bypass fetcher if FlareSolverr, ScraperAPI, or Scrapfly configured
  let bypassBackend = null;
  try {
    bypassBackend = resolveBypassBackend(source, { signal });
  } catch {
    bypassBackend = null;
  }

  const collected = [];
  const seenAsins = new Set();

  for (const group of groups) {
    if (signal?.aborted) break;

    // Determine query terms: keywords take precedence, followed by brands, taxonomy, or label
    const queries = [];
    if (Array.isArray(group.keywords) && group.keywords.length) {
      queries.push(...group.keywords);
    } else {
      const cleanCats = (group.taxonomyNames ?? []).map(cleanCategoryForAmazon).filter(Boolean);
      const brands = (group.brands ?? []).filter(Boolean);
      const parts = [...brands, ...cleanCats];
      const queryStr = parts.length ? parts.join(' ') : cleanCategoryForAmazon(group.label);
      if (queryStr) queries.push(queryStr);
    }

    for (const query of queries.slice(0, 1)) {
      if (signal?.aborted) break;

      const targetUrl = buildAmazonSearchUrl(query, group.minDiscountPct ?? minDiscountPct, group.brands);

      let html = '';
      try {
        if (bypassBackend) {
          html = await bypassBackend.fetchPage(targetUrl, signal);
        } else if (fetcher && typeof fetcher.fetchPageHtml === 'function') {
          html = await fetcher.fetchPageHtml(targetUrl, signal);
        } else {
          // Use stealth Playwright browser by default to solve Akamai challenges
          html = await fetchAmazonViaPlaywright(targetUrl, { signal, timeoutMs: 30000 });
        }
      } catch (err) {
        console.warn(`[amazon-hotlist] Failed query "${query}": ${err.message}`);
        continue;
      }

      if (!html) continue;

      const parsedItems = parseAmazonSearchResultsHtml(html, {
        source,
        group,
        query,
        now,
        minDiscountPct
      });

      for (const item of parsedItems) {
        if (!seenAsins.has(item.externalId)) {
          seenAsins.add(item.externalId);
          collected.push(item);
        }
      }
    }
  }

  const elapsedMs = Date.now() - start;
  console.log(`[amazon-hotlist] ${collected.length} deal(s) from ${groups.length} group(s) in ${elapsedMs}ms`);

  return collected;
}
