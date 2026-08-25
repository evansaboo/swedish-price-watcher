import { chromium } from 'playwright';
import { sleep } from '../lib/utils.js';

/**
 * Shared signed-Algolia-key auth for all Elgiganten sources.
 *
 * Elgiganten's `/api/algolia/signed-api-key` endpoint sits behind Vercel's
 * bot-mitigation ("Vercel Security Checkpoint" / challenge page). The challenge
 * is keyed on the caller's TLS/HTTP fingerprint — NOT on cookies — so any plain
 * `fetch()`/`curl` request (regardless of cookies or headers) is answered with
 * `429 x-vercel-mitigated: challenge`. Replaying cookies harvested from a real
 * browser does NOT help; the request itself must originate from a genuine
 * browser engine.
 *
 * Fix: obtain the key from inside a real (Playwright) Chromium browser. Once we
 * hold the signed key, all product queries go straight to Algolia's DSN
 * (`*-dsn.algolia.net`), which is a plain CDN and is NOT challenge-protected —
 * so the browser is only needed for the (infrequent, cached, ~15-min-lived)
 * key acquisition, not for the actual product scraping.
 *
 * Design notes:
 *   1. One shared, module-level cache across all Elgiganten sources — a single
 *      browser launch serves both `elgiganten-outlet` and `elgiganten-campaigns`.
 *   2. An in-flight guard so parallel sources awaiting a key don't each spawn
 *      their own browser.
 *   3. A direct-fetch nonce flow is kept as a fallback (fast, no browser) in
 *      case Vercel ever relaxes the challenge, and as the unit-testable path.
 *   4. On total failure the thrown error carries `disableHours` so the calling
 *      source cools down (via sourceState.disabledUntil in src/index.js) instead
 *      of relaunching a browser every scan cycle.
 */

const SIGNED_KEY_URL = 'https://www.elgiganten.se/api/algolia/signed-api-key';
const HOMEPAGE_URL = 'https://www.elgiganten.se/';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_AUTH_RETRIES = 2;
const RETRY_BASE_MS = 2000;
const COOLDOWN_HOURS_ON_BLOCK = 2;
// A hard deny is a firewall verdict on our egress IP, not a transient hiccup —
// retrying in minutes cannot clear it and only reinforces it.
const HARD_BLOCK_COOLDOWN_HOURS = Number(process.env.ELGIGANTEN_BLOCK_COOLDOWN_HOURS ?? 6);

const sharedCache = {
  apiKey: null,
  expiry: 0,
  cookies: new Map() // name -> value, replayed across direct-fetch requests
};

// Only one key acquisition runs at a time; concurrent callers await the same promise.
let inFlight = null;

// When Elgiganten hard-denies this IP the whole site is unreachable, so every
// Elgiganten source stands down together instead of each rediscovering the
// block on its own schedule (and relaunching a browser to do so).
let blockedUntil = 0;
let blockDetail = '';

/**
 * Optional egress proxy, used by both the browser and the direct-fetch path.
 * A hard deny is keyed on the caller's IP, so routing Elgiganten traffic
 * through a different exit is the only way to restore access from a blocked
 * host. Format: http://user:pass@host:port
 */
function parseProxy(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return {
      server: `${url.protocol}//${url.host}`,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      url: value
    };
  } catch {
    console.warn(`[elgiganten] Ignoring malformed ELGIGANTEN_PROXY_URL: ${value.slice(0, 40)}`);
    return null;
  }
}

/**
 * Vercel answers a matched firewall rule with 403 + `x-vercel-mitigated: deny`.
 * That is materially different from the 429 challenge this module was built
 * for: a challenge can be solved by presenting a real browser, a deny cannot be
 * solved from the same IP at all — every path, including /robots.txt, is 403.
 */
export function isHardDeny(status, mitigatedHeader) {
  return Number(status) === 403 && String(mitigatedHeader ?? '').toLowerCase() === 'deny';
}

function hardBlockError(logPrefix, detail) {
  const err = new Error(
    `${logPrefix} blocked by Elgiganten (403 deny — ${detail}). ` +
    `Cooling down ${HARD_BLOCK_COOLDOWN_HOURS}h; set ELGIGANTEN_PROXY_URL to use a different egress IP.`
  );
  err.status = 403;
  err.blocked = true;
  err.disableHours = HARD_BLOCK_COOLDOWN_HOURS;
  return err;
}

