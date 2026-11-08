/**
 * Komplett demo-products watcher ("demovaror", B-grade items).
 *
 * Modelled on the hotlist poller: its own randomised loop, independent of the
 * scan scheduler, alerting Discord about new finds in the categories the user
 * picked in the dashboard.
 *
 * Komplett's Akamai edge blocks the Pi (and our VPN) and fixed-interval
 * polling got us blocked before, so:
 *  - every fetch is ONE apify/cheerio-scraper run on Apify's proxy, fetching
 *    page 1 (newest first) of each selected category,
 *  - the delay is randomised (default 10 min ±40%) with a 5-minute floor,
 *  - failures back off exponentially up to 60 minutes,
 *  - a cost guard tracks this month's Apify spend and stretches the interval
 *    when the projection would exceed the configured monthly cap.
 *
 * State (seen products, last prices, seeded categories, spend) is persisted
 * in its own SQLite row so a restart never re-alerts. The tracked products are
 * also mirrored into the main listing (see komplettDemoListing.js).
 */

import {
  KOMPLETT_DEMO_SORT,
  KOMPLETT_FEEDS,
  KOMPLETT_OUTLET_ALL_TARGET,
  buildKomplettDemoUrl,
  dealsTargetsForCategories,
  fetchApifyRunUsage,
  fetchKomplettDemoPages,
  fetchKomplettImages,
  komplettDemoPagesFor,
  mapKomplettDemoProduct,
} from '../sources/komplett.js';
import {
  KOMPLETT_DEMO_CATALOG,
  enabledFeedIds,
  getKomplettDemoCategory,
  groupCoversFeed,
  isGroupActive,
  normalizeCategoryIds,
  normalizeKomplettDemoConfig,
} from './komplettDemoConfig.js';
import { keywordMatchesTitle } from './inetPoller.js';
import {
  ZERO_COST_MODEL,
  resolveWatcherProxyUrl,
} from './watcherProxy.js';

export const MIN_DELAY_MS = 30 * 1000;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;
export const MAX_COST_GUARD_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PAGE_SIZE = 24;
export const MAX_ALERTS_PER_POLL = 25;
export const MAX_ALERT_ATTEMPTS = 3;
const MAX_RECENT_ALERTS = 30;
const MAX_PENDING_ALERTS = 25;
const MAX_PRODUCTS = 5000;
const PRODUCT_RETENTION_MS = 120 * 24 * 60 * 60 * 1000;
// A product must be missing from a page it should still be on this many polls
// in a row before it counts as sold out. One flaky render shouldn't produce a
// "back in stock" alert later.
const MISSES_BEFORE_GONE = 2;

/**
 * Measured 2026-10-31 at 256 MB: a 3-URL run settled at $0.000447
 * (fixed ≈ KV writes + compute start-up; per URL ≈ request-queue writes).
 * Only used until this month has real runs to average over.
 */
export const COST_MODEL = Object.freeze({ perRunUsd: 0.00028, perUrlUsd: 0.000057 });

export function createEmptyKomplettDemoState() {
  return {
    version: 2,
    products: {},
    seededCategories: {},
    categoryStats: {},
    seededFeeds: {},
    seededGroups: {},
    feedStats: {},
    recentAlerts: [],
    pendingAlerts: [],
    usage: { month: null, usd: 0, runs: 0, urls: 0 },
    pendingUsageRun: null,
    lastRun: null,
  };
}

const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

export function normalizeKomplettDemoState(raw) {
  const input = plainObject(raw);
  const empty = createEmptyKomplettDemoState();
  const usage = plainObject(input.usage);
  const seededCategories = plainObject(input.seededCategories);
  const seededFeeds = { ...plainObject(input.seededFeeds) };
  const seededGroups = { ...plainObject(input.seededGroups) };

  // Migrate legacy seededCategories so existing B-grade categories/groups do not re-alert on upgrade.
  const legacySeedEntries = Object.entries(seededCategories);
  if (legacySeedEntries.length > 0) {
    if (!seededFeeds.outlet) {
      seededFeeds.outlet = legacySeedEntries[0][1];
    }
    for (const [catId, seededAt] of legacySeedEntries) {
      const legacyGroupId = `kg-cat-${catId}`;
      if (!seededGroups[legacyGroupId]) {
        seededGroups[legacyGroupId] = { outlet: seededAt };
      } else if (!seededGroups[legacyGroupId].outlet) {
        seededGroups[legacyGroupId] = { ...plainObject(seededGroups[legacyGroupId]), outlet: seededAt };
      }
    }
  }

  return {
    ...empty,
    products: plainObject(input.products),
    seededCategories,
    categoryStats: plainObject(input.categoryStats),
    seededFeeds,
    seededGroups,
    feedStats: plainObject(input.feedStats),
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

// ── Cost guard ─────────────────────────────────────────────────

/** Calendar month in UTC ('2026-10'). Apify's own usage cycle may differ by a few days. */
export function monthKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 7);
}

export function msUntilMonthEnd(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - nowMs;
}

/** Start a fresh tally when the month rolls over. */
export function rollUsageMonth(usage, nowMs) {
  const key = monthKey(nowMs);
  if (usage.month !== key) {
    usage.month = key;
    usage.usd = 0;
    usage.runs = 0;
    usage.urls = 0;
  }
  return usage;
}

