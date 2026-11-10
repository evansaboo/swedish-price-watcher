import {
  fetchViaWatcherProxy,
  resolveWatcherProxyUrl,
} from '../services/watcherProxy.js';
import { INET_FEEDS } from './inet.js';

// ═══════════════════════════════════════════════════════════════
// Inet's official agent API (linked from https://www.inet.se/robots.txt and
// described in https://www.inet.se/llms.txt): an unauthenticated REST API for
// guests. Since 2026-11-10 Cloudflare refuses the HTML pages to Apify's
// datacenter and residential IPs and to NordVPN, but serves this API.
//
// Every request goes through the watcher proxy (NordVPN by default), never the
// Pi's home IP. One check sweeps every list page of both feeds, one request at
// a time with a pause between them, and stops a feed on a 429.
// ═══════════════════════════════════════════════════════════════

const AGENT_BASE = 'https://www.inet.se/agent/guest/v1';
export const INET_AGENT_USER_AGENT = 'swedish-price-watcher/1.0 (personal price alerts)';

const FEED_ENDPOINTS = Object.freeze({
  deals: { path: '/campaigns/products', listKey: 'products' },
  outlet: { path: '/bargains/products', listKey: 'bargains' },
});

/** The API serves 10 items a page; the cap bounds a sweep if a feed balloons. */
export const INET_AGENT_MAX_PAGES = 60;
/** `products/lookup` takes 1 to 10 ids (its 400 error says so). */
export const INET_AGENT_LOOKUP_BATCH = 10;
export const INET_AGENT_REQUEST_GAP_MS = 700;

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class InetAgentHttpError extends Error {
  constructor(url, statusCode) {
    super(`Inet agent API answered ${statusCode} for ${url.replace(AGENT_BASE, '')}`);
    this.statusCode = statusCode;
  }
}

function requireProxy(proxyUrl) {
  const clean = String(proxyUrl ?? '').trim();
  if (!clean) {
    throw new Error('No proxy for Inet (INET_PROXY_URL, WATCHER_PROXY_URL or ELGIGANTEN_PROXY_URL); refusing to call inet.se from the home IP.');
  }
  return clean;
}

async function getJson(url, { proxyUrl, proxyFetch, logger }) {
  const res = await proxyFetch(url, {
    proxyUrl,
    headers: { accept: 'application/json', 'user-agent': INET_AGENT_USER_AGENT },
    logger,
  });
  if (res.statusCode !== 200) throw new InetAgentHttpError(url, res.statusCode);
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error(`Inet agent API returned non-JSON for ${url.replace(AGENT_BASE, '')}`);
  }
}

