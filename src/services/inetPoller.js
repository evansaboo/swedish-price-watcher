/**
 * Inet watcher: campaign deals (/kampanjer) and the Fyndhörnan outlet.
 *
 * Modelled on the Komplett demo watcher (komplettDemoPoller.js):
 *  - every check sweeps every page of both feeds (Inet has no newest-first
 *    sort) through Inet's official agent API (sources/inetAgent.js), over the
 *    watcher proxy, never from the home IP. Since 2026-11-10 Cloudflare
 *    refuses the HTML pages to Apify and NordVPN, so the old Apify scraper
 *    (sources/inet.js) is no longer the default. The agent API has no
 *    categories; inetTemplates.js works them out from product specifications,
 *  - the delay is randomised (default 20 min ±40%) with a 10-minute floor,
 *  - failures back off exponentially up to 60 minutes,
 *  - a cost guard stretches the interval when this month's projected Apify
 *    spend would pass the cap (default $1.5).
 *
 * What to alert on comes from watch groups (keywords, Inet template
 * categories, discount/price/stock filters), like the Elgiganten hotlist.
 * Alerts: a matching item that is new, dropped in price by the group's (or
 * the global) %, or came back in stock. Between sweeps, a fast check every
 * ~2 minutes looks up only the tracked items the watch groups cover (about
 * 9 requests instead of 80), so price drops and restocks arrive sooner; new
 * items still need a sweep, since they can appear on any page. A feed or group seeds silently the
 * first time it is checked, and one product matching several groups gets one
 * alert naming them all.
 *
 * State lives in its own SQLite record ('inet') so a restart never re-alerts;
 * every tracked item is mirrored into the main listing (inetListing.js).
 */

import {
  INET_FEEDS,
  INET_MAX_PAGES_PER_FEED,
  INET_PAGE_SIZE,
  buildInetFeedUrl,
  fetchApifyRunUsage,
  fetchInetPages,
  inetPagesFor,
  mapInetProduct,
} from '../sources/inet.js';
import { fetchInetAgentPages, lookupInetAgentProducts } from '../sources/inetAgent.js';
import { resolveInetTemplates } from './inetTemplates.js';
import {
  computeCostGuard,
  computeNextDelayMs,
  estimateRunUsd,
  rollUsageMonth,
} from './komplettDemoPoller.js';
import {
  enabledFeedIds,
  groupCoversFeed,
  isGroupActive,
  normalizeInetConfig,
} from './inetConfig.js';
import {
  ZERO_COST_MODEL,
  resolveWatcherProxyUrl,
} from './watcherProxy.js';

export const MIN_DELAY_MS = 30 * 1000;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;
// Between full sweeps, Page-1 delta checks fetch only Page 1 (which carries all
// productIds) plus any page whose slice contains an unseen product id.
export const FULL_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const MAX_ALERTS_PER_POLL = 25;
// The fast check of watched items (agent API only), ±25%.
export const FAST_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const FAST_CHECK_JITTER = 0.25;
// 15 lookup requests at most per fast check.
export const MAX_FAST_CHECK_IDS = 150;
export const MAX_ALERT_ATTEMPTS = 3;
const MAX_RECENT_ALERTS = 30;
const MAX_PENDING_ALERTS = 25;
const MAX_PRODUCTS = 5000;
const PRODUCT_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;
// Gone after this many consecutive complete sweeps without the item.
export const MISSES_BEFORE_GONE = 2;
// Page-count guess for the cost guard before a feed's size is known.
const UNKNOWN_FEED_PAGES = 6;

/**
 * Initial per-run cost model; the guard rescales it to this month's real runs
 * after three of them (see estimateRunUsd). A 5-URL Inet run cost ~$0.0004 on
 * 2026-11-05; Inet pages (60 products) are heavier than Komplett's.
 */
export const INET_COST_MODEL = Object.freeze({ perRunUsd: 0.00028, perUrlUsd: 0.00006 });

export function createEmptyInetState() {
  return {
    version: 1,
    products: {},
    feedStats: {},
    feedIds: {},
    seededFeeds: {},
    seededGroups: {},
    catalog: {},
    recentAlerts: [],
    pendingAlerts: [],
    usage: { month: null, usd: 0, runs: 0, urls: 0 },
    pendingUsageRun: null,
    lastRun: null,
    // 'agent' once checks come from the agent API (see runPoll).
    source: null,
    // Category resolution for agent products (inetTemplates.js).
    templateCache: {},
    templateSignatures: {},
    templateSamplesTried: {},
  };
}

const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

export function normalizeInetState(raw) {
  const input = plainObject(raw);
  const empty = createEmptyInetState();
  const usage = plainObject(input.usage);
  return {
    ...empty,
    products: plainObject(input.products),
    feedStats: plainObject(input.feedStats),
    feedIds: plainObject(input.feedIds),
    seededFeeds: plainObject(input.seededFeeds),
    seededGroups: plainObject(input.seededGroups),
    catalog: plainObject(input.catalog),
    recentAlerts: Array.isArray(input.recentAlerts) ? input.recentAlerts.slice(0, MAX_RECENT_ALERTS) : [],
    pendingAlerts: Array.isArray(input.pendingAlerts) ? input.pendingAlerts.slice(0, MAX_PENDING_ALERTS) : [],
    usage: {
      month: typeof usage.month === 'string' ? usage.month : null,
      usd: Number.isFinite(usage.usd) ? usage.usd : 0,
      runs: Number.isFinite(usage.runs) ? usage.runs : 0,
      urls: Number.isFinite(usage.urls) ? usage.urls : 0,
    },
    pendingUsageRun: input.pendingUsageRun && typeof input.pendingUsageRun === 'object' ? input.pendingUsageRun : null,
    lastRun: input.lastRun && typeof input.lastRun === 'object' ? input.lastRun : null,
    source: typeof input.source === 'string' ? input.source : null,
    templateCache: plainObject(input.templateCache),
    templateSignatures: plainObject(input.templateSignatures),
    templateSamplesTried: plainObject(input.templateSamplesTried),
  };
}

// ── Matching ───────────────────────────────────────────────────

/** Lower-case, diacritics stripped ("Skärm" → "skarm"). */
export function foldText(value) {
  return String(value ?? '')
    // NFKD would turn "RTX™" into "RTXTM"; trademark signs are just noise.
    .replace(/[™®©℠]/g, ' ')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss');
}

