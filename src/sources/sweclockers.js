import { load } from 'cheerio';
import { normalizeProductIdentity, parseSekValue } from '../lib/utils.js';

/**
 * SweClockers Dagens Fynd scraper.
 *
 * SweClockers is behind Cloudflare Bot Management. Three bypass strategies are supported —
 * same priority chain as ProShop.
 *
 * Option A — FlareSolverr (FLARESOLVERR_URL) — preferred, free:
 *   Self-hosted real-Chromium bypass. Zero per-request cost.
 *   Deploy ghcr.io/flaresolverr/flaresolverr:latest on Railway.
 *   Set FLARESOLVERR_URL=http://flaresolverr.railway.internal:8080
 *
 * Option B — Scrapfly (SCRAPFLY_API_KEY) — fallback:
 *   1000 free credits/month. asp + render_js = ~10 credits/page.
 *
 * Option C — ScraperAPI (SCRAPERAPI_KEY) — fallback:
 *   5000 free credits/month. render=true = 5 credits/page.
 *
 * Page structure (as of 2025):
 *   <div class="tips-row">
 *     <a class="col-wrapper cell-product" href="<product-url>">
 *       <div class="col-product-inner-wrapper">Title</div>
 *       <div class="col-category">Category</div>
 *       <div class="col-vendor">Vendor</div>
 *       <div class="col-price">999 kr</div>
 *     </a>
 *     <a class="col-wrapper cell-user" href="/forum/post/<postId>">
 *       <div class="col-user">@username</div>
 *       <div class="col-score"><span class="label">+24</span></div>
 *     </a>
 *   </div>
 *
 * The forum post ID is used as externalId since each deal is tied to a unique post.
 */

const SWEC_BASE = 'https://www.sweclockers.com';
const DAGENSFYND_URL = `${SWEC_BASE}/dagensfynd`;

function buildScrapflyUrl(targetUrl, apiKey) {
  const params = new URLSearchParams({
    key: apiKey,
    url: targetUrl,
    asp: 'true',
    render_js: 'true',
    country: 'se',
  });
  return `https://api.scrapfly.io/scrape?${params}`;
}

function buildScraperApiUrl(targetUrl, apiKey) {
  const params = new URLSearchParams({
    api_key: apiKey,
    url: targetUrl,
    render: 'true',
    country_code: 'se',
  });
  return `http://api.scraperapi.com?${params}`;
}