function noteHardBlock(logPrefix, detail) {
  const wasBlocked = blockedUntil > Date.now();
  blockedUntil = Date.now() + HARD_BLOCK_COOLDOWN_HOURS * 60 * 60_000;
  blockDetail = detail;
  if (!wasBlocked) {
    console.error(
      `${logPrefix} Elgiganten is refusing this IP outright (403 x-vercel-mitigated: deny — ${detail}). ` +
      'Every path is denied, so this is a firewall block on the egress IP, not a bot challenge. ' +
      `Standing all Elgiganten sources down for ${HARD_BLOCK_COOLDOWN_HOURS}h. ` +
      'Set ELGIGANTEN_PROXY_URL to route via another IP to restore access sooner.'
    );
  }
  return hardBlockError(logPrefix, detail);
}

/** Current block state, for surfacing in /api/status and the dashboard. */
export function getElgigantenBlockStatus() {
  const now = Date.now();
  return {
    blocked: blockedUntil > now,
    blockedUntil: blockedUntil > now ? new Date(blockedUntil).toISOString() : null,
    detail: blockedUntil > now ? blockDetail : null,
    proxyConfigured: Boolean(parseProxy(process.env.ELGIGANTEN_PROXY_URL))
  };
}

/** Test seam: clear the shared key cache and the block state. */
export function resetElgigantenAuthState() {
  sharedCache.apiKey = null;
  sharedCache.expiry = 0;
  sharedCache.cookies.clear();
  blockedUntil = 0;
  blockDetail = '';
  inFlight = null;
}

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

/**
 * Node's global fetch has no proxy option, so route through undici's
 * ProxyAgent when a proxy is configured. undici is optional at runtime (it is
 * absent from some production installs), in which case only the browser path —
 * which proxies natively via Playwright — honours the proxy.
 */
let proxyDispatcher;
async function getProxyDispatcher() {
  if (proxyDispatcher !== undefined) return proxyDispatcher;
  const proxy = parseProxy(process.env.ELGIGANTEN_PROXY_URL);
  if (!proxy) {
    proxyDispatcher = null;
    return proxyDispatcher;
  }
  try {
    const { ProxyAgent } = await import('undici');
    proxyDispatcher = new ProxyAgent(proxy.url);
  } catch {
    console.warn('[elgiganten] ELGIGANTEN_PROXY_URL is set but undici is unavailable — direct fetch will not be proxied.');
    proxyDispatcher = null;
  }
  return proxyDispatcher;
}

// ───────────────────────────────────────────────────────────────────────────
// Primary path: fetch the key from inside a real browser (bypasses the Vercel
// fingerprint challenge that blocks plain fetch()).
// ───────────────────────────────────────────────────────────────────────────
async function fetchKeyViaBrowser(logPrefix) {
  const now = Date.now();
  let browser;
  try {
    const proxy = parseProxy(process.env.ELGIGANTEN_PROXY_URL);
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      ...(proxy ? { proxy: { server: proxy.server, username: proxy.username, password: proxy.password } } : {})
    });
    const context = await browser.newContext({ userAgent: BROWSER_UA, locale: 'sv-SE' });
    const page = await context.newPage();

    // Load the homepage first so the signed-api-key request carries a real
    // referer/session — hitting the API cold (no referer) returns Forbidden.
    const nav = await page.goto(HOMEPAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // A denied homepage means the firewall has rejected the IP itself, so the
    // key request would only add a second denied hit. Bail out now.
    if (nav && isHardDeny(nav.status(), nav.headers()['x-vercel-mitigated'])) {
      throw noteHardBlock(logPrefix, `homepage returned ${nav.status()}`);
    }

    // Perform the key fetch from within the page context: the request inherits
    // the browser's TLS fingerprint and same-origin credentials, so Vercel lets
    // it through and the endpoint returns { apiKey } directly (no nonce needed).
    const result = await page.evaluate(async (url) => {
      const res = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'include' });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      return {
        status: res.status,
        apiKey: body?.apiKey ?? null,
        snippet: text.slice(0, 200),
        mitigated: res.headers.get('x-vercel-mitigated')
      };
    }, SIGNED_KEY_URL);

    if (isHardDeny(result.status, result.mitigated)) {
      throw noteHardBlock(logPrefix, `signed-api-key returned ${result.status}`);
    }

    if (!result.apiKey) {
      throw new Error(`no apiKey from browser (status ${result.status}): ${result.snippet}`);
    }
    return cacheAndReturn(result.apiKey, now, logPrefix);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Fallback path: direct fetch() with the nonce-challenge flow. Kept for the
