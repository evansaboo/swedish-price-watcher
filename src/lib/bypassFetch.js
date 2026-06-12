// ═══════════════════════════════════════════════════════════════
// Cloudflare-bypass fetch backends shared by sources that scrape
// bot-protected sites (ProShop, SweClockers, Dustin).
//
// Priority: FlareSolverr (free, self-hosted) → ScraperAPI → Scrapfly.
// ═══════════════════════════════════════════════════════════════

function buildScraperApiUrl(targetUrl, apiKey, { premium = false, renderJs = true } = {}) {
  const params = new URLSearchParams({
    api_key: apiKey,
    url: targetUrl,
    render: String(renderJs),
    country_code: 'se',
  });
  if (premium) params.set('premium', 'true');
  return `http://api.scraperapi.com?${params}`;
}

function buildScrapflyUrl(targetUrl, apiKey, { renderJs = true } = {}) {
  const params = new URLSearchParams({
    key: apiKey,
    url: targetUrl,
    asp: 'true',
    country: 'se',
  });
  if (renderJs) params.set('render_js', 'true');
  return `https://api.scrapfly.io/scrape?${params}`;
}

export async function scrapeViaScraperApi(url, apiKey, options = {}) {
  const response = await fetch(buildScraperApiUrl(url, apiKey, options), { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ScraperAPI HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.text();
}

export async function scrapeViaScrapfly(url, apiKey, options = {}) {
  const response = await fetch(buildScrapflyUrl(url, apiKey, options), { signal: AbortSignal.timeout(90_000) });
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

export async function scrapeViaFlaresolverr(url, flareSolverrUrl) {
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

/**
 * Pick a bypass backend from the environment and return
 * { label, fetchPage(url) } — or throw a setup error naming all options.
 */
export function resolveBypassBackend(source, options = {}) {
  const flareSolverrUrl = process.env.FLARESOLVERR_URL?.trim() || '';
  const scraperApiKey = process.env.SCRAPERAPI_KEY?.trim() || '';
  const scrapflyKey = process.env.SCRAPFLY_API_KEY?.trim() || '';

  if (flareSolverrUrl) {
    return { label: 'FlareSolverr', fetchPage: (url) => scrapeViaFlaresolverr(url, flareSolverrUrl) };
  }
  if (scraperApiKey) {
    return { label: 'ScraperAPI', fetchPage: (url) => scrapeViaScraperApi(url, scraperApiKey, options) };
  }
  if (scrapflyKey) {
    return { label: 'Scrapfly', fetchPage: (url) => scrapeViaScrapfly(url, scrapflyKey, options) };
  }

  throw new Error(
    `No scraping backend for ${source.label ?? source.id}. ` +
      `Set one of: FLARESOLVERR_URL (self-hosted, free — deploy ghcr.io/flaresolverr/flaresolverr:latest), ` +
      `SCRAPERAPI_KEY (scraperapi.com, 5000 free credits/mo), ` +
      `or SCRAPFLY_API_KEY (scrapfly.io, 1000 free credits/mo).`
  );
}