async function fetchViaFlaresolverr(url, flareSolverrUrl) {
  const response = await fetch(`${flareSolverrUrl}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 90_000 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`FlareSolverr HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  if (data.status !== 'ok') {
    throw new Error(`FlareSolverr error: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.solution?.response ?? '';
}

async function fetchViaScrapfly(url, apiKey) {
  const apiUrl = buildScrapflyUrl(url, apiKey);
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

async function fetchViaScraperApi(url, apiKey) {
  const apiUrl = buildScraperApiUrl(url, apiKey);
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ScraperAPI HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.text();
}

function parseSweclockersPage(html, source, now) {
  const $ = load(html);
  const observations = [];
  const seen = new Set();

  $('div.tips-row').each((_, row) => {
    const productLink = $(row).find('a.cell-product').first();
    const userLink = $(row).find('a.cell-user').first();

    const productUrl = productLink.attr('href') || '';
    const title = productLink.find('.col-product-inner-wrapper').text().trim();
    const category = productLink.find('.col-category').text().trim() || 'Övrigt';
    const vendor = productLink.find('.col-vendor').text().trim();
    const priceText = productLink.find('.col-price').text().trim();

    const postHref = userLink.attr('href') || '';
    const postIdMatch = postHref.match(/\/forum\/post\/(\d+)/);
    const postId = postIdMatch ? postIdMatch[1] : '';
    const scoreText = userLink.find('.col-score .label').text().trim();
    const score = parseInt(scoreText.replace(/[^0-9-]/g, ''), 10) || 0;

    if (!title || !productUrl) return;

    const price = parseSekValue(priceText);
    if (price == null) return;

    // Use forum post ID as external ID (stable per deal), fall back to URL hash
    const externalId = postId || `swec-${Buffer.from(productUrl).toString('base64').slice(0, 16)}`;
    if (seen.has(externalId)) return;
    seen.add(externalId);

    const forumUrl = postId ? `${SWEC_BASE}/forum/post/${postId}` : null;

    observations.push({
      sourceId: source.id,
      sourceLabel: source.label ?? source.id,
      sourceType: source.type,
      externalId,
      title,
      url: productUrl.startsWith('http') ? productUrl : `${SWEC_BASE}${productUrl}`,
      productKey: normalizeProductIdentity(title),
      priceSek: price,
      referencePriceSek: null,
      marketValueSek: null,
      imageUrl: null,
      // vendor stored as extra metadata via category label
      category: mapSwecCategory(category),
      condition: 'deal',
      conditionLabel: 'Dagens Fynd',
      availability: 'in_stock',
      seenAt: now,
      // SweClockers-specific extras
      vendor: vendor || null,
      communityScore: score,
      dealSourceUrl: forumUrl,
    });
  });

  return observations;
}

/** Map SweClockers Swedish category names to our canonical categories. */
function mapSwecCategory(swecCat) {
  const cat = swecCat.toLowerCase().trim();
  if (cat.includes('grafik') || cat.includes('gpu')) return 'Grafikkort (GPU)';
  if (cat.includes('processor') || cat.includes('cpu')) return 'Processorer';
  if (cat.includes('moderkort')) return 'Moderkort';
  if (cat.includes('minne') || cat.includes('ram')) return 'Minne';
  if (cat.includes('lagring') || cat.includes('ssd') || cat.includes('hdd')) return 'Lagring';
  if (cat.includes('chassi') || cat.includes('case')) return 'Chassin';
  if (cat.includes('nätverk') || cat.includes('router')) return 'Nätverk';
  if (cat.includes('dator') || cat.includes('laptop') || cat.includes('bärbar')) return 'Datorer';
  if (cat.includes('skärm') || cat.includes('monitor')) return 'Skärmar';
  if (cat.includes('headset') || cat.includes('hörlurar') || cat.includes('ljud')) return 'Ljud & Hörlurar';
  if (cat.includes('tangentbord') || cat.includes('mus')) return 'Periferi';
  if (cat.includes('kyla') || cat.includes('kylning')) return 'Kylning';
  if (cat.includes('strömförsörjning') || cat.includes('psu')) return 'Strömförsörjning';
  if (cat.includes('tv') || cat.includes('bild')) return 'TV & Bild';
  if (cat.includes('mobil') || cat.includes('telefon')) return 'Mobiler';
  if (cat.includes('konsol') || cat.includes('gaming')) return 'Gaming';
  return swecCat || 'Övrigt';
}

export async function collectFromSweclockers({ source, sourceState, now }) {
  const flareSolverrUrl = process.env.FLARESOLVERR_URL?.trim() || '';
  const scrapflyKey =
    (source.apiTokenEnvVar === 'SCRAPFLY_API_KEY' ? process.env.SCRAPFLY_API_KEY : null)?.trim() ||
    process.env.SCRAPFLY_API_KEY?.trim() ||
    '';
  const scraperApiKey =
    (source.apiTokenEnvVar === 'SCRAPERAPI_KEY' ? process.env.SCRAPERAPI_KEY : null)?.trim() ||
    process.env.SCRAPERAPI_KEY?.trim() ||
    '';

  const useFlaresolverr = Boolean(flareSolverrUrl);
  const useScrapfly = !useFlaresolverr && Boolean(scrapflyKey);
  const useScraperApi = !useFlaresolverr && !useScrapfly && Boolean(scraperApiKey);

  if (!useFlaresolverr && !useScrapfly && !useScraperApi) {
    throw new Error(
      `No scraping backend for ${source.label ?? source.id}. ` +
        `Set one of: FLARESOLVERR_URL (self-hosted, free — deploy ghcr.io/flaresolverr/flaresolverr:latest), ` +
        `SCRAPFLY_API_KEY (scrapfly.io, 1000 free credits/mo), ` +
        `or SCRAPERAPI_KEY (scraperapi.com, 5000 free credits/mo).`
    );
  }

  const backendLabel = useFlaresolverr ? 'FlareSolverr' : useScrapfly ? 'Scrapfly' : 'ScraperAPI';
  console.log(`[sweclockers] Using ${backendLabel}`);

  let html;
  try {
    if (useFlaresolverr) html = await fetchViaFlaresolverr(DAGENSFYND_URL, flareSolverrUrl);
    else if (useScrapfly) html = await fetchViaScrapfly(DAGENSFYND_URL, scrapflyKey);
    else html = await fetchViaScraperApi(DAGENSFYND_URL, scraperApiKey);
  } catch (err) {
    throw new Error(`[sweclockers] Failed to fetch page via ${backendLabel}: ${err.message}`);
  }

  if (!html || html.length < 1000) {
    throw new Error(`[sweclockers] Response too short (${html?.length ?? 0} chars) — likely blocked`);
  }

  const observations = parseSweclockersPage(html, source, now);
  sourceState.lastDiscoveryCount = observations.length;
  console.log(`[sweclockers] Scraped ${observations.length} deals`);
  return observations;
}