function modelRunUsd(urlCount, model = COST_MODEL) {
  return model.perRunUsd + model.perUrlUsd * Math.max(urlCount, 0);
}

/** Expected cost of one run with `urlCount` URLs, calibrated on this month's real runs. */
export function estimateRunUsd(usage, urlCount, costModel = COST_MODEL) {
  const model = modelRunUsd(urlCount, costModel);
  if (!usage || usage.runs < 3 || !(usage.usd > 0)) return model;
  const modelled = usage.runs * costModel.perRunUsd + usage.urls * costModel.perUrlUsd;
  if (!(modelled > 0)) return model;
  // Bounded so one odd run can't swing the guard wildly.
  const scale = Math.min(Math.max(usage.usd / modelled, 0.25), 4);
  return model * scale;
}

/**
 * How long the interval must be for the rest of the month to fit the budget.
 * `intervalMs` is never shorter than the configured base interval.
 */
export function computeCostGuard({ usage, config, urlCount, nowMs, costModel = COST_MODEL }) {
  const current = usage?.month === monthKey(nowMs) ? usage : { month: monthKey(nowMs), usd: 0, runs: 0, urls: 0 };
  const baseIntervalMs = config.intervalMinutes * 60 * 1000;
  const maxUsd = config.maxMonthlyUsd;
  const spentUsd = current.usd;
  const estimatedRunUsd = estimateRunUsd(current, urlCount, costModel);
  const remainingMs = msUntilMonthEnd(nowMs);
  const budgetLeftUsd = maxUsd - spentUsd;

  let intervalMs = baseIntervalMs;
  let stretched = false;
  let exhausted = false;

  if (urlCount > 0) {
    const projectedAtBase = spentUsd + estimatedRunUsd * (remainingMs / baseIntervalMs);
    if (projectedAtBase > maxUsd) {
      stretched = true;
      if (budgetLeftUsd <= estimatedRunUsd) {
        // Out of budget: wait for the month to roll over (re-checked daily).
        exhausted = true;
        intervalMs = Math.min(Math.max(remainingMs + 60_000, baseIntervalMs), MAX_COST_GUARD_INTERVAL_MS);
      } else {
        intervalMs = Math.min(
          Math.max(baseIntervalMs, Math.ceil((estimatedRunUsd * remainingMs) / budgetLeftUsd)),
          MAX_COST_GUARD_INTERVAL_MS,
        );
      }
    }
  }

  const runsLeft = urlCount > 0 && !exhausted ? remainingMs / intervalMs : 0;
  return {
    month: current.month,
    spentUsd,
    runs: current.runs,
    maxMonthlyUsd: maxUsd,
    estimatedRunUsd,
    baseIntervalMs,
    intervalMs,
    stretched,
    exhausted,
    projectedMonthUsd: spentUsd + estimatedRunUsd * runsLeft,
    // What a whole 30-day month would cost at the effective interval.
    projectedFullMonthUsd: urlCount > 0 ? estimatedRunUsd * ((30 * 24 * 60 * 60 * 1000) / intervalMs) : 0,
  };
}

/**
 * Next delay: base interval (stretched by the cost guard), exponential
 * backoff after failures, ±jitter, never below MIN_DELAY_MS, and backoff
 * never above MAX_BACKOFF_MS unless the cost guard asks for longer.
 */
export function computeNextDelayMs({
  config,
  consecutiveFailures = 0,
  costGuardIntervalMs = 0,
  random = Math.random,
  minDelayMs = MIN_DELAY_MS,
  maxBackoffMs = MAX_BACKOFF_MS,
}) {
  const base = Math.max(config.intervalMinutes * 60 * 1000, costGuardIntervalMs || 0, minDelayMs);
  const ceiling = Math.max(maxBackoffMs, base);
  let delay = base;
  if (consecutiveFailures > 0) {
    delay = Math.max(base, Math.min(base * 2 ** Math.min(consecutiveFailures, 8), maxBackoffMs));
  }
  const jitterPct = Math.min(Math.max(Number(config.jitterPct) || 0, 0), 50);
  if (jitterPct) {
    const spread = delay * (jitterPct / 100);
    delay = delay - spread + random() * spread * 2;
  }
  if (consecutiveFailures > 0) delay = Math.min(delay, ceiling);
  return Math.round(Math.max(minDelayMs, delay));
}

// ── Diffing ────────────────────────────────────────────────────