// (unlikely) case Vercel relaxes the challenge, and as the unit-testable path.
// ───────────────────────────────────────────────────────────────────────────
async function attemptDirectFetch(logPrefix) {
  const now = Date.now();
  const baseHeaders = {
    Referer: HOMEPAGE_URL,
    'User-Agent': BROWSER_UA,
    Origin: 'https://www.elgiganten.se'
  };
  const existingCookies = buildCookieHeader();
  const dispatcher = await getProxyDispatcher();

  // Step 1: attempt direct fetch — newer deployments return 200 + apiKey immediately.
  const res1 = await fetch(SIGNED_KEY_URL, {
    headers: existingCookies ? { ...baseHeaders, Cookie: existingCookies } : baseHeaders,
    signal: AbortSignal.timeout(15_000),
    ...(dispatcher ? { dispatcher } : {})
  });
  updateCookieJar(res1.headers.get('set-cookie'));

  if (res1.status === 429) throw rateLimitError(logPrefix, 'fetching signed-api-key', res1);
  if (isHardDeny(res1.status, res1.headers.get('x-vercel-mitigated'))) {
    throw noteHardBlock(logPrefix, `signed-api-key returned ${res1.status}`);
  }

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
    signal: AbortSignal.timeout(15_000),
    ...(dispatcher ? { dispatcher } : {})
  });
  updateCookieJar(res2.headers.get('set-cookie'));

  if (res2.status === 429) throw rateLimitError(logPrefix, 'exchanging nonce for signed-api-key', res2);

  const body2 = await res2.json().catch(() => null);
  if (!body2?.apiKey) throw new Error(`${logPrefix} signed-api-key returned no apiKey: ${JSON.stringify(body2)}`);

  return cacheAndReturn(body2.apiKey, now, logPrefix);
}

async function fetchKeyViaDirectFetch(logPrefix) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_AUTH_RETRIES; attempt++) {
    try {
      return await attemptDirectFetch(logPrefix);
    } catch (err) {
      lastErr = err;
      // A deny is final for this IP — retrying just adds denied requests.
      if (err.blocked) throw err;
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

async function acquireKey(logPrefix) {
  const noBrowser = process.env.ELGIGANTEN_NO_BROWSER === '1';

  // Primary: real browser (bypasses the Vercel fingerprint challenge).
  if (!noBrowser) {
    try {
      return await fetchKeyViaBrowser(logPrefix);
    } catch (err) {
      // The fallback shares this egress IP, so a deny applies to it too.
      if (err.blocked) throw err;
      console.warn(`${logPrefix} browser key fetch failed (${err.message}) — falling back to direct fetch`);
    }
  }

  // Fallback: direct fetch nonce flow (throws with disableHours on persistent 429).
  return await fetchKeyViaDirectFetch(logPrefix);
}

/**
 * Get a signed Algolia API key, reusing the shared cache while valid.
 * `logPrefix` is only used for log line attribution (e.g. '[elgiganten]' or
 * '[elgiganten-campaigns]') — the cache, cooldown, and browser launch are
 * shared regardless.
 */
export async function getSharedAlgoliaApiKey(logPrefix = '[elgiganten]') {
  const now = Date.now();
  if (sharedCache.apiKey && sharedCache.expiry > now + 60_000) {
    return sharedCache.apiKey;
  }

  // While the firewall is denying this IP, fail fast for every Elgiganten
  // source. Launching a browser per source per cycle to be told 403 again is
  // pure cost on a Raspberry Pi, and the extra traffic works against us.
  if (blockedUntil > now) {
    throw hardBlockError(logPrefix, blockDetail);
  }

  // Coalesce concurrent callers onto a single acquisition (one browser launch).
  if (inFlight) return inFlight;
  inFlight = acquireKey(logPrefix).finally(() => { inFlight = null; });
  return inFlight;
}
