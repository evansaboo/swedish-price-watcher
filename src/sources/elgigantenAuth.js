import { sleep } from '../lib/utils.js';

/**
 * Shared signed-Algolia-key auth for all Elgiganten sources.
 *
 * Both elgiganten-outlet and elgiganten-campaigns query the same Algolia
 * index and previously each fetched (and cached) their own signed API key
 * independently, doubling the number of requests we sent to Elgiganten's
 * `/api/algolia/signed-api-key` endpoint. That endpoint sits behind Vercel's
 * bot-mitigation ("Vercel Security Checkpoint" / challenge page) and started
 * intermittently 429-ing our requests — likely tripped in part by the
 * redundant call volume and by every request looking like a fresh, cookie-less
 * visitor.
 *
 * This module fixes both contributing factors:
 *   1. One shared, module-level cache — halves auth request volume.
 *   2. A persisted cookie jar replayed on every request, so repeated calls
 *      look like a continuing session rather than a new anonymous visitor
 *      each time.
 *   3. Retry-with-backoff (honoring Retry-After) on 429 instead of failing
 *      the whole source on the first transient rate limit.
 *   4. On exhausted retries, the thrown error carries `disableHours` so the
 *      calling source cools down (via sourceState.disabledUntil in
 *      src/index.js) instead of hammering the challenge endpoint every scan
 *      cycle, which would only make the block worse.
 */

const SIGNED_KEY_URL = 'https://www.elgiganten.se/api/algolia/signed-api-key';
const MAX_AUTH_RETRIES = 2;
const RETRY_BASE_MS = 2000;
const COOLDOWN_HOURS_ON_BLOCK = 2;

const sharedCache = {
  apiKey: null,
  expiry: 0,
  cookies: new Map() // name -> value, replayed across requests to mimic one continuing session
};

function parseSetCookiePairs(setCookieHeader) {
  // fetch() exposes multiple Set-Cookie values as one comma-joined string via
  // .get(). Split on a comma that's followed by "name=" to avoid splitting
  // inside Expires=<date> values (which also contain commas).
  if (!setCookieHeader) return [];
  return setCookieHeader.split(/,(?=\s*[\w-]+=)/);
}

function updateCookieJar(setCookieHeader) {
  for (const raw of parseSetCookiePairs(setCookieHeader)) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) sharedCache.cookies.set(name, value);
  }
}

function buildCookieHeader() {
  return [...sharedCache.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function cacheAndReturn(apiKey, now, logPrefix) {
  let expiry = now + 10 * 60_000; // default 10 min
  try {
    const decoded = Buffer.from(apiKey, 'base64').toString('utf8');
    const vm = /validUntil=(\d+)/.exec(decoded);
    if (vm) expiry = Number(vm[1]) * 1000;
  } catch { /* keep default */ }
  sharedCache.apiKey = apiKey;
  sharedCache.expiry = expiry;
  console.log(`${logPrefix} Obtained fresh Algolia API key (valid until ${new Date(expiry).toISOString()})`);
  return apiKey;
}

function rateLimitError(logPrefix, step, res) {
  const retryAfterSec = Number(res.headers.get('retry-after'));
  const err = new Error(`${logPrefix} rate-limited (429) ${step}`);
  err.status = 429;
  err.retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : null;
  return err;
}

async function attemptFetch(logPrefix) {
  const now = Date.now();
  const baseHeaders = {
    Referer: 'https://www.elgiganten.se/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    Origin: 'https://www.elgiganten.se'
  };
  const existingCookies = buildCookieHeader();

  // Step 1: attempt direct fetch — newer deployments return 200 + apiKey immediately.
  const res1 = await fetch(SIGNED_KEY_URL, {
    headers: existingCookies ? { ...baseHeaders, Cookie: existingCookies } : baseHeaders,
    signal: AbortSignal.timeout(15_000)
  });
  updateCookieJar(res1.headers.get('set-cookie'));

  if (res1.status === 429) throw rateLimitError(logPrefix, 'fetching signed-api-key', res1);

  let body1 = null;
  try { body1 = await res1.clone().json(); } catch { /* not JSON */ }

  if (res1.ok && body1?.apiKey) {
    return cacheAndReturn(body1.apiKey, now, logPrefix);
  }

  // 401 nonce-challenge path
  const setCookie = res1.headers.get('set-cookie') ?? '';
  const m = /algolia-refresh-nonce=([a-f0-9-]{36})/i.exec(setCookie);
  const nonce = m?.[1] ?? sharedCache.cookies.get('algolia-refresh-nonce') ?? null;
  if (!nonce) {
    const snippet = body1 ? JSON.stringify(body1) : (await res1.text().catch(() => '(unreadable)'));
    throw new Error(`${logPrefix} no apiKey and no nonce (status ${res1.status}): ${snippet.slice(0, 200)}`);
  }

  // Step 2: exchange nonce for signed API key — must send cookie + nonce header
  const res2 = await fetch(SIGNED_KEY_URL, {
    headers: { ...baseHeaders, 'x-algolia-refresh-nonce': nonce, Cookie: buildCookieHeader() },
    signal: AbortSignal.timeout(15_000)
  });
  updateCookieJar(res2.headers.get('set-cookie'));

  if (res2.status === 429) throw rateLimitError(logPrefix, 'exchanging nonce for signed-api-key', res2);

  const body2 = await res2.json().catch(() => null);
  if (!body2?.apiKey) throw new Error(`${logPrefix} signed-api-key returned no apiKey: ${JSON.stringify(body2)}`);

  return cacheAndReturn(body2.apiKey, now, logPrefix);
}

/**
 * Get a signed Algolia API key, reusing the shared cache while valid.
 * `logPrefix` is only used for log line attribution (e.g. '[elgiganten]' or
 * '[elgiganten-campaigns]') — the cache and cooldown are shared regardless.
 */
export async function getSharedAlgoliaApiKey(logPrefix = '[elgiganten]') {
  const now = Date.now();
  if (sharedCache.apiKey && sharedCache.expiry > now + 60_000) {
    return sharedCache.apiKey;
  }

  let lastErr;
  for (let attempt = 0; attempt <= MAX_AUTH_RETRIES; attempt++) {
    try {
      return await attemptFetch(logPrefix);
    } catch (err) {
      lastErr = err;
      if (err.status !== 429 || attempt === MAX_AUTH_RETRIES) break;
      const backoffMs = err.retryAfterMs ?? (RETRY_BASE_MS * (attempt + 1));
      const jitter = Math.round(backoffMs * 0.2 * Math.random());
      console.warn(`${logPrefix} 429 obtaining Algolia key — retrying in ${backoffMs + jitter}ms (attempt ${attempt + 1}/${MAX_AUTH_RETRIES})`);
      await sleep(backoffMs + jitter);
    }
  }

  const finalErr = new Error(lastErr.message);
  if (lastErr.status === 429) finalErr.disableHours = COOLDOWN_HOURS_ON_BLOCK;
  throw finalErr;
}