function categoryIdFromPage(page) {
  if (page?.categoryId) return String(page.categoryId);
  const match = String(page?.url ?? '').match(/\/category\/(\d+)\//);
  return match ? match[1] : null;
}

function numericId(id) {
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}

function isAvailable(record) {
  return record.inStock !== false && !record.missingSince;
}

export function groupScopeMatches(group, product, productCategories = null) {
  if (!group || !group.enabled || !product) return false;
  const feed = product.feed || 'outlet';
  if (!groupCoversFeed(group, feed)) return false;

  if (Array.isArray(group.categories) && group.categories.length > 0) {
    const candidateCats = Array.isArray(productCategories) && productCategories.length > 0
      ? productCategories.map(String)
      : product.categoryId ? [String(product.categoryId)] : [];
    const matchedCat = group.categories.some((id) => candidateCats.includes(String(id)));
    if (!matchedCat) return false;
  }

  if (Array.isArray(group.keywords) && group.keywords.length > 0) {
    const strict = group.strictKeywordMatch !== false;
    const title = String(product.title ?? '');
    const description = String(product.description ?? '');
    const matchedKw = group.keywords.some((kw) => (
      keywordMatchesTitle(title, kw, { strict })
      || (description && keywordMatchesTitle(description, kw, { strict }))
    ));
    if (!matchedKw) return false;
  }

  return true;
}

export function groupFiltersMatch(group, product) {
  if (!group || !product) return false;
  if (group.inStockOnly && !product.inStock) return false;
  if (group.maxPriceSek != null) {
    if (!(product.priceSek > 0) || product.priceSek > group.maxPriceSek) return false;
  }
  if (group.minDiscountPct != null) {
    if (!((product.discountPct ?? 0) >= group.minDiscountPct)) return false;
  }
  return true;
}

export function groupMatches(group, product, productCategories = null) {
  return isGroupActive(group)
    && groupScopeMatches(group, product, productCategories)
    && groupFiltersMatch(group, product);
}

function effectiveDropThreshold(matchingGroups, config) {
  const globalThreshold = Number(config.notifyPriceDropPercent) || 0;
  if (!Array.isArray(matchingGroups) || matchingGroups.length === 0) return globalThreshold;
  const thresholds = matchingGroups
    .map((g) => (g.priceDropPct !== null && g.priceDropPct !== undefined ? Number(g.priceDropPct) : globalThreshold))
    .filter((n) => Number.isFinite(n) && n > 0);
  return thresholds.length > 0 ? Math.min(...thresholds) : 0;
}

/** Build the list of Komplett target pages to fetch for this poll. */
export function buildKomplettTargets(config, state = {}) {
  const normalized = normalizeKomplettDemoConfig(config);
  const feeds = enabledFeedIds(normalized);
  const activeGroups = (normalized.groups ?? []).filter(isGroupActive);
  if (!feeds.length) return [];
  if (!activeGroups.length && !(normalized.categories?.length > 0)) return [];

  const targets = [];

  if (feeds.includes('outlet')) {
    const outletGroups = activeGroups.filter((g) => groupCoversFeed(g, 'outlet'));
    const outletCatIds = normalizeCategoryIds([
      ...(normalized.categories ?? []),
      ...outletGroups.flatMap((g) => g.categories ?? []),
    ]);
    for (const id of outletCatIds) {
      const category = getKomplettDemoCategory(id);
      if (category) {
        targets.push({
          ...category,
          feed: 'outlet',
          pages: komplettDemoPagesFor(state.categoryStats?.[category.id]?.total),
        });
      }
    }
    const needsAllOutlet = outletGroups.some((g) => !(g.categories?.length > 0));
    if (needsAllOutlet) {
      targets.push({ ...KOMPLETT_OUTLET_ALL_TARGET, feed: 'outlet' });
    }
  }

  if (feeds.includes('deals')) {
    const dealsGroups = activeGroups.filter((g) => groupCoversFeed(g, 'deals'));
    if (dealsGroups.length > 0) {
      const includeAll = dealsGroups.some((g) => !(g.categories?.length > 0));
      const dealsCatIds = normalizeCategoryIds(dealsGroups.flatMap((g) => g.categories ?? []));
      for (const target of dealsTargetsForCategories(dealsCatIds, { includeAll })) {
        targets.push({ ...target, feed: 'deals' });
      }
    }
  }

  return targets;
}

/**
 * Apply one run's pages to the state and work out what to alert about.
 * Pure apart from mutating `state`; the poller handles fetching and Discord.
 *
 * @returns {{ alerts, okCategories, failedCategories, okFeeds, warnings, productCount, newCount }}
 */
export function applyKomplettDemoPages({ state, pages, config, nowIso, alertsEnabled = true }) {
  const normalized = normalizeKomplettDemoConfig(config);
  const activeGroups = (normalized.groups ?? []).filter(isGroupActive);
  const selected = normalized.categories.map(getKomplettDemoCategory).filter(Boolean);
  const selectedIds = new Set(selected.map((c) => c.id));
  const warnings = [];

  if (!state.seededFeeds) state.seededFeeds = {};
  if (!state.seededGroups) state.seededGroups = {};
  if (!state.feedStats) state.feedStats = {};

  // Deselecting a category forgets its seed, so re-selecting it later seeds
  // silently again instead of alerting on everything listed meanwhile.
  for (const id of Object.keys(state.seededCategories)) {
    if (!selectedIds.has(id)) delete state.seededCategories[id];
  }
  const activeGroupIds = new Set(activeGroups.map((g) => g.id));
  for (const id of Object.keys(state.seededGroups)) {
    if (!activeGroupIds.has(id)) delete state.seededGroups[id];
  }
  const activeFeeds = new Set(enabledFeedIds(normalized));
  for (const feedId of Object.keys(state.seededFeeds)) {
    if (!activeFeeds.has(feedId)) delete state.seededFeeds[feedId];
  }

  const pageByCategory = new Map();
  const extraPages = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    const id = categoryIdFromPage(page);
    const isDealsPage = page?.feed === 'deals' || String(id ?? '').startsWith('deals-');
    const isOutletAllPage = id === 'outlet-all';
    if (isDealsPage || isOutletAllPage || (id && !selectedIds.has(id))) {
      extraPages.push({ page, id, feed: isDealsPage ? 'deals' : 'outlet' });
      continue;
    }
    if (!id || !selectedIds.has(id)) continue;
    const existing = pageByCategory.get(id);
    if (!existing || (!existing.found && page.found)) pageByCategory.set(id, page);
  }

  const okCategories = [];
  const failedCategories = [];
  const checkOutletCategories = normalized.feeds?.outlet !== false || pageByCategory.size > 0;
  if (checkOutletCategories) {
    for (const category of selected) {
      const page = pageByCategory.get(category.id);
      const prev = plainObject(state.categoryStats[category.id]);
      if (!page || !page.found || !Array.isArray(page.products)) {
        failedCategories.push(category.id);
        state.categoryStats[category.id] = {
          ...prev,
          lastErrorAt: nowIso,
          lastError: page ? `No product data on the page${page.title ? ` ("${page.title}")` : ''}` : 'Page not fetched',
        };
        continue;
      }
      okCategories.push(category.id);
      if (page.sort && page.sort !== KOMPLETT_DEMO_SORT) {
        warnings.push(`${category.label}: Komplett ignored the newest-first sort (got ${page.sort}).`);
      }
      if (Number.isFinite(page.numberOfResults) && page.numberOfResults > page.products.length) {
        warnings.push(`${category.label}: Komplett lists ${page.numberOfResults} product(s) but only rendered ${page.products.length}.`);
      }
      state.categoryStats[category.id] = {
        lastFetchedAt: nowIso,
        lastCount: page.products.length,
        total: Number.isFinite(page.total) ? page.total : null,
        numberOfResults: Number.isFinite(page.numberOfResults) ? page.numberOfResults : null,
        sort: page.sort ?? null,
        lastError: null,
        lastErrorAt: prev.lastErrorAt ?? null,
      };
    }
  }
  if (failedCategories.length && okCategories.length) {
    warnings.push(`${failedCategories.length} categor${failedCategories.length === 1 ? 'y' : 'ies'} failed to load this poll.`);
  }

  const okFeedSet = new Set();
  if (okCategories.length > 0) okFeedSet.add('outlet');
  let dealsTotalCount = 0;
  let dealsTotalAvailable = 0;
  let dealsHadPage = false;
  let dealsLastError = null;
  let outletAllCount = 0;

  for (const { page, feed } of extraPages) {
    if (feed === 'deals') dealsHadPage = true;
    if (!page || !page.found || !Array.isArray(page.products)) {
      if (feed === 'deals') {
        dealsLastError = page ? `No product data on deals page${page.title ? ` ("${page.title}")` : ''}` : 'Deals page not fetched';
      }
      continue;
    }
    okFeedSet.add(feed);
    if (feed === 'deals') {
      dealsTotalCount += page.products.length;
      if (Number.isFinite(page.total)) dealsTotalAvailable += page.total;
    } else {
      outletAllCount += page.products.length;
    }
  }

  if (okCategories.length > 0 || okFeedSet.has('outlet')) {
    const outletCount = okCategories.reduce((sum, id) => sum + (state.categoryStats[id]?.lastCount ?? 0), 0) + outletAllCount;
    const outletTotal = okCategories.reduce((sum, id) => sum + (state.categoryStats[id]?.total ?? 0), 0);
    state.feedStats.outlet = {
      lastFetchedAt: nowIso,
      lastCount: outletCount,
      total: outletTotal || outletCount,
      lastError: null,
      lastErrorAt: state.feedStats.outlet?.lastErrorAt ?? null,
    };
  } else if (failedCategories.length > 0) {
    state.feedStats.outlet = {
      ...plainObject(state.feedStats.outlet),
      lastErrorAt: nowIso,
      lastError: state.categoryStats[failedCategories[0]]?.lastError ?? 'Failed to load demo categories',
    };
  }

  if (okFeedSet.has('deals')) {
    state.feedStats.deals = {
      lastFetchedAt: nowIso,
      lastCount: dealsTotalCount,
      total: dealsTotalAvailable || dealsTotalCount,
      lastError: null,
      lastErrorAt: state.feedStats.deals?.lastErrorAt ?? null,
    };
  } else if (dealsHadPage && dealsLastError) {
    state.feedStats.deals = {
      ...plainObject(state.feedStats.deals),
      lastErrorAt: nowIso,
      lastError: dealsLastError,
    };
  }

  // Dedupe by materialNumber across categories and feeds.
  const seen = new Map();
  for (const categoryId of okCategories) {
    for (const raw of pageByCategory.get(categoryId).products) {
      const product = mapKomplettDemoProduct(raw, categoryId, 'outlet');
      if (!product) continue;
      const entry = seen.get(product.id);
      if (entry) {
        if (!entry.categories.includes(categoryId)) entry.categories.push(categoryId);
      } else {
        seen.set(product.id, { product, categories: [categoryId], fromSpecificCategory: true });
      }
    }
  }

  for (const { page, id, feed } of extraPages) {
    if (!page || !page.found || !Array.isArray(page.products)) continue;
    for (const raw of page.products) {
      const product = mapKomplettDemoProduct(raw, id, feed);
      if (!product) continue;
      const catList = product.categoryId ? [product.categoryId] : [];
      // Only track products from broad department/campaign pages if they match an active watch group's scope.
      if (activeGroups.length > 0 && !activeGroups.some((g) => groupScopeMatches(g, product, catList))) {
        continue;
      }
      const entry = seen.get(product.id);
      if (entry) {
        for (const c of catList) {
          if (!entry.categories.includes(c)) entry.categories.push(c);
        }
      } else {
        seen.set(product.id, { product, categories: catList, fromSpecificCategory: false });
      }
    }
  }

  const alerts = [];
  let newCount = 0;

  // Newest-known listing per category before this run (for B-grade / outlet items).
  const newestKnown = new Map();
  for (const record of Object.values(state.products)) {
    if ((record.feed || 'outlet') !== 'outlet') continue;
    const n = numericId(record.id);
    if (n === null) continue;
    const key = String(record.categoryId);
    if (!newestKnown.has(key) || n > newestKnown.get(key)) newestKnown.set(key, n);
  }

  for (const [id, { product, categories, fromSpecificCategory }] of seen) {
    const feed = product.feed || 'outlet';
    const matchingGroups = activeGroups.filter((g) => groupMatches(g, product, categories));
    const matchesAnyGroup = matchingGroups.length > 0;
    const threshold = effectiveDropThreshold(matchingGroups, normalized);

    const seededCategories = categories.filter((c) => state.seededCategories[c]);
    const isSeededForFeed = feed === 'outlet' && fromSpecificCategory
      ? seededCategories.length > 0
      : Boolean(state.seededFeeds[feed]) && (
        matchingGroups.length === 0 || matchingGroups.some((g) => Boolean(state.seededGroups[g.id]?.[feed]))
      );

    const idNum = numericId(id);
    const olderThanKnown = feed === 'outlet' && fromSpecificCategory && idNum !== null && seededCategories.length > 0
      && seededCategories.every((c) => newestKnown.has(String(c)) && idNum < newestKnown.get(String(c)));
    const silent = !alertsEnabled || !isSeededForFeed || !matchesAnyGroup;
    const categoryId = seededCategories[0] ?? categories[0] ?? product.categoryId ?? null;
    const groupRefs = matchingGroups.map((g) => ({ id: g.id, name: g.name }));
    const existing = state.products[id];

    if (!existing) {
      newCount += 1;
      state.products[id] = {
        id,
        feed,
        title: product.title,
        description: product.description ?? null,
        url: product.url,
        imageUrl: product.imageUrl,
        priceSek: product.priceSek,
        listPriceSek: product.listPriceSek ?? null,
        discountPct: product.discountPct ?? 0,
        basePriceSek: product.priceSek,
        inStock: product.inStock,
        availabilityText: product.availabilityText,
        categoryId,
        groups: groupRefs,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        seeded: silent || olderThanKnown,
        missingSince: null,
        misses: 0,
      };
      if (!silent && !olderThanKnown) {
        alerts.push({ reason: 'new', feed, product, categoryId, groups: groupRefs });
      }
      continue;
    }

    const wasAvailable = isAvailable(existing);
    if (!silent && normalized.notifyBackInStock && !wasAvailable && product.inStock) {
      alerts.push({ reason: 'back-in-stock', feed, product, categoryId, groups: groupRefs });
      existing.basePriceSek = product.priceSek;
    } else if (!silent && threshold > 0 && existing.basePriceSek > 0 && product.priceSek > 0
      && product.priceSek < existing.basePriceSek) {
      const dropPercent = ((existing.basePriceSek - product.priceSek) / existing.basePriceSek) * 100;
      if (dropPercent >= threshold) {
        alerts.push({
          reason: 'price-drop',
          feed,
          product,
          categoryId,
          groups: groupRefs,
          previousPriceSek: existing.basePriceSek,
          dropPercent: Math.round(dropPercent * 10) / 10,
        });
        existing.basePriceSek = product.priceSek;
      }
    }

    // A price rise resets the baseline; small drops accumulate towards the threshold.
    if (product.priceSek > 0 && (!(existing.basePriceSek > 0) || product.priceSek > existing.basePriceSek)) {
      existing.basePriceSek = product.priceSek;
    }

    Object.assign(existing, {
      feed,
      title: product.title,
      description: product.description ?? existing.description ?? null,
      url: product.url,
      imageUrl: product.imageUrl ?? existing.imageUrl ?? null,
      priceSek: product.priceSek ?? existing.priceSek,
      listPriceSek: product.listPriceSek ?? existing.listPriceSek ?? null,
      discountPct: product.discountPct ?? existing.discountPct ?? 0,
      inStock: product.inStock,
      availabilityText: product.availabilityText,
      categoryId: categories.includes(existing.categoryId) ? existing.categoryId : categoryId,
      groups: groupRefs.length > 0 ? groupRefs : (existing.groups ?? []),
      lastSeenAt: nowIso,
      missingSince: null,
      misses: 0,
    });
  }

  markMissingProducts({ state, okCategories, pageByCategory, seenIds: new Set(seen.keys()), nowIso });

  for (const categoryId of okCategories) {
    if (!state.seededCategories[categoryId]) state.seededCategories[categoryId] = nowIso;
  }
  for (const feedId of okFeedSet) {
    if (!state.seededFeeds[feedId]) state.seededFeeds[feedId] = nowIso;
    for (const group of activeGroups) {
      if (!groupCoversFeed(group, feedId)) continue;
      if (!state.seededGroups[group.id]) state.seededGroups[group.id] = {};
      if (!state.seededGroups[group.id][feedId]) state.seededGroups[group.id][feedId] = nowIso;
    }
  }

  pruneProducts(state, Date.parse(nowIso));

  return {
    alerts,
    okCategories,
    failedCategories,
    okFeeds: [...okFeedSet],
    warnings,
    productCount: seen.size,
    newCount,
  };
}

