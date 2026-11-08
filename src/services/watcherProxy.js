/**
 * Shared proxy-first HTTP fetcher for the store watchers (Webhallen, Inet,
 * Komplett demo).
 *
 * Security / IP rule: NEVER fetch a watched store from the Pi's home IP.
 * Every request in this module requires an explicit upstream proxy URL
 * (`http(s)://` or `socks5://`) and routes through `undici.ProxyAgent` (plus
 * `startSocksHttpBridge` when the upstream is SOCKS). When a proxy fetch
 * succeeds, the watcher run costs $0.00 on Apify; when no proxy is configured
 * or the proxy is blocked/unreachable, the caller falls back to Apify.
 */

import { ProxyAgent } from 'undici';
import { parseSocksUrl, startSocksHttpBridge } from './socksBridge.js';

export const DEFAULT_WATCHER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const ZERO_COST_MODEL = Object.freeze({ perRunUsd: 0, perUrlUsd: 0 });

const DISABLED_VALUES = new Set(['off', 'none', 'false', '0', 'disabled']);
const dispatcherCache = new Map();

/**
 * Resolve the proxy URL for a watcher store (`'WEBHALLEN'`, `'INET'`, `'KOMPLETT'`).
 *
 * Precedence:
 *  1. `<STORE>_PROXY_URL` (set to `'off'`/`'none'` to force Apify-only for that store)
 *  2. `WATCHER_PROXY_URL` (shared proxy for all watchers)
 *  3. For `'WEBHALLEN'`, `ELGIGANTEN_PROXY_URL` (NordVPN SOCKS5 works for
 *     Webhallen's JSON API at $0 cost).
 */
export function resolveWatcherProxyUrl(storePrefix, env = process.env) {
  const prefix = String(storePrefix ?? '').trim().toUpperCase();
  const specific = String(env?.[`${prefix}_PROXY_URL`] ?? '').trim();
  if (specific && DISABLED_VALUES.has(specific.toLowerCase())) return '';
  if (specific) return specific;

  const shared = String(env?.WATCHER_PROXY_URL ?? '').trim();
  if (shared && DISABLED_VALUES.has(shared.toLowerCase())) return '';
  if (shared) return shared;

  if (prefix === 'WEBHALLEN') {
    const elgiganten = String(env?.ELGIGANTEN_PROXY_URL ?? '').trim();
    if (elgiganten && !DISABLED_VALUES.has(elgiganten.toLowerCase())) return elgiganten;
  }
  return '';
}

/**
 * Validate and build (or reuse) an undici `ProxyAgent` for `proxyUrl`.
 * Throws if `proxyUrl` is missing or not an HTTP(S)/SOCKS URL so callers can
 * never accidentally fall through to an unproxied host-IP fetch.
 */
export async function getProxyDispatcher(proxyUrl, { logger = console } = {}) {
  const raw = String(proxyUrl ?? '').trim();
  if (!raw) throw new Error('Refusing to fetch without a proxy URL');

  let cached = dispatcherCache.get(raw);
  if (!cached) {
    cached = (async () => {
      if (raw.startsWith('socks')) {
        const socks = parseSocksUrl(raw);
        if (!socks) throw new Error(`Invalid SOCKS proxy URL: ${raw.slice(0, 32)}`);
        const bridge = await startSocksHttpBridge(raw, { unref: true, logger });
        return new ProxyAgent(bridge.url);
      }
      let parsed;
      try {
        parsed = new URL(raw);
      } catch {
        throw new Error(`Invalid proxy URL: ${raw.slice(0, 32)}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Unsupported proxy protocol "${parsed.protocol}"`);
      }
      return new ProxyAgent(raw);
    })().catch((error) => {
      dispatcherCache.delete(raw);
      throw error;
    });
    dispatcherCache.set(raw, cached);
  }
  return cached;
}

/**
 * Fetch one URL strictly through `proxyUrl`. Never touches the host's direct
 * egress if `proxyUrl` is missing or invalid.
 */
export async function fetchViaWatcherProxy(url, {
  proxyUrl,
  headers = {},
  timeoutMs = 20_000,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const cleanProxy = String(proxyUrl ?? '').trim();
  if (!cleanProxy) throw new Error('Refusing to fetch without a proxy URL');

  const requestHeaders = {
    'user-agent': DEFAULT_WATCHER_USER_AGENT,
    'accept-language': 'sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7',
    ...headers,
  };

  const init = {
    headers: requestHeaders,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (fetchImpl === fetch) {
    init.dispatcher = await getProxyDispatcher(cleanProxy, { logger });
  } else {
    init.proxyUrl = cleanProxy;
  }

  const response = await fetchImpl(url, init);
  const body = await response.text();
  return {
    statusCode: response.status,
    ok: response.ok,
    url,
    loadedUrl: response.url || url,
    body,
  };
}

/** Run async worker over `items` with bounded concurrency, preserving order. */
export async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
  let nextIndex = 0;

  await Promise.all(Array.from({ length: limit }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) break;
      results[index] = await worker(list[index], index);
    }
  }));

  return results;
}
