/**
 * Inet watcher: campaign deals (/kampanjer) and the Fyndhörnan outlet.
 *
 * Modelled on the Komplett demo watcher (komplettDemoPoller.js):
 *  - every check is ONE apify/cheerio-scraper run on Apify's proxy that sweeps
 *    every page of both feeds (Inet has no newest-first sort). Nothing here
 *    talks to inet.se directly: the owner wants no Inet traffic from home,
 *  - the delay is randomised (default 20 min ±40%) with a 10-minute floor,
 *  - failures back off exponentially up to 60 minutes,
 *  - a cost guard stretches the interval when this month's projected Apify
 *    spend would pass the cap (default $1.5).
 *
 * What to alert on comes from watch groups (keywords, Inet template
 * categories, discount/price/stock filters), like the Elgiganten hotlist.
 * Alerts: a matching item that is new, dropped in price by the group's (or
 * the global) %, or came back in stock. A feed or group seeds silently the
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

export const MIN_DELAY_MS = 10 * 60 * 1000;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;
export const MAX_ALERTS_PER_POLL = 25;
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

const titleCache = new Map();
function titleIndex(title) {
  const key = String(title ?? '');
  let entry = titleCache.get(key);
  if (!entry) {
    const tokens = matchTokens(key);
    entry = { tokens: new Set(tokens), compact: tokens.join('') };
    if (titleCache.size > 20_000) titleCache.clear();
    titleCache.set(key, entry);
  }
  return entry;
}

/**
 * Strict: every keyword word is a whole word of the title, in any order
 * ("RTX 5090" doesn't match an RTX 4090 with a "5090mm" spec, "ram" doesn't
 * match "ramverk"). Loose: every keyword word appears anywhere in the title.
 * Both are case- and diacritic-insensitive.
 */
export function keywordMatchesTitle(keyword, title, { strict = true } = {}) {
  const words = matchTokens(keyword);
  if (!words.length) return false;
  const index = titleIndex(title);
  return strict
    ? words.every((word) => index.tokens.has(word))
    : words.every((word) => index.compact.includes(word));
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
    const ids = first?.found && Array.isArray(first.productIds) ? first.productIds.map(String) : null;
    const pageSize = Number(first?.pageSize) > 0 ? Number(first.pageSize) : INET_PAGE_SIZE;
    const total = ids ? ids.length : (Number.isFinite(foundPages[0].total) ? foundPages[0].total : prevStats.total ?? null);
    const expectedPages = inetPagesFor(total, pageSize);
    const missingPages = [];
    for (let n = 1; n <= expectedPages; n += 1) if (!pagesOfFeed.get(n)?.found) missingPages.push(n);
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
        if (!eligible(group, feedId) || !groupFiltersMatch(group, product)) continue;
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

      if (backGroups.length || dropGroups.length) {
        const triggered = [...backGroups, ...dropGroups.map((d) => d.group)];
        const order = new Map(config.groups.map((g, i) => [g.id, i]));
        triggered.sort((a, b) => order.get(a.id) - order.get(b.id));
        const biggest = dropGroups.reduce((best, d) => (!best || d.base > best.base ? d : best), null);
        const previousPriceSek = biggest?.base ?? (existing.priceSek > price ? existing.priceSek : null);
        alerts.push({
          reason: backGroups.length ? 'back-in-stock' : 'price-drop',
          product,
          feed: feedId,
          groupIds: triggered.map((g) => g.id),
          groupNames: triggered.map((g) => g.name),
          previousPriceSek: previousPriceSek ?? null,
          dropPercent: previousPriceSek ? Math.round(((previousPriceSek - price) / previousPriceSek) * 1000) / 10 : null,
        });
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
        lastSeenAt: nowIso,
        missingSince: null,
        misses: 0,
      });
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

    state.feedStats[feedId] = {
      lastFetchedAt: nowIso,
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

// ── Poller ─────────────────────────────────────────────────────

export function createInetPoller({
  getConfig,
  notifier = null,
  persistence = null,
  // Called with the watcher state after every successful check, once it is
  // persisted; src/index.js mirrors the items into the main listing.
  onStateChange = null,
  fetchPages = fetchInetPages,
  fetchRunUsage = fetchApifyRunUsage,
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  random = Math.random,
  now = () => Date.now(),
}) {
  let timer = null;
  let started = false;
  let inFlightPromise = null;
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

  const readConfig = () => normalizeInetConfig(getConfig?.() ?? {});

  async function persist() {
    if (!persistence?.save) return;
    try {
      await persistence.save(state);
    } catch (error) {
      logger.error?.(`[inet] Failed to save state: ${error.message}`);
    }
  }

  /** Pages per feed for the next sweep, from the last known feed sizes. */
  function planFeeds(config) {
    return enabledFeedIds(config).map((id) => {
      const total = state.feedStats[id]?.total;
      return { id, pages: Number.isFinite(total) ? inetPagesFor(total) : 1 };
    });
  }

  function expectedUrlCount(config) {
    return enabledFeedIds(config).reduce((sum, id) => {
      const total = state.feedStats[id]?.total;
      return sum + (Number.isFinite(total) ? inetPagesFor(total) : UNKNOWN_FEED_PAGES);
    }, 0);
  }

  function costGuard(config = readConfig(), nowMs = now()) {
    return computeCostGuard({ usage: state.usage, config, urlCount: expectedUrlCount(config), nowMs, costModel: INET_COST_MODEL });
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

    const feeds = planFeeds(config);
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

    const { run = {}, pages = [] } = response ?? {};
    // Page 1 may enqueue more pages than planned (first run, grown feed).
    const urls = Math.max(plannedUrls, Array.isArray(pages) ? pages.length : 0);
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
      const message = run.status && run.status !== 'SUCCEEDED'
        ? `Apify run ${run.status} without usable pages`
        : 'No Inet page returned product data (blocked or layout change?)';
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
      recentAlerts: state.recentAlerts.slice(0, 20),
      latestFinds: latestFinds(config, records),
    };
  }

  return {
    start() {
      if (started) return;
      started = true;
      schedule(initialDelayMs());
    },
    stop() {
      started = false;
      clearTimer();
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
    getStatus,
    getCatalog,
    /** For tests and diagnostics. */
    getState: () => state,
  };
}