function slugFromUrl(url) {
  const match = String(url ?? '').match(/\/produkt\/[^/]+\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

/**
 * Map one API list item to the compact product shape the HTML scraper
 * produced, so `mapInetProduct` and the poller stay unchanged. The API has no
 * category: `templateId` is filled in later (see inetTemplates.js).
 */
export function mapAgentListItem(item, feedId) {
  if (!item || typeof item !== 'object' || item.productId == null) return null;
  const pickupStores = Array.isArray(item.pickupStores) ? item.pickupStores : [];
  const condition = typeof item.condition === 'string' ? item.condition : null;
  return {
    id: String(item.productId),
    name: typeof item.name === 'string' ? item.name.slice(0, 300) : null,
    urlName: slugFromUrl(item.url),
    image: null,
    templateId: null,
    categoryId: null,
    manufacturerId: null,
    listPrice: finiteOrNull(item.ordinaryPriceIncVat),
    price: finiteOrNull(item.priceIncVat),
    // The API only says yes/no for web stock; outlet units are listed per store.
    webQty: item.inWebStock === true ? 1 : 0,
    webBlocked: false,
    storeQty: pickupStores.length,
    sellingPoint: feedId === 'outlet' ? condition : null,
    isBargain: feedId === 'outlet',
    bargainParentId: item.parentProductId == null ? null : String(item.parentProductId),
    releaseDate: null,
    purchaseStatus: null,
    campaignEndsAt: typeof item.campaignEndsAt === 'string' ? item.campaignEndsAt : null,
  };
}

/**
 * Sweep every list page of one feed. Returns one aggregated page in the shape
 * `applyInetPages` reads. `productIds` is only set when every page loaded, so a
 * partial sweep never counts listed items as gone.
 */
async function sweepFeed(feedId, { proxyUrl, proxyFetch, logger, gapMs, sleep }) {
  const endpoint = FEED_ENDPOINTS[feedId];
  const products = new Map();
  let total = null;
  let pageSize = null;
  let expectedPages = 1;
  let fetchedPages = 0;
  let error = null;

  for (let page = 1; page <= expectedPages; page += 1) {
    if (page > 1) await sleep(gapMs);
    const url = `${AGENT_BASE}${endpoint.path}?page=${page}`;
    let body;
    try {
      body = await getJson(url, { proxyUrl, proxyFetch, logger });
    } catch (err) {
      error = err.message;
      // A 429 means slow down: stop this feed rather than keep asking.
      break;
    }
    const items = Array.isArray(body?.[endpoint.listKey]) ? body[endpoint.listKey] : [];
    if (page === 1) {
      total = Number.isFinite(body?.totalCount) ? body.totalCount : items.length;
      pageSize = Number(body?.pageSize) > 0 ? Number(body.pageSize) : Math.max(items.length, 1);
      expectedPages = Math.min(INET_AGENT_MAX_PAGES, Math.max(1, Math.ceil(total / pageSize)));
    }
    fetchedPages += 1;
    for (const item of items) {
      const compact = mapAgentListItem(item, feedId);
      // Items can shift between pages while the sweep runs: keep the first.
      if (compact && !products.has(compact.id)) products.set(compact.id, compact);
    }
  }

  const base = {
    feed: feedId,
    page: 1,
    url: `${AGENT_BASE}${endpoint.path}`,
    loadedUrl: null,
    statusCode: fetchedPages ? 200 : null,
    source: 'agent',
    agentPagesExpected: expectedPages,
    agentPagesFetched: fetchedPages,
  };
  if (!fetchedPages) return { ...base, found: false, error, title: null };

  const complete = fetchedPages === expectedPages && !(total > expectedPages * pageSize);
  if (!complete) {
    logger.warn?.(`[inet] ${INET_FEEDS[feedId].label}: ${fetchedPages}/${expectedPages} agent pages loaded${error ? ` (${error})` : ''}.`);
  }
  const list = [...products.values()];
  return {
    ...base,
    found: true,
    // One aggregated page: sized so the poller expects exactly this one page.
    pageSize: Math.max(total ?? 0, list.length, 1),
    total: complete ? list.length : total,
    products: list,
    ...(complete ? { productIds: list.map((p) => p.id) } : {}),
    templates: [],
    partial: !complete,
    error: complete ? null : error,
  };
}

/**
 * Fetch both feeds from the agent API. Same contract as `fetchInetPages`
 * (`{ run, pages, urls }`), at $0: there is no Apify run.
 */
export async function fetchInetAgentPages({
  feeds,
  proxyUrl = resolveWatcherProxyUrl('INET'),
  proxyFetch = fetchViaWatcherProxy,
  logger = console,
  gapMs = INET_AGENT_REQUEST_GAP_MS,
  sleep = sleepFor,
} = {}) {
  const planned = (Array.isArray(feeds) ? feeds : []).filter((feed) => FEED_ENDPOINTS[feed?.id]);
  if (!planned.length) throw new Error('No Inet feeds enabled.');
  const proxy = requireProxy(proxyUrl);
  const startedAtMs = Date.now();

  const pages = [];
  for (const [index, feed] of planned.entries()) {
    if (index > 0) await sleep(gapMs);
    pages.push(await sweepFeed(feed.id, { proxyUrl: proxy, proxyFetch, logger, gapMs, sleep }));
  }

  return {
    source: 'agent',
    run: {
      id: null,
      status: 'PROXY',
      usageTotalUsd: 0,
      runTimeSecs: Math.round((Date.now() - startedAtMs) / 100) / 10,
    },
    pages,
    urls: pages.reduce((sum, page) => sum + (page.agentPagesFetched ?? 0), 0),
  };
}

/**
 * Product details (with specifications) for `ids`, in batches of 10.
 * Returns `{ products: Map<id, detail>, notFound: Set<id>, failed: Set<id> }`;
 * ids in `failed` were not answered (error or 429) and can be retried later.
 */
export async function lookupInetAgentProducts(ids, {
  proxyUrl = resolveWatcherProxyUrl('INET'),
  proxyFetch = fetchViaWatcherProxy,
  logger = console,
  gapMs = INET_AGENT_REQUEST_GAP_MS,
  sleep = sleepFor,
} = {}) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  const products = new Map();
  const notFound = new Set();
  const failed = new Set();
  if (!unique.length) return { products, notFound, failed };
  const proxy = requireProxy(proxyUrl);

  for (let i = 0; i < unique.length; i += INET_AGENT_LOOKUP_BATCH) {
    const batch = unique.slice(i, i + INET_AGENT_LOOKUP_BATCH);
    if (i > 0) await sleep(gapMs);
    const url = `${AGENT_BASE}/products/lookup?ids=${batch.map(encodeURIComponent).join(',')}`;
    try {
      const body = await getJson(url, { proxyUrl: proxy, proxyFetch, logger });
      for (const detail of Array.isArray(body?.products) ? body.products : []) {
        if (detail?.productId != null) products.set(String(detail.productId), detail);
      }
      for (const id of Array.isArray(body?.notFound) ? body.notFound : []) notFound.add(String(id));
      for (const id of batch) if (!products.has(id) && !notFound.has(id)) notFound.add(id);
    } catch (error) {
      logger.warn?.(`[inet] Product lookup failed: ${error.message}`);
      for (const id of unique.slice(i)) failed.add(id);
      break;
    }
  }
  return { products, notFound, failed };
}