/**
 * Word tokens, also split where letters meet digits, so "RTX5090",
 * "RTX 5090" and "rtx-5090" all give [rtx, 5090] and "32GB" gives [32, gb].
 */
export function matchTokens(value) {
  const runs = foldText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
  return runs.flatMap((run) => run.match(/\p{N}+|\p{L}+/gu) ?? []);
}

const TIER_WORDS = new Set(['pro', 'air', 'max', 'plus', 'ultra', 'mini', 'neo', 'slim', 'ti', 'xt', 'super', 'fe']);
const UNIT_WORDS = new Set(['gb', 'tb', 'mb', 'g', 'w', 'hz', 'mhz', 'ghz', 'mm', 'cm', 'tum', 'inch']);
const MODEL_PREFIXES = new Set(['rtx', 'gtx', 'rx', 'arc', 'playstation', 'ps', 'xbox', 'switch', 'iphone', 'galaxy', 'pixel', 'ryzen', 'core']);

const isAlphaToken = (t) => /^\p{L}+$/u.test(t);
const isNumericToken = (t) => /^\p{N}+$/u.test(t);

/**
 * Group a keyword's tokens into contiguous phrase segments so model names and
 * tier suffixes stay bound together ("macbook pro" → [[macbook, pro]],
 * "iphone 16 pro" → [[iphone, 16, pro]], "iPad Air 11" → [[ipad, air], [11]],
 * "DDR5 32 GB" → [[ddr, 5], [32, gb]]). Prevents a chip/accessory modifier
 * elsewhere in the title ("MacBook Neo 13 A18 Pro", "iPad mini A17 Pro",
 * "Razer V2 PRO Wireless PS5") from satisfying a model keyword.
 */
export function keywordPhraseSegments(keyword) {
  const rawWords = foldText(keyword).trim().split(/\s+/).filter(Boolean);
  const segments = [];
  for (const raw of rawWords) {
    const tokens = matchTokens(raw);
    if (!tokens.length) continue;
    if (!segments.length) {
      segments.push(tokens);
      continue;
    }
    const prev = segments[segments.length - 1];
    const a = prev[prev.length - 1];
    const b = tokens[0];
    const shouldMerge =
      (isAlphaToken(a) && isAlphaToken(b)) ||
      TIER_WORDS.has(b) ||
      (isNumericToken(a) && tokens.length === 1 && UNIT_WORDS.has(b)) ||
      (MODEL_PREFIXES.has(a) && isNumericToken(b) && tokens.length === 1);
    if (shouldMerge) {
      prev.push(...tokens);
    } else {
      segments.push(tokens);
    }
  }
  return segments;
}

