import { load } from 'cheerio';
import { resolveIncrementalMode } from '../lib/incremental.js';
import { normalizeProductIdentity, parseSekValue, sleep } from '../lib/utils.js';
import { resolveBypassBackend } from '../lib/bypassFetch.js';

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

    // Extract image URL from the product listing img tag.
    // ProShop uses relative paths like /Images/174x116/{id}_{hash}.png
    const imgEl = $(el).find('img[src]').first();
    const rawImg = imgEl.attr('data-src') || imgEl.attr('src') || '';
    const imageUrl = rawImg && !rawImg.includes('data:image')
      ? (rawImg.startsWith('http') ? rawImg : rawImg.startsWith('//') ? `https:${rawImg}` : `${BASE_URL}${rawImg}`)
      : null;

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
      imageUrl,
      category: category || 'outlet',
      condition: 'outlet',
      conditionLabel: 'Outlet',
      availability: 'in_stock',
      seenAt: now,
    });
  });

  return observations;
}

export async function collectFromProshop({ source, sourceState, now, signal }) {
  // Priority: FlareSolverr (free, self-hosted) → ScraperAPI → Scrapfly.
  const backend = resolveBypassBackend(source, {
    premium: source.premiumProxy === true,
    renderJs: source.renderJs !== false,
  });

  const pageDelayMs = source.pageDelayMs ?? 1500;
  // Incremental on by default for ProShop (credit-limited backends); every
  // incrementalFullScanEvery-th scan runs full so stale items can be pruned.
  const incremental = resolveIncrementalMode(source, sourceState, { defaultStopPages: 2 });
  const knownIds = incremental.knownIds;

  console.log(`[proshop] Using ${backend.label}; known IDs: ${knownIds.size}${incremental.active ? '' : ' (full scan)'}`);

  const sections = [
    { path: '/Outlet', maxPages: source.maxOutletPages ?? 40 },
    { path: '/Demoprodukter', maxPages: source.maxDemoPages ?? 65 },
  ];

  const seen = new Set();
  const observations = [];
  let stoppedEarly = false;

  for (const { path, maxPages } of sections) {
    let consecutiveKnownPages = 0;

    for (let page = 1; page <= maxPages; page++) {
      const url =
        page === 1 ? `${BASE_URL}${path}` : `${BASE_URL}${path}?pn=${page}`;

      let html;
      try {
        if (signal?.aborted) break;
        html = await backend.fetchPage(url, signal);
      } catch (err) {
        console.warn(`[proshop] ${path} page ${page} failed: ${err.message}`);
        stoppedEarly = true;
        break;
      }

      const pageObservations = parseProshopPage(html, source, now, seen);
      observations.push(...pageObservations);

      // Count items that are genuinely new (not seen in previous scan).
      const newOnPage = pageObservations.filter((o) => !knownIds.has(o.externalId)).length;
      const withImages = pageObservations.filter((o) => o.imageUrl).length;
      console.log(`[proshop] ${path} page ${page}: ${pageObservations.length} items, ${newOnPage} new, ${withImages} with images`);

      if (pageObservations.length === 0) break; // Page is empty — end of listing

      // Incremental stop: if the entire page consists of already-known items,
      // we've caught up to where the previous scan left off.
      if (incremental.active && newOnPage === 0) {
        consecutiveKnownPages += 1;
        if (consecutiveKnownPages >= incremental.stopPages) {
          console.log(`[proshop] ${path}: ${consecutiveKnownPages} consecutive fully-known pages — stopping early (incremental mode)`);
          stoppedEarly = true;
          break;
        }
      } else {
        consecutiveKnownPages = 0;
      }

      if (page < maxPages) await sleep(pageDelayMs);
    }
  }

  sourceState.lastDiscoveryCount = observations.length;
  // Incremental early-stop means deeper pages were never visited — the result is a
  // partial snapshot, and the scan engine must not prune items missing from it.
  sourceState.lastScanPartial = stoppedEarly;
  console.log(`[proshop] Total: ${observations.length} products${stoppedEarly ? ' (partial — incremental stop)' : ''}`);
  return observations;
}