/**
 * Is this page internally consistent enough to infer that absent products
 * have sold? Komplett sometimes reports results it didn't render
 * ("numberOfResults":1 with "products":[]), and an empty page is far more
 * likely a rendering glitch than a sold-out category.
 */
function isReliablePage(page) {
  if (page.sort !== KOMPLETT_DEMO_SORT) return false;
  if (!page.products.length) return false;
  if (Number.isFinite(page.numberOfResults) && page.numberOfResults !== page.products.length) return false;
  return true;
}

/**
 * Sold demo units drop off the listing rather than show "out of stock". The
 * newest-first page is in descending materialNumber order, so a known product
 * that is newer than the oldest one on the page, yet absent, has gone. When
 * the whole category fits on the page, anything absent has gone. Only
 * applied to pages that confirm the newest-first sort and are consistent.
 */
function markMissingProducts({ state, okCategories, pageByCategory, seenIds, nowIso }) {
  for (const categoryId of okCategories) {
    const page = pageByCategory.get(categoryId);
    if (!isReliablePage(page)) continue;
    const ids = page.products.map((p) => numericId(p?.materialNumber)).filter((n) => n !== null);
    if (!ids.length) continue;
    const wholeCategoryVisible = Number.isFinite(page.total)
      ? page.total <= page.products.length
      : page.products.length < PAGE_SIZE;
    const oldestOnPage = Math.min(...ids);

    for (const record of Object.values(state.products)) {
      if ((record.feed || 'outlet') !== 'outlet') continue;
      if (record.categoryId !== categoryId || seenIds.has(record.id) || record.missingSince) continue;
      const n = numericId(record.id);
      const shouldBeListed = wholeCategoryVisible || (n !== null && n > oldestOnPage);
      if (!shouldBeListed) {
        record.misses = 0;
        continue;
      }
      record.misses = (record.misses ?? 0) + 1;
      if (record.misses >= MISSES_BEFORE_GONE) record.missingSince = nowIso;
    }
  }
}

