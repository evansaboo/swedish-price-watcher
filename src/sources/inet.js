// ═══════════════════════════════════════════════════════════════
// Inet Fyndhörnan (Bargain Corner) — Apify cheerio-scraper
// Server-rendered React with hydrate JSON in script tags.
// ═══════════════════════════════════════════════════════════════

import { ApifyClient } from 'apify-client';

const BASE_URL = 'https://www.inet.se/fyndhornan';
const MAX_PAGES = 10;

// Page function extracts product JSON from the hydrate call
const PAGE_FN = `async function pageFunction(context) {
  const { $, request } = context;
  const results = [];

  // Find the hydrate script containing BargainPage data
  $('script').each((_, el) => {
    const text = $(el).html() || '';
    const match = text.match(/hydrate\\("BargainPage",\\s*JSON\\.parse\\("(.+?)"\\)\\)/s);
    if (!match) return;

    let json;
    try {
      // The JSON is escaped inside a string literal
      const unescaped = match[1].replace(/\\\\"/g, '"').replace(/\\\\\\\\/g, '\\\\');
      json = JSON.parse(unescaped);
    } catch (e) {
      // Try alternate unescape
      try {
        json = JSON.parse(JSON.parse('"' + match[1] + '"'));
      } catch (e2) { return; }
    }

    const products = json?.productListWithDynamicFilterViewModel?.products
      || json?.products
      || [];

    for (const p of products) {
      const id = p.id || p.templateId || p.urlName;
      if (!id) continue;

      const price = p.price?.price ?? p.price ?? null;
      const listPrice = p.price?.listPrice ?? p.listPrice ?? null;
      const title = p.name || p.title || '';
      const urlName = p.urlName || p.url || '';
      const image = p.image || p.imageUrl || '';
      const qty = p.qty ?? p.stock ?? null;
      const condition = p.sellingPoint || p.condition || 'Fyndhörnan';
      const categoryName = p.categoryName || p.category || '';

      results.push({
        id: String(id),
        title,
        url: urlName.startsWith('http') ? urlName : 'https://www.inet.se/produkt/' + urlName,
        price: typeof price === 'number' ? price : null,
        listPrice: typeof listPrice === 'number' ? listPrice : null,
        image: image.startsWith('http') ? image : (image ? 'https://www.inet.se' + image : ''),
        qty,
        condition,
        category: categoryName
      });
    }
  });

  // Fallback: parse product cards from HTML if hydrate extraction failed
  if (results.length === 0) {
    $('.product-list-item, [data-product-id], .bargain-item').each((_, el) => {
      const $el = $(el);
      const title = $el.find('.product-title, h3, .name').first().text().trim();
      const link = $el.find('a[href*="/produkt/"]').first().attr('href') || '';
      const priceText = $el.find('.product-price, .price, .current-price').first().text().replace(/[^\\d]/g, '');
      const listPriceText = $el.find('.list-price, .old-price, .before-price').first().text().replace(/[^\\d]/g, '');
      const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
      const id = $el.attr('data-product-id') || link.split('/produkt/')[1]?.split('/')[0] || '';

      if (title && id) {
        results.push({
          id,
          title,
          url: link.startsWith('http') ? link : 'https://www.inet.se' + link,
          price: priceText ? parseInt(priceText) : null,
          listPrice: listPriceText ? parseInt(listPriceText) : null,
          image: img.startsWith('http') ? img : (img ? 'https://www.inet.se' + img : ''),
          qty: null,
          condition: 'Fyndhörnan',
          category: ''
        });
      }
    });
  }

  return results;
}`;

export async function collectFromInet({ source, sourceState, now }) {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error('APIFY_TOKEN env var required for Inet scraper');

  const client = new ApifyClient({ token });
  const maxPages = source.maxPages ?? MAX_PAGES;

  // Build start URLs for all pages
  const startUrls = [];
  for (let page = 1; page <= maxPages; page++) {
    startUrls.push({ url: page === 1 ? BASE_URL : `${BASE_URL}?page=${page}` });
  }

  console.log(`[inet] Starting Apify cheerio-scraper for ${startUrls.length} pages...`);

  const run = await client.actor('apify/cheerio-scraper').call({
    startUrls,
    pageFunction: PAGE_FN,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    maxRequestsPerCrawl: maxPages + 2,
    maxConcurrency: 3,
    requestHandlerTimeoutSecs: 30,
    additionalMimeTypes: ['text/html'],
  }, { timeout: Math.floor((source.actorTimeoutMs ?? 180_000) / 1000) });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  const products = items.flat().filter(p => p && p.id && p.price);

  console.log(`[inet] Collected ${products.length} products from Fyndhörnan`);

  // Deduplicate by ID
  const seen = new Set();
  const observations = [];

  for (const p of products) {
    const externalId = String(p.id);
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    const availability = p.qty != null
      ? (p.qty > 5 ? 'in_stock' : p.qty > 0 ? 'few_left' : 'out_of_stock')
      : 'unknown';

    observations.push({
      sourceId: source.id,
      sourceLabel: source.label || 'Inet Fyndhörnan',
      sourceType: source.type,
      externalId,
      title: p.title,
      url: p.url,
      priceSek: p.price,
      referencePriceSek: p.listPrice && p.listPrice > p.price ? p.listPrice : null,
      category: p.category || 'Övrigt',
      condition: 'outlet',
      conditionLabel: p.condition || 'Fyndhörnan',
      availability,
      imageUrl: p.image || null,
      seenAt: now
    });
  }

  return observations;
}