function containsTokenSequence(haystack, needle) {
  if (needle.length > haystack.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

const titleCache = new Map();
function titleIndex(title) {
  const key = String(title ?? '');
  let entry = titleCache.get(key);
  if (!entry) {
    const list = matchTokens(key);
    entry = { list, tokens: new Set(list), compact: list.join('') };
    if (titleCache.size > 20_000) titleCache.clear();
    titleCache.set(key, entry);
  }
  return entry;
}

/**
 * Strict: every keyword phrase segment matches whole tokens of the title in
 * sequence ("macbook pro" doesn't match "MacBook Neo 13 A18 Pro", "RTX 5090"
 * doesn't match an RTX 4090 with a "5090mm" spec, "ram" doesn't match
 * "ramverk"). Loose: every keyword word appears anywhere in the title.
 * Both are case- and diacritic-insensitive.
 */
export function keywordMatchesTitle(keyword, title, { strict = true } = {}) {
  const words = matchTokens(keyword);
  if (!words.length) return false;
  const index = titleIndex(title);
  if (!strict) {
    return words.every((word) => index.compact.includes(word));
  }
  if (!words.every((word) => index.tokens.has(word))) return false;
  const segments = keywordPhraseSegments(keyword);
  return segments.every((seg) => (seg.length === 1 ? index.tokens.has(seg[0]) : containsTokenSequence(index.list, seg)));
}

/** Does the product fall in what the group watches (feed, keywords, categories)? */
export function groupScopeMatches(group, product) {
  if (!groupCoversFeed(group, product.feed)) return false;
  if (group.categories?.length && !group.categories.includes(String(product.templateId ?? ''))) return false;
  if (group.keywords?.length
    && !group.keywords.some((keyword) => keywordMatchesTitle(keyword, product.title, { strict: group.strictKeywordMatch !== false }))) {
    return false;
  }
  return true;
}

/** The group's value filters on the product's current price, discount and stock. */
export function groupFiltersMatch(group, product) {
  if ((group.minDiscountPct ?? 0) > 0 && !((product.discountPct ?? 0) >= group.minDiscountPct)) return false;
  if (group.maxPriceSek && !(product.priceSek > 0 && product.priceSek <= group.maxPriceSek)) return false;
  if (group.inStockOnly && !product.inStock) return false;
  return true;
}

export function groupMatches(group, product) {
  return isGroupActive(group) && groupScopeMatches(group, product) && groupFiltersMatch(group, product);
}

// ── Diffing ────────────────────────────────────────────────────

function isAvailable(record) {
  return (record.inStock ?? record.inWebStock) === true && !record.missingSince;
}

function productFields(product) {
  return {
    title: product.title,
    url: product.url,
    imageUrl: product.imageUrl,
    priceSek: product.priceSek,
    listPriceSek: product.listPriceSek,
    discountPct: product.discountPct,
    webQty: product.webQty,
    inWebStock: product.inWebStock,
    storeQty: product.storeQty,
    inStock: product.inStock,
    purchaseStatus: product.purchaseStatus,
    templateId: product.templateId,
    categoryId: product.categoryId,
    manufacturerId: product.manufacturerId,
    sellingPoint: product.sellingPoint,
    bargainParentId: product.bargainParentId,
    releaseDate: product.releaseDate,
  };
}

function updateCatalog(state, feedId, templates, nowIso) {
  if (!Array.isArray(templates)) return;
  const seen = new Set();
  for (const template of templates) {
    const id = String(template?.id ?? '').trim();
    if (!/^\d+$/.test(id)) continue;
    seen.add(id);
    const existing = plainObject(state.catalog[id]);
    state.catalog[id] = {
      id,
      name: (typeof template.name === 'string' && template.name.trim()) || existing.name || null,
      counts: { ...plainObject(existing.counts), [feedId]: Number.isFinite(template.facetCount) ? template.facetCount : 0 },
      lastSeenAt: nowIso,
    };
  }
  for (const [id, entry] of Object.entries(state.catalog)) {
    if (!seen.has(id) && entry?.counts?.[feedId]) entry.counts = { ...entry.counts, [feedId]: 0 };
  }
}

/**
 * Compare a tracked product with its current state: a back-in-stock or
 * price-drop alert for the eligible groups it matches (or null), and the
 * updated per-group price baselines. Updates `existing` with the product's
 * fields; listing bookkeeping (lastSeenAt, misses) is the caller's.
 */
function diffKnownProduct({ existing, product, scoped, eligibleGroup, config, allGroupIds }) {
  const groupBase = plainObject(existing.groupBase);
  for (const id of Object.keys(groupBase)) if (!allGroupIds.has(id)) delete groupBase[id];
  const price = product.priceSek;
  const backInStock = !isAvailable(existing) && product.inStock;
  const backGroups = [];
  const dropGroups = [];

  for (const group of scoped) {
    const base = groupBase[group.id];
    // First time this group sees the product (new group, edited keywords):
    // start its baseline now, without an alert.
    if (!(base > 0)) {
      if (price > 0) groupBase[group.id] = price;
      continue;
    }
    if (!eligibleGroup(group) || !groupFiltersMatch(group, product)) continue;
    if (backInStock && config.notifyBackInStock) {
      backGroups.push(group);
      continue;
    }
    const threshold = group.priceDropPct ?? config.notifyPriceDropPercent;
    if (threshold > 0 && price > 0 && price < base) {
      const dropPercent = ((base - price) / base) * 100;
      if (dropPercent >= threshold) dropGroups.push({ group, base, dropPercent });
    }
  }

  let alert = null;
  if (backGroups.length || dropGroups.length) {
    const triggered = [...backGroups, ...dropGroups.map((d) => d.group)];
    const order = new Map(config.groups.map((g, i) => [g.id, i]));
    triggered.sort((a, b) => order.get(a.id) - order.get(b.id));
    const biggest = dropGroups.reduce((best, d) => (!best || d.base > best.base ? d : best), null);
    const previousPriceSek = biggest?.base ?? (existing.priceSek > price ? existing.priceSek : null);
    alert = {
      reason: backGroups.length ? 'back-in-stock' : 'price-drop',
      product,
      feed: existing.feed,
      groupIds: triggered.map((g) => g.id),
      groupNames: triggered.map((g) => g.name),
      previousPriceSek: previousPriceSek ?? null,
      dropPercent: previousPriceSek ? Math.round(((previousPriceSek - price) / previousPriceSek) * 1000) / 10 : null,
    };
  }

  // Baselines: a return or an alert restarts them at the current price; a
  // rise lifts them; small drops accumulate towards the threshold.
  if (price > 0) {
    if (backInStock) for (const group of scoped) groupBase[group.id] = price;
    for (const { group } of dropGroups) groupBase[group.id] = price;
    for (const group of scoped) if (price > (groupBase[group.id] ?? 0)) groupBase[group.id] = price;
  }

  Object.assign(existing, productFields(product), {
    priceSek: product.priceSek ?? existing.priceSek,
    imageUrl: product.imageUrl ?? existing.imageUrl ?? null,
    groupBase,
  });
  return alert;
}

/**
 * Apply one run's pages to the state and work out what to alert about.
 * Pure apart from mutating `state`; the poller handles fetching and Discord.
 *
 * @returns {{ alerts, okFeeds, failedFeeds, warnings, productCount, newCount, feedCounts }}
 */
export function applyInetPages({ state, pages, config, nowIso, alertsEnabled = true }) {
  const enabled = enabledFeedIds(config);
  const groups = config.groups.filter(isGroupActive);
  const allGroupIds = new Set(config.groups.map((g) => g.id));
  const warnings = [];

  // A disabled feed or group forgets its seed, so turning it back on later
  // seeds silently again instead of alerting on everything listed meanwhile.
  for (const feedId of Object.keys(state.seededFeeds)) {
    if (!enabled.includes(feedId)) delete state.seededFeeds[feedId];
  }
  for (const [groupId, seeds] of Object.entries(state.seededGroups)) {
    const group = groups.find((g) => g.id === groupId);
    if (!group) { delete state.seededGroups[groupId]; continue; }
    for (const feedId of Object.keys(plainObject(seeds))) {
      if (!enabled.includes(feedId) || !groupCoversFeed(group, feedId)) delete seeds[feedId];
    }
  }
  const feedSeeded = { ...state.seededFeeds };
  const groupSeeded = Object.fromEntries(Object.entries(state.seededGroups).map(([id, seeds]) => [id, { ...seeds }]));
  const eligible = (group, feedId) => alertsEnabled && Boolean(feedSeeded[feedId]) && Boolean(groupSeeded[group.id]?.[feedId]);

  const byFeed = new Map(enabled.map((feedId) => [feedId, new Map()]));
  for (const page of Array.isArray(pages) ? pages : []) {
    const pagesOfFeed = byFeed.get(page?.feed);
    if (!pagesOfFeed) continue;
    const n = Math.max(1, Math.floor(Number(page.page)) || 1);
    const existing = pagesOfFeed.get(n);
    if (!existing || (!existing.found && page.found)) pagesOfFeed.set(n, page);
  }

  const alerts = [];
  const okFeeds = [];
  const failedFeeds = [];
  const feedCounts = {};
  let newCount = 0;
  let productCount = 0;

  for (const feedId of enabled) {
    const pagesOfFeed = byFeed.get(feedId);
    const prevStats = plainObject(state.feedStats[feedId]);
    const foundPages = [...pagesOfFeed.values()].filter((p) => p.found && Array.isArray(p.products));
    if (!foundPages.length) {
      failedFeeds.push(feedId);
      const sample = [...pagesOfFeed.values()][0];
      state.feedStats[feedId] = {
        ...prevStats,
        lastErrorAt: nowIso,
        lastError: sample
          ? `No product data on the page${sample.title ? ` ("${sample.title}")` : ''}${sample.error ? `: ${sample.error}` : ''}`
          : 'Page not fetched',
      };
      continue;
    }
    okFeeds.push(feedId);

    const first = pagesOfFeed.get(1);
    const isDelta = Boolean(first?.delta);
    const ids = first?.found && Array.isArray(first.productIds) ? first.productIds.map(String) : null;
    const pageSize = Number(first?.pageSize) > 0 ? Number(first.pageSize) : INET_PAGE_SIZE;
    const total = ids ? ids.length : (Number.isFinite(foundPages[0].total) ? foundPages[0].total : prevStats.total ?? null);
    const fullExpectedPages = inetPagesFor(total, pageSize);
    const requiredPages = isDelta
      ? [1, ...(Array.isArray(first?.deltaPages) ? first.deltaPages : [])]
      : Array.from({ length: fullExpectedPages }, (_, i) => i + 1);
    const expectedPages = requiredPages.length;
    const missingPages = requiredPages.filter((n) => !pagesOfFeed.get(n)?.found);
    const truncated = Number.isFinite(total) && total > INET_MAX_PAGES_PER_FEED * pageSize;
    const complete = Boolean(ids) && !missingPages.length && !truncated;
    if (missingPages.length) warnings.push(`${INET_FEEDS[feedId].label}: page${missingPages.length === 1 ? '' : 's'} ${missingPages.join(', ')} failed to load.`);
    if (truncated) warnings.push(`${INET_FEEDS[feedId].label}: ${total} items, only the first ${INET_MAX_PAGES_PER_FEED * pageSize} are checked.`);

    if (first?.found) updateCatalog(state, feedId, first.templates, nowIso);

    // Items can shift between pages while the sweep runs: dedupe by id.
    const products = new Map();
    for (const page of foundPages) {
      for (const raw of page.products) {
        const product = mapInetProduct(raw, feedId);
        if (product && !products.has(product.id)) products.set(product.id, product);
      }
    }
    productCount += products.size;

    // Ids listed on the previous sweep (from page 1's full id list) aren't
    // new even if we never got their details, e.g. after a failed page.
    const previousIds = Array.isArray(state.feedIds[feedId]) ? new Set(state.feedIds[feedId].map(String)) : null;
    let feedNew = 0;

    for (const product of products.values()) {
      const key = `${feedId}:${product.id}`;
      const existing = state.products[key];
      const scoped = groups.filter((group) => groupScopeMatches(group, product));

      if (!existing) {
        newCount += 1;
        feedNew += 1;
        const reallyNew = !previousIds?.has(product.id);
        const matched = reallyNew
          ? scoped.filter((group) => eligible(group, feedId) && groupFiltersMatch(group, product))
          : [];
        state.products[key] = {
          key,
          id: product.id,
          feed: feedId,
          ...productFields(product),
          // Price-drop baselines per watch group (see below).
          groupBase: Object.fromEntries(scoped.filter(() => product.priceSek > 0).map((group) => [group.id, product.priceSek])),
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          seeded: matched.length === 0,
          missingSince: null,
          misses: 0,
        };
        if (matched.length) {
          alerts.push({ reason: 'new', product, feed: feedId, groupIds: matched.map((g) => g.id), groupNames: matched.map((g) => g.name) });
        }
        continue;
      }

      const alert = diffKnownProduct({
        existing,
        product,
        scoped,
        eligibleGroup: (group) => eligible(group, feedId),
        config,
        allGroupIds,
      });
      if (alert) alerts.push(alert);
      Object.assign(existing, { lastSeenAt: nowIso, missingSince: null, misses: 0 });
    }

    // Gone: absent from the full id list of a complete sweep, twice in a row.
    if (complete) {
      const listed = new Set([...ids, ...products.keys()]);
      for (const record of Object.values(state.products)) {
        if (record.feed !== feedId || record.missingSince) continue;
        if (listed.has(record.id)) {
          record.misses = 0;
          continue;
        }
        record.misses = (record.misses ?? 0) + 1;
        if (record.misses >= MISSES_BEFORE_GONE) record.missingSince = nowIso;
      }
    }
    if (ids) state.feedIds[feedId] = ids;

    const priorFullSweepAt = prevStats.lastFullSweepAt
      ?? (prevStats.complete && !prevStats.delta ? prevStats.lastFetchedAt ?? null : null);
    state.feedStats[feedId] = {
      lastFetchedAt: nowIso,
      lastFullSweepAt: !isDelta && complete ? nowIso : priorFullSweepAt,
      delta: isDelta,
      total: Number.isFinite(total) ? total : null,
      pagesExpected: expectedPages,
      pagesFetched: foundPages.length,
      complete,
      lastCount: products.size,
      lastNew: feedNew,
      lastError: missingPages.length ? `Page${missingPages.length === 1 ? '' : 's'} ${missingPages.join(', ')} failed` : null,
      lastErrorAt: missingPages.length ? nowIso : prevStats.lastErrorAt ?? null,
    };
    feedCounts[feedId] = products.size;

    if (first?.found) {
      if (!state.seededFeeds[feedId]) state.seededFeeds[feedId] = nowIso;
      for (const group of groups) {
        if (!groupCoversFeed(group, feedId)) continue;
        const seeds = plainObject(state.seededGroups[group.id]);
        if (!seeds[feedId]) seeds[feedId] = nowIso;
        state.seededGroups[group.id] = seeds;
      }
    }
  }

  if (failedFeeds.length && okFeeds.length) {
    warnings.push(`${failedFeeds.map((f) => INET_FEEDS[f].label).join(', ')} failed to load this check.`);
  }

  pruneProducts(state, Date.parse(nowIso));
  return { alerts, okFeeds, failedFeeds, warnings, productCount, newCount, feedCounts };
}

function pruneProducts(state, nowMs) {
  for (const [key, record] of Object.entries(state.products)) {
    const last = Date.parse(record?.lastSeenAt ?? '');
    if (!record || (Number.isFinite(last) && nowMs - last > PRODUCT_RETENTION_MS)) delete state.products[key];
  }
  const remaining = Object.values(state.products);
  if (remaining.length > MAX_PRODUCTS) {
    remaining
      .sort((a, b) => Date.parse(a.lastSeenAt ?? 0) - Date.parse(b.lastSeenAt ?? 0))
      .slice(0, remaining.length - MAX_PRODUCTS)
      .forEach((record) => delete state.products[record.key]);
  }
}

function describeAlert(alert, nowIso, delivered, note = null) {
  const product = alert.product ?? {};
  return {
    at: nowIso,
    reason: alert.reason,
    feed: alert.feed,
    id: product.id,
    title: product.title,
    url: product.url,
    imageUrl: product.imageUrl,
    priceSek: product.priceSek,
    listPriceSek: product.listPriceSek ?? null,
    discountPct: product.discountPct ?? null,
    previousPriceSek: alert.previousPriceSek ?? null,
    dropPercent: alert.dropPercent ?? null,
    inStock: product.inStock,
    webQty: product.webQty ?? null,
    storeQty: product.storeQty ?? null,
    groupNames: alert.groupNames ?? [],
    delivered,
    note,
  };
}

// ── Fast check ─────────────────────────────────────────────────

function groupsSeededFor(state, feedId) {
  const feedSeeded = Boolean(state.seededFeeds[feedId]);
  return (group) => feedSeeded && Boolean(plainObject(state.seededGroups[group.id])[feedId]);
}

/**
 * Tracked, listed items that an active, seeded watch group covers (by feed,
 * category and keywords, not by its price or stock filters, so an item can
 * come back in stock). Most recently listed first, capped.
 */
export function watchedInetRecords(state, config, limit = MAX_FAST_CHECK_IDS) {
  const feeds = new Set(enabledFeedIds(config));
  const groups = config.groups.filter(isGroupActive);
  return Object.values(state.products)
    .filter((record) => record && feeds.has(record.feed) && !record.missingSince)
    .filter((record) => {
      const seeded = groupsSeededFor(state, record.feed);
      return groups.some((group) => seeded(group) && groupScopeMatches(group, record));
    })
    .sort((a, b) => Date.parse(b.lastSeenAt ?? 0) - Date.parse(a.lastSeenAt ?? 0))
    .slice(0, limit);
}

/** A tracked record updated with a product lookup's price and stock. */
function productFromLookup(record, detail) {
  const price = Number(detail?.priceIncVat);
  const priceSek = Number.isFinite(price) && price > 0 ? Math.round(price) : record.priceSek;
  const listPriceSek = record.listPriceSek > priceSek ? record.listPriceSek : null;
  const stores = Array.isArray(detail?.stock?.stores) ? detail.stock.stores : [];
  const storeQty = stores.filter((store) => store?.inStock === true).length;
  const inWebStock = detail?.stock?.inWebStock === true;
  return {
    ...productFields(record),
    id: record.id,
    feed: record.feed,
    priceSek,
    listPriceSek,
    discountPct: listPriceSek ? Math.round((1 - priceSek / listPriceSek) * 100) : 0,
    webQty: inWebStock ? Math.max(1, record.webQty ?? 1) : 0,
    inWebStock,
    storeQty,
    inStock: inWebStock || storeQty > 0,
  };
}

/**
 * Apply product lookups (id → detail) to the tracked records: same price-drop
 * and back-in-stock rules as a sweep. Leaves listing bookkeeping (lastSeenAt,
 * gone detection) to the sweeps, since a lookup can't tell whether the item is
 * still in the campaign or outlet list.
 *
 * @returns {{ alerts, checked, changed }}
 */
export function applyInetLookups({ state, records, details, config, alertsEnabled = true }) {
  const groups = config.groups.filter(isGroupActive);
  const allGroupIds = new Set(config.groups.map((g) => g.id));
  const alerts = [];
  let checked = 0;
  let changed = 0;
  for (const record of records) {
    const detail = details.get(String(record.id));
    if (!detail) continue;
    checked += 1;
    const product = productFromLookup(record, detail);
    if (product.priceSek !== record.priceSek || product.inStock !== record.inStock) changed += 1;
    const seeded = groupsSeededFor(state, record.feed);
    const alert = diffKnownProduct({
      existing: record,
      product,
      scoped: groups.filter((group) => groupScopeMatches(group, product)),
      eligibleGroup: (group) => alertsEnabled && seeded(group),
      config,
      allGroupIds,
    });
    if (alert) alerts.push(alert);
  }
  return { alerts, checked, changed };
}

// ── Poller ─────────────────────────────────────────────────────

export function createInetPoller({
  getConfig,
  notifier = null,
  persistence = null,
  // Called with the watcher state after every successful check, once it is
  // persisted; src/index.js mirrors the items into the main listing.
  onStateChange = null,
  fetchPages = fetchInetAgentPages,
  lookupProducts = lookupInetAgentProducts,
  fetchRunUsage = fetchApifyRunUsage,
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  random = Math.random,
  now = () => Date.now(),
}) {
  let timer = null;
  let fastTimer = null;
  let started = false;
  let inFlightPromise = null;
  let fastInFlight = null;
  let consecutiveFailures = 0;
  let state = createEmptyInetState();

  try {
    state = normalizeInetState(persistence?.load?.());
  } catch (error) {
    logger.warn?.(`[inet] Could not load saved state, starting fresh: ${error.message}`);
  }

  const status = {
    running: false,
    lastPollStartedAt: null,
    lastSuccessAt: state.lastRun?.ok ? state.lastRun.at : null,
    lastErrorAt: null,
    lastError: null,
    lastWarning: null,
    lastDurationMs: null,
    lastProductCount: null,
    lastNewCount: null,
    lastAlertCount: null,
    lastSkipReason: null,
    nextPollAt: null,
    pollCount: 0,
    failureCount: 0,
  };
  const fastStatus = { lastAt: null, checked: null, changed: null, alerts: null, lastError: null, nextAt: null };

  const readConfig = () => normalizeInetConfig(getConfig?.() ?? {});

  async function persist() {
    if (!persistence?.save) return;
    try {
      await persistence.save(state);
    } catch (error) {
      logger.error?.(`[inet] Failed to save state: ${error.message}`);
    }
  }

  function hasRecentFullSweep(id, nowMs = now()) {
    const stats = state.feedStats[id];
    const lastFullIso = stats?.lastFullSweepAt
      ?? (stats?.complete && !stats?.delta ? stats?.lastFetchedAt ?? '' : '');
    const lastFullMs = Date.parse(lastFullIso);
    return Number.isFinite(lastFullMs) && nowMs - lastFullMs < FULL_SWEEP_INTERVAL_MS;
  }

  /**
   * Pages per feed for the next check. Once a multi-page feed has completed a
   * full sweep within the last hour, checks run in Page-1 delta mode (1 URL per
   * feed, enqueuing extra pages only if their slice of `productIds` has a new id).
   */
  function planFeeds(config, nowMs = now()) {
    return enabledFeedIds(config).map((id) => {
      const total = state.feedStats[id]?.total;
      const fullPages = Number.isFinite(total) ? inetPagesFor(total) : 1;
      const knownIds = state.feedIds[id];
      if (
        state.seededFeeds[id]
        && fullPages > 1
        && Array.isArray(knownIds)
        && knownIds.length > 0
        && hasRecentFullSweep(id, nowMs)
      ) {
        return { id, pages: 1, delta: true, knownIds };
      }
      return { id, pages: fullPages };
    });
  }

  function expectedUrlCount(config) {
    return enabledFeedIds(config).reduce((sum, id) => {
      const stats = state.feedStats[id];
      const total = stats?.total;
      if (!Number.isFinite(total)) return sum + UNKNOWN_FEED_PAGES;
      const fullPages = inetPagesFor(total);
      if (state.seededFeeds[id] && fullPages > 1 && (stats?.lastFullSweepAt || stats?.complete)) {
        return sum + 1;
      }
      return sum + fullPages;
    }, 0);
  }

  function isProxyMode() {
    if (fetchPages === fetchInetAgentPages || state.lastRun?.runStatus === 'PROXY') return true;
    if (!state.lastRun && fetchPages === fetchInetPages && resolveWatcherProxyUrl('INET')) return true;
    return false;
  }

  function costGuard(config = readConfig(), nowMs = now()) {
    return computeCostGuard({
      usage: state.usage,
      config,
      urlCount: expectedUrlCount(config),
      nowMs,
      costModel: isProxyMode() ? ZERO_COST_MODEL : INET_COST_MODEL,
    });
  }

  function nextDelayMs() {
    const config = readConfig();
    return computeNextDelayMs({
      config,
      consecutiveFailures,
      costGuardIntervalMs: costGuard(config).intervalMs,
      random,
      minDelayMs: MIN_DELAY_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
    });
  }

  function clearTimer() {
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function schedule(delayMs) {
    clearTimer();
    if (!started) return;
    status.nextPollAt = new Date(now() + delayMs).toISOString();
    timer = setTimeoutFn(() => {
      timer = null;
      tick().catch((error) => logger.error?.('[inet]', error.message));
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** Re-read the settled cost of the previous run and correct the tally. */
  async function settlePreviousRunCost() {
    const pending = state.pendingUsageRun;
    if (!pending?.id) return;
    state.pendingUsageRun = null;
    try {
      const finalUsd = await fetchRunUsage({ runId: pending.id });
      if (Number.isFinite(finalUsd) && pending.month === state.usage.month && finalUsd > pending.recordedUsd) {
        state.usage.usd += finalUsd - pending.recordedUsd;
        if (state.lastRun?.runId === pending.id) state.lastRun.usd = finalUsd;
      }
    } catch (error) {
      logger.warn?.(`[inet] Could not read settled cost of run ${pending.id}: ${error.message}`);
    }
  }

  async function sendAlerts(alerts, config, nowIso) {
    const retries = state.pendingAlerts.filter((entry) => entry?.alert?.product?.id);
    state.pendingAlerts = [];
    const queue = [
      ...retries.map((entry) => ({ alert: entry.alert, attempts: entry.attempts ?? 1 })),
      ...alerts.map((alert) => ({ alert, attempts: 0 })),
    ];
    if (!queue.length) return { sent: 0, failed: 0, skipped: 0 };

    const toSend = queue.slice(0, MAX_ALERTS_PER_POLL);
    const overflow = queue.slice(MAX_ALERTS_PER_POLL);
    const records = [];

    let result = { sent: 0, failed: 0, skipped: toSend.length, delivered: toSend.map(() => false), reason: 'no-notifier' };
    if (notifier?.notifyInet && toSend.length) {
      try {
        result = await notifier.notifyInet({
          alerts: toSend.map((entry) => entry.alert),
          webhookUrl: config.discordWebhookUrl,
          catalog: state.catalog,
        });
      } catch (error) {
        result = { sent: 0, failed: toSend.length, skipped: 0, delivered: toSend.map(() => false), errors: [error.message] };
      }
    }

    toSend.forEach((entry, index) => {
      const delivered = Boolean(result.delivered?.[index]);
      const noWebhook = result.reason === 'no-webhook' || result.reason === 'no-notifier';
      if (!delivered && !noWebhook && entry.attempts + 1 < MAX_ALERT_ATTEMPTS) {
        state.pendingAlerts.push({ alert: entry.alert, attempts: entry.attempts + 1 });
      }
      if (entry.attempts === 0 || delivered) {
        records.push(describeAlert(entry.alert, nowIso, delivered, delivered ? null : (noWebhook ? 'No Discord webhook configured' : 'Discord delivery failed')));
      }
    });
    for (const entry of overflow) {
      records.push(describeAlert(entry.alert, nowIso, false, 'Too many alerts in one check'));
    }

    state.pendingAlerts = state.pendingAlerts.slice(0, MAX_PENDING_ALERTS);
    state.recentAlerts = [...records, ...state.recentAlerts].slice(0, MAX_RECENT_ALERTS);
    if (result.errors?.length) logger.warn?.(`[inet] Discord: ${result.errors.join('; ')}`);
    return { sent: result.sent ?? 0, failed: result.failed ?? 0, skipped: result.skipped ?? 0 };
  }

  async function runPoll({ manual }) {
    const config = readConfig();
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    rollUsageMonth(state.usage, nowMs);

    const feeds = planFeeds(config, nowMs);
    if (!feeds.length) throw new Error('Enable at least one Inet feed first.');

    await settlePreviousRunCost();

    let response;
    const plannedUrls = feeds.reduce((sum, feed) => sum + feed.pages, 0);
    try {
      response = await fetchPages({ feeds });
    } catch (error) {
      state.lastRun = { at: nowIso, ok: false, manual, error: error.message, urls: plannedUrls };
      await persist();
      throw error;
    }

    const { run = {}, pages = [], source = null, urls: fetchedUrls = null } = response ?? {};
    if (source === 'agent') {
      // The agent API lists items the HTML pages never showed, so the first
      // check after switching seeds silently instead of alerting on all of them.
      if (state.source !== 'agent') {
        state.seededFeeds = {};
        state.seededGroups = {};
        state.source = 'agent';
      }
      await resolveInetTemplates({ state, pages, lookup: (ids) => lookupProducts(ids, { logger }), nowIso, logger });
    }
    // The agent API reports the list pages it actually requested; an Apify
    // run's page 1 may enqueue more pages than planned (first run, grown feed).
    const urls = source === 'agent' && Number.isFinite(fetchedUrls)
      ? fetchedUrls
      : Math.max(plannedUrls, Array.isArray(pages) ? pages.length : 0);
    const estimate = estimateRunUsd(state.usage, urls, INET_COST_MODEL);
    const recordedUsd = Number.isFinite(run.usageTotalUsd) ? run.usageTotalUsd : estimate;
    state.usage.runs += 1;
    state.usage.urls += urls;
    state.usage.usd += recordedUsd;
    state.pendingUsageRun = run.id ? { id: run.id, recordedUsd, month: state.usage.month } : null;

    const runInfo = {
      at: nowIso,
      manual,
      runId: run.id ?? null,
      runStatus: run.status ?? null,
      usd: recordedUsd,
      urls,
      runTimeSecs: run.runTimeSecs ?? null,
    };

    const outcome = applyInetPages({ state, pages, config, nowIso, alertsEnabled: config.enabled });

    if (!outcome.okFeeds.length) {
      const pageError = (Array.isArray(pages) ? pages : []).find((page) => page?.error)?.error;
      const message = run.status && !['SUCCEEDED', 'PROXY'].includes(run.status)
        ? `Apify run ${run.status} without usable pages`
        : `No Inet page returned product data${pageError ? ` (${pageError})` : ' (blocked or layout change?)'}`;
      state.lastRun = { ...runInfo, ok: false, error: message };
      await persist();
      throw new Error(message);
    }

    const delivery = await sendAlerts(outcome.alerts, config, nowIso);

    state.lastRun = {
      ...runInfo,
      ok: true,
      products: outcome.productCount,
      newProducts: outcome.newCount,
      feedCounts: outcome.feedCounts,
      alerts: outcome.alerts.length,
      sent: delivery.sent,
      failedFeeds: outcome.failedFeeds,
    };
    await persist();

    if (onStateChange) {
      try {
        await onStateChange(state);
      } catch (error) {
        logger.error?.(`[inet] Listing update failed: ${error.message}`);
      }
    }

    return {
      count: outcome.productCount,
      newCount: outcome.newCount,
      feedCounts: outcome.feedCounts,
      alertCount: outcome.alerts.length,
      sent: delivery.sent,
      warnings: outcome.warnings,
      failedFeeds: outcome.failedFeeds,
      usd: recordedUsd,
    };
  }

  async function tick({ manual = false } = {}) {
    if (inFlightPromise) {
      if (manual) return inFlightPromise;
      return null;
    }

    const config = readConfig();
    if (!manual && (!started || !config.enabled)) {
      schedule(nextDelayMs());
      return null;
    }
    if (!manual && !enabledFeedIds(config).length) {
      status.lastSkipReason = 'no-feeds';
      schedule(nextDelayMs());
      return null;
    }
    if (!manual && costGuard(config).exhausted) {
      status.lastSkipReason = 'budget-exhausted';
      schedule(nextDelayMs());
      return null;
    }

    status.running = true;
    status.lastSkipReason = null;
    status.lastPollStartedAt = new Date(now()).toISOString();
    const startedAtMs = now();

    inFlightPromise = (async () => {
      try {
        if (fastInFlight) await fastInFlight;
        const result = await runPoll({ manual });
        consecutiveFailures = 0;
        status.pollCount += 1;
        status.lastSuccessAt = new Date(now()).toISOString();
        status.lastError = null;
        status.lastWarning = result.warnings.length ? result.warnings.join(' ') : null;
        status.lastProductCount = result.count;
        status.lastNewCount = result.newCount;
        status.lastAlertCount = result.alertCount;
        return result;
      } catch (error) {
        consecutiveFailures += 1;
        status.failureCount += 1;
        status.lastErrorAt = new Date(now()).toISOString();
        status.lastError = error.message;
        logger.error?.(`[inet] Check failed (${consecutiveFailures} in a row): ${error.message}`);
        if (manual) throw error;
        return null;
      } finally {
        status.lastDurationMs = now() - startedAtMs;
        status.running = false;
        schedule(nextDelayMs());
      }
    })();

    try {
      return await inFlightPromise;
    } finally {
      inFlightPromise = null;
    }
  }

  function scheduleFast(delayMs = FAST_CHECK_INTERVAL_MS * (1 - FAST_CHECK_JITTER + 2 * FAST_CHECK_JITTER * random())) {
    if (fastTimer) clearTimeoutFn(fastTimer);
    fastTimer = null;
    fastStatus.nextAt = null;
    if (!started) return;
    fastStatus.nextAt = new Date(now() + delayMs).toISOString();
    fastTimer = setTimeoutFn(() => {
      fastTimer = null;
      fastCheck().catch((error) => logger.error?.('[inet] fast check:', error.message));
    }, delayMs);
    if (fastTimer && typeof fastTimer.unref === 'function') fastTimer.unref();
  }

  /** Look up the watched items' price and stock; skipped while a sweep runs. */
  async function fastCheck({ reschedule = true } = {}) {
    const config = readConfig();
    if (!config.enabled || state.source !== 'agent' || inFlightPromise || fastInFlight) {
      if (reschedule) scheduleFast();
      return null;
    }
    fastInFlight = (async () => {
      const nowIso = new Date(now()).toISOString();
      try {
        const records = watchedInetRecords(state, config);
        if (!records.length) return { checked: 0, changed: 0, alerts: 0 };
        const { products, failed } = await lookupProducts(records.map((r) => r.id), { logger });
        const outcome = applyInetLookups({ state, records, details: products, config, alertsEnabled: config.enabled });
        if (outcome.alerts.length) await sendAlerts(outcome.alerts, config, nowIso);
        if (outcome.changed || outcome.alerts.length) {
          await persist();
          if (onStateChange) await onStateChange(state);
        }
        Object.assign(fastStatus, {
          lastAt: nowIso,
          checked: outcome.checked,
          changed: outcome.changed,
          alerts: outcome.alerts.length,
          lastError: failed?.size ? `${failed.size} lookup(s) unanswered` : null,
        });
        return { checked: outcome.checked, changed: outcome.changed, alerts: outcome.alerts.length };
      } catch (error) {
        fastStatus.lastError = error.message;
        logger.warn?.(`[inet] Fast check failed: ${error.message}`);
        return null;
      }
    })();
    try {
      return await fastInFlight;
    } finally {
      fastInFlight = null;
      if (reschedule) scheduleFast();
    }
  }

  function initialDelayMs() {
    // Across restarts (deploys), carry on from the last run instead of
    // checking immediately: that keeps the cadence irregular and the bill flat.
    const lastAt = Date.parse(state.lastRun?.at ?? '');
    const next = nextDelayMs();
    if (Number.isFinite(lastAt)) {
      const remaining = lastAt + next - now();
      if (remaining > 0) return remaining;
    }
    return Math.round(20_000 + random() * 40_000);
  }

  function catalogName(templateId) {
    return state.catalog[String(templateId ?? '')]?.name ?? null;
  }

  /** Template categories, most items first, with per-feed counts. */
  function getCatalog() {
    return Object.values(state.catalog)
      .filter((entry) => entry?.id && entry.name)
      .map((entry) => {
        const counts = { deals: entry.counts?.deals ?? 0, outlet: entry.counts?.outlet ?? 0 };
        return { id: entry.id, name: entry.name, count: counts.deals + counts.outlet, counts, lastSeenAt: entry.lastSeenAt ?? null };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'sv-SE'));
  }

  function listedRecords(config) {
    const feeds = new Set(enabledFeedIds(config));
    return Object.values(state.products).filter((record) => record && feeds.has(record.feed) && !record.missingSince);
  }

  function feedStatus(config) {
    const records = Object.values(state.products);
    return ['deals', 'outlet'].map((id) => {
      const stats = plainObject(state.feedStats[id]);
      const ofFeed = records.filter((r) => r?.feed === id && !r.missingSince);
      return {
        id,
        label: INET_FEEDS[id].label,
        url: buildInetFeedUrl(id),
        enabled: config.feeds[id] !== false,
        seeded: Boolean(state.seededFeeds[id]),
        total: stats.total ?? null,
        tracked: ofFeed.length,
        inStock: ofFeed.filter((r) => r.inStock).length,
        pagesExpected: stats.pagesExpected ?? null,
        pagesFetched: stats.pagesFetched ?? null,
        complete: stats.complete ?? null,
        lastFetchedAt: stats.lastFetchedAt ?? null,
        lastError: stats.lastError ?? null,
      };
    });
  }

  function groupStatus(config, records) {
    return config.groups.map((group) => {
      const active = isGroupActive(group);
      const seeds = plainObject(state.seededGroups[group.id]);
      return {
        id: group.id,
        name: group.name,
        enabled: group.enabled,
        active,
        seeded: Object.keys(seeds).length > 0,
        matches: active ? records.filter((record) => groupMatches(group, record)).length : 0,
      };
    });
  }

  function latestFinds(config, records, limit = 20) {
    const active = config.groups.filter(isGroupActive);
    const withGroups = records.map((record) => ({
      record,
      groups: active.filter((group) => groupMatches(group, record)).map((group) => group.name),
    }));
    // With watch groups: their matches. Without: the newest items overall.
    const pool = active.length ? withGroups.filter((entry) => entry.groups.length) : withGroups;
    return pool
      .sort((a, b) => (Date.parse(b.record.firstSeenAt) - Date.parse(a.record.firstSeenAt))
        || ((b.record.discountPct ?? 0) - (a.record.discountPct ?? 0)))
      .slice(0, limit)
      .map(({ record, groups }) => ({
        id: record.id,
        feed: record.feed,
        title: record.title,
        url: record.url,
        imageUrl: record.imageUrl,
        priceSek: record.priceSek,
        listPriceSek: record.listPriceSek ?? null,
        discountPct: record.discountPct ?? null,
        inStock: record.inStock,
        webQty: record.webQty ?? null,
        storeQty: record.storeQty ?? null,
        sellingPoint: record.sellingPoint ?? null,
        categoryLabel: catalogName(record.templateId),
        groupNames: groups,
        firstSeenAt: record.firstSeenAt,
        seeded: Boolean(record.seeded),
      }));
  }

  function getStatus() {
    const config = readConfig();
    const nowMs = now();
    const guard = costGuard(config, nowMs);
    const records = listedRecords(config);
    return {
      ...status,
      enabled: config.enabled,
      started,
      consecutiveFailures,
      intervalMinutes: config.intervalMinutes,
      effectiveIntervalMinutes: Math.round(Math.max(guard.intervalMs, MIN_DELAY_MS) / 600) / 100,
      costGuard: {
        month: guard.month,
        spentUsd: guard.spentUsd,
        runs: guard.runs,
        maxMonthlyUsd: guard.maxMonthlyUsd,
        estimatedRunUsd: guard.estimatedRunUsd,
        projectedMonthUsd: guard.projectedMonthUsd,
        projectedFullMonthUsd: guard.projectedFullMonthUsd,
        stretched: guard.stretched,
        exhausted: guard.exhausted,
      },
      lastRun: state.lastRun,
      feeds: feedStatus(config),
      groups: groupStatus(config, records),
      trackedProducts: records.length,
      catalogSize: getCatalog().length,
      pendingAlerts: state.pendingAlerts.length,
      fastCheck: {
        ...fastStatus,
        active: config.enabled && state.source === 'agent',
        intervalSeconds: FAST_CHECK_INTERVAL_MS / 1000,
        watched: watchedInetRecords(state, config).length,
      },
      recentAlerts: state.recentAlerts.slice(0, 20),
      latestFinds: latestFinds(config, records),
    };
  }

  return {
    start() {
      if (started) return;
      started = true;
      schedule(initialDelayMs());
      scheduleFast();
    },
    stop() {
      started = false;
      clearTimer();
      if (fastTimer) clearTimeoutFn(fastTimer);
      fastTimer = null;
      fastStatus.nextAt = null;
      status.nextPollAt = null;
    },
    /** Re-arm with the new settings (dashboard save). */
    reschedule() {
      if (!started) return;
      consecutiveFailures = 0;
      schedule(nextDelayMs());
    },
    /** Dashboard "Check now". Runs even when disabled (then records silently). */
    async pollNow() {
      return tick({ manual: true });
    },
    /** The fast check of watched items, now (tests and diagnostics). */
    async fastCheckNow() {
      return fastCheck({ reschedule: false });
    },
    getStatus,
    getCatalog,
    /** For tests and diagnostics. */
    getState: () => state,
  };
}