function pruneProducts(state, nowMs) {
  const entries = Object.entries(state.products);
  for (const [id, record] of entries) {
    const last = Date.parse(record.lastSeenAt ?? '');
    if (Number.isFinite(last) && nowMs - last > PRODUCT_RETENTION_MS) delete state.products[id];
  }
  const remaining = Object.values(state.products);
  if (remaining.length > MAX_PRODUCTS) {
    remaining
      .sort((a, b) => Date.parse(a.lastSeenAt ?? 0) - Date.parse(b.lastSeenAt ?? 0))
      .slice(0, remaining.length - MAX_PRODUCTS)
      .forEach((record) => delete state.products[record.id]);
  }
}

function describeAlert(alert, nowIso, delivered, note = null) {
  const category = getKomplettDemoCategory(alert.categoryId);
  return {
    at: nowIso,
    reason: alert.reason,
    feed: alert.feed ?? alert.product?.feed ?? 'outlet',
    id: alert.product.id,
    title: alert.product.title,
    url: alert.product.url,
    imageUrl: alert.product.imageUrl,
    priceSek: alert.product.priceSek,
    listPriceSek: alert.product.listPriceSek ?? null,
    discountPct: alert.product.discountPct ?? 0,
    previousPriceSek: alert.previousPriceSek ?? null,
    dropPercent: alert.dropPercent ?? null,
    availabilityText: alert.product.availabilityText,
    inStock: alert.product.inStock,
    categoryId: alert.categoryId,
    categoryLabel: category?.label ?? alert.categoryId,
    groups: Array.isArray(alert.groups) ? alert.groups.map((g) => g.name || g.id) : [],
    delivered,
    note,
  };
}

// ── Poller ─────────────────────────────────────────────────────

export function createKomplettDemoPoller({
  getConfig,
  notifier = null,
  persistence = null,
  // Called with the watcher state after every successful check, once it is
  // persisted; src/index.js mirrors the products into the main listing.
  onStateChange = null,
  fetchPages = fetchKomplettDemoPages,
  fetchRunUsage = fetchApifyRunUsage,
  // Thumbnails for alerts, fetched via Apify (Discord can't load komplett.se).
  fetchImages = fetchKomplettImages,
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
  let state = createEmptyKomplettDemoState();

  try {
    state = normalizeKomplettDemoState(persistence?.load?.());
  } catch (error) {
    logger.warn?.(`[komplett-demo] Could not load saved state, starting fresh: ${error.message}`);
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

  const readConfig = () => normalizeKomplettDemoConfig(getConfig?.() ?? {});

  async function persist() {
    if (!persistence?.save) return;
    try {
      await persistence.save(state);
    } catch (error) {
      logger.error?.(`[komplett-demo] Failed to save state: ${error.message}`);
    }
  }

  function isProxyMode() {
    if (state.lastRun?.runStatus === 'PROXY') return true;
    if (!state.lastRun && fetchPages === fetchKomplettDemoPages && resolveWatcherProxyUrl('KOMPLETT')) return true;
    return false;
  }

  function costGuard(config = readConfig(), nowMs = now()) {
    const targets = buildKomplettTargets(config, state);
    return computeCostGuard({
      usage: state.usage,
      config,
      urlCount: targets.length,
      nowMs,
      costModel: isProxyMode() ? ZERO_COST_MODEL : COST_MODEL,
    });
  }

  function nextDelayMs() {
    const config = readConfig();
    return computeNextDelayMs({
      config,
      consecutiveFailures,
      costGuardIntervalMs: costGuard(config).intervalMs,
      random,
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
      tick().catch((error) => logger.error?.('[komplett-demo]', error.message));
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
      logger.warn?.(`[komplett-demo] Could not read settled cost of run ${pending.id}: ${error.message}`);
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
    if (notifier?.notifyKomplettDemo && toSend.length) {
      let images = {};
      if (fetchImages) {
        try {
          const fetched = await fetchImages({ ids: toSend.map((entry) => entry.alert?.product?.id) });
          images = fetched?.images ?? {};
          if (fetched?.runId) {
            // Count the extra run's cost; settled later like the poll runs.
            const usd = await fetchRunUsage({ runId: fetched.runId }).catch(() => null);
            state.usage.usd += Number.isFinite(usd) ? usd : 0.0003;
          }
        } catch (error) {
          logger.warn?.(`[komplett-demo] Alert images unavailable: ${error.message}`);
        }
      }
      try {
        result = await notifier.notifyKomplettDemo({
          alerts: toSend.map((entry) => entry.alert),
          webhookUrl: config.discordWebhookUrl,
          images,
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
      // Retries already have a recent-alerts row; only record the final outcome once.
      if (entry.attempts === 0 || delivered) {
        records.push(describeAlert(entry.alert, nowIso, delivered, delivered ? null : (noWebhook ? 'No Discord webhook configured' : 'Discord delivery failed')));
      }
    });
    for (const entry of overflow) {
      records.push(describeAlert(entry.alert, nowIso, false, 'Too many alerts in one poll'));
    }

    state.pendingAlerts = state.pendingAlerts.slice(0, MAX_PENDING_ALERTS);
    state.recentAlerts = [...records, ...state.recentAlerts].slice(0, MAX_RECENT_ALERTS);
    if (result.errors?.length) logger.warn?.(`[komplett-demo] Discord: ${result.errors.join('; ')}`);
    return { sent: result.sent ?? 0, failed: result.failed ?? 0, skipped: result.skipped ?? 0 };
  }

  async function runPoll({ manual }) {
    const config = readConfig();
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    rollUsageMonth(state.usage, nowMs);

    const categories = buildKomplettTargets(config, state);
    if (!categories.length) throw new Error('Select at least one Komplett watch group or category first.');

    await settlePreviousRunCost();

    let response;
    try {
      response = await fetchPages({ categories });
    } catch (error) {
      state.lastRun = { at: nowIso, ok: false, manual, error: error.message, urls: categories.length };
      await persist();
      throw error;
    }

    const { run = {}, pages = [] } = response ?? {};
    const estimate = estimateRunUsd(state.usage, categories.length);
    const recordedUsd = Number.isFinite(run.usageTotalUsd) ? run.usageTotalUsd : estimate;
    state.usage.runs += 1;
    state.usage.urls += categories.length;
    state.usage.usd += recordedUsd;
    state.pendingUsageRun = run.id ? { id: run.id, recordedUsd, month: state.usage.month } : null;

    const runInfo = {
      at: nowIso,
      manual,
      runId: run.id ?? null,
      runStatus: run.status ?? null,
      usd: recordedUsd,
      urls: categories.length,
      runTimeSecs: run.runTimeSecs ?? null,
    };

    const outcome = applyKomplettDemoPages({ state, pages, config, nowIso, alertsEnabled: config.enabled });

    if (!outcome.okCategories.length && !outcome.okFeeds?.length) {
      const message = run.status && run.status !== 'SUCCEEDED'
        ? `Apify run ${run.status} without usable pages`
        : 'No category page returned product data (blocked or layout change?)';
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
      alerts: outcome.alerts.length,
      sent: delivery.sent,
      failedCategories: outcome.failedCategories,
    };
    await persist();

    if (onStateChange) {
      try {
        await onStateChange(state);
      } catch (error) {
        logger.error?.(`[komplett-demo] Listing update failed: ${error.message}`);
      }
    }

    return {
      count: outcome.productCount,
      newCount: outcome.newCount,
      alertCount: outcome.alerts.length,
      sent: delivery.sent,
      warnings: outcome.warnings,
      failedCategories: outcome.failedCategories,
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
    const targets = buildKomplettTargets(config, state);
    if (!manual && !targets.length) {
      status.lastSkipReason = 'no-categories';
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
        logger.error?.(`[komplett-demo] Poll failed (${consecutiveFailures} in a row): ${error.message}`);
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
    // polling immediately: that keeps the cadence irregular and the bill flat.
    const lastAt = Date.parse(state.lastRun?.at ?? '');
    const next = nextDelayMs();
    if (Number.isFinite(lastAt)) {
      const remaining = lastAt + next - now();
      if (remaining > 0) return remaining;
    }
    return Math.round(15_000 + random() * 30_000);
  }

  function selectedCategoryStatus(config) {
    const tracked = new Map();
    for (const record of Object.values(state.products)) {
      tracked.set(record.categoryId, (tracked.get(record.categoryId) ?? 0) + 1);
    }
    return config.categories.map((id) => {
      const category = getKomplettDemoCategory(id);
      const stats = plainObject(state.categoryStats[id]);
      return {
        id,
        label: category?.label ?? id,
        group: category?.group ?? null,
        groupLabel: category?.groupLabel ?? null,
        url: category ? buildKomplettDemoUrl(category) : null,
        seeded: Boolean(state.seededCategories[id]),
        seededAt: state.seededCategories[id] ?? null,
        lastCount: stats.lastCount ?? null,
        total: stats.total ?? null,
        tracked: tracked.get(id) ?? 0,
        lastFetchedAt: stats.lastFetchedAt ?? null,
        lastError: stats.lastError ?? null,
      };
    });
  }

  function feedStatus(config) {
    return Object.values(KOMPLETT_FEEDS).map((feed) => {
      const stats = plainObject(state.feedStats?.[feed.id]);
      const enabled = Boolean(config.feeds?.[feed.id]);
      const seeded = feed.id === 'outlet'
        ? Boolean(state.seededFeeds?.outlet || Object.keys(state.seededCategories).length > 0)
        : Boolean(state.seededFeeds?.[feed.id]);
      const seededAt = state.seededFeeds?.[feed.id]
        ?? (feed.id === 'outlet' ? Object.values(state.seededCategories)[0] ?? null : null);
      return {
        id: feed.id,
        label: feed.label,
        shortLabel: feed.shortLabel,
        url: feed.url,
        enabled,
        seeded,
        seededAt,
        lastCount: stats.lastCount ?? null,
        total: stats.total ?? null,
        lastFetchedAt: stats.lastFetchedAt ?? null,
        lastError: stats.lastError ?? null,
      };
    });
  }

  function groupStatus(config) {
    return (config.groups ?? []).map((group) => ({
      ...group,
      active: isGroupActive(group),
      seeded: state.seededGroups?.[group.id] ?? {},
    }));
  }

  function latestFinds(config, limit = 25) {
    const activeGroups = (config.groups ?? []).filter(isGroupActive);
    const selected = new Set(config.categories);
    return Object.values(state.products)
      .filter((record) => {
        if (!isAvailable(record)) return false;
        const feed = record.feed || 'outlet';
        if (config.feeds?.[feed] === false) return false;
        if (activeGroups.length > 0) {
          return activeGroups.some((g) => groupMatches(g, record));
        }
        return selected.has(record.categoryId);
      })
      .sort((a, b) => (Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt))
        || ((numericId(b.id) ?? 0) - (numericId(a.id) ?? 0)))
      .slice(0, limit)
      .map((record) => {
        const matched = activeGroups.filter((g) => groupMatches(g, record));
        return {
          id: record.id,
          feed: record.feed || 'outlet',
          title: record.title,
          url: record.url,
          imageUrl: record.imageUrl,
          priceSek: record.priceSek,
          listPriceSek: record.listPriceSek ?? null,
          discountPct: record.discountPct ?? 0,
          availabilityText: record.availabilityText,
          categoryId: record.categoryId,
          categoryLabel: getKomplettDemoCategory(record.categoryId)?.label ?? record.categoryId,
          groups: matched.length ? matched.map((g) => g.name) : (record.groups ?? []).map((g) => g.name || g.id),
          firstSeenAt: record.firstSeenAt,
          seeded: Boolean(record.seeded),
        };
      });
  }

  function getStatus() {
    const config = readConfig();
    const nowMs = now();
    const guard = costGuard(config, nowMs);
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
      groups: groupStatus(config),
      categories: selectedCategoryStatus(config),
      trackedProducts: Object.keys(state.products).length,
      pendingAlerts: state.pendingAlerts.length,
      recentAlerts: state.recentAlerts.slice(0, 20),
      latestFinds: latestFinds(config),
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
    getCatalog: () => KOMPLETT_DEMO_CATALOG,
    /** For tests and diagnostics. */
    getState: () => state,
  };
}
