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
 * in its own SQLite row so a restart never re-alerts.
 */

import {
  KOMPLETT_DEMO_SORT,
  buildKomplettDemoUrl,
  fetchApifyRunUsage,
  fetchKomplettDemoPages,
  mapKomplettDemoProduct,
} from '../sources/komplett.js';
import { getKomplettDemoCategory, normalizeKomplettDemoConfig } from './komplettDemoConfig.js';

export const MIN_DELAY_MS = 5 * 60 * 1000;
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
    version: 1,
    products: {},
    seededCategories: {},
    categoryStats: {},
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
  return {
    ...empty,
    products: plainObject(input.products),
    seededCategories: plainObject(input.seededCategories),
    categoryStats: plainObject(input.categoryStats),
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

function modelRunUsd(urlCount) {
  return COST_MODEL.perRunUsd + COST_MODEL.perUrlUsd * Math.max(urlCount, 0);
}

/** Expected cost of one run with `urlCount` URLs, calibrated on this month's real runs. */
export function estimateRunUsd(usage, urlCount) {
  const model = modelRunUsd(urlCount);
  if (!usage || usage.runs < 3 || !(usage.usd > 0)) return model;
  const modelled = usage.runs * COST_MODEL.perRunUsd + usage.urls * COST_MODEL.perUrlUsd;
  if (!(modelled > 0)) return model;
  // Bounded so one odd run can't swing the guard wildly.
  const scale = Math.min(Math.max(usage.usd / modelled, 0.25), 4);
  return model * scale;
}

/**
 * How long the interval must be for the rest of the month to fit the budget.
 * `intervalMs` is never shorter than the configured base interval.
 */
export function computeCostGuard({ usage, config, urlCount, nowMs }) {
  const current = usage?.month === monthKey(nowMs) ? usage : { month: monthKey(nowMs), usd: 0, runs: 0, urls: 0 };
  const baseIntervalMs = config.intervalMinutes * 60 * 1000;
  const maxUsd = config.maxMonthlyUsd;
  const spentUsd = current.usd;
  const estimatedRunUsd = estimateRunUsd(current, urlCount);
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
export function computeNextDelayMs({ config, consecutiveFailures = 0, costGuardIntervalMs = 0, random = Math.random }) {
  const base = Math.max(config.intervalMinutes * 60 * 1000, costGuardIntervalMs || 0, MIN_DELAY_MS);
  const ceiling = Math.max(MAX_BACKOFF_MS, base);
  let delay = base;
  if (consecutiveFailures > 0) {
    delay = Math.max(base, Math.min(base * 2 ** Math.min(consecutiveFailures, 8), MAX_BACKOFF_MS));
  }
  const jitterPct = Math.min(Math.max(Number(config.jitterPct) || 0, 0), 50);
  if (jitterPct) {
    const spread = delay * (jitterPct / 100);
    delay = delay - spread + random() * spread * 2;
  }
  if (consecutiveFailures > 0) delay = Math.min(delay, ceiling);
  return Math.round(Math.max(MIN_DELAY_MS, delay));
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

/**
 * Apply one run's pages to the state and work out what to alert about.
 * Pure apart from mutating `state`; the poller handles fetching and Discord.
 *
 * @returns {{ alerts, okCategories, failedCategories, warnings, productCount, newCount }}
 */
export function applyKomplettDemoPages({ state, pages, config, nowIso, alertsEnabled = true }) {
  const selected = config.categories.map(getKomplettDemoCategory).filter(Boolean);
  const selectedIds = new Set(selected.map((c) => c.id));
  const warnings = [];

  // Deselecting a category forgets its seed, so re-selecting it later seeds
  // silently again instead of alerting on everything listed meanwhile.
  for (const id of Object.keys(state.seededCategories)) {
    if (!selectedIds.has(id)) delete state.seededCategories[id];
  }

  const pageByCategory = new Map();
  for (const page of Array.isArray(pages) ? pages : []) {
    const id = categoryIdFromPage(page);
    if (!id || !selectedIds.has(id)) continue;
    const existing = pageByCategory.get(id);
    if (!existing || (!existing.found && page.found)) pageByCategory.set(id, page);
  }

  const okCategories = [];
  const failedCategories = [];
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
  if (failedCategories.length && okCategories.length) {
    warnings.push(`${failedCategories.length} categor${failedCategories.length === 1 ? 'y' : 'ies'} failed to load this poll.`);
  }

  // Dedupe by materialNumber across categories.
  const seen = new Map();
  for (const categoryId of okCategories) {
    for (const raw of pageByCategory.get(categoryId).products) {
      const product = mapKomplettDemoProduct(raw, categoryId);
      if (!product) continue;
      const entry = seen.get(product.id);
      if (entry) entry.categories.push(categoryId);
      else seen.set(product.id, { product, categories: [categoryId] });
    }
  }

  const alerts = [];
  let newCount = 0;
  const threshold = config.notifyPriceDropPercent;

  for (const [id, { product, categories }] of seen) {
    const seededCategories = categories.filter((c) => state.seededCategories[c]);
    const silent = !alertsEnabled || seededCategories.length === 0;
    const categoryId = seededCategories[0] ?? categories[0];
    const existing = state.products[id];

    if (!existing) {
      newCount += 1;
      state.products[id] = {
        id,
        title: product.title,
        url: product.url,
        imageUrl: product.imageUrl,
        priceSek: product.priceSek,
        basePriceSek: product.priceSek,
        inStock: product.inStock,
        availabilityText: product.availabilityText,
        categoryId,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        seeded: silent,
        missingSince: null,
        misses: 0,
      };
      if (!silent) alerts.push({ reason: 'new', product, categoryId });
      continue;
    }

    const wasAvailable = isAvailable(existing);
    if (!silent && config.notifyBackInStock && !wasAvailable && product.inStock) {
      alerts.push({ reason: 'back-in-stock', product, categoryId });
      existing.basePriceSek = product.priceSek;
    } else if (!silent && threshold > 0 && existing.basePriceSek > 0 && product.priceSek > 0
      && product.priceSek < existing.basePriceSek) {
      const dropPercent = ((existing.basePriceSek - product.priceSek) / existing.basePriceSek) * 100;
      if (dropPercent >= threshold) {
        alerts.push({
          reason: 'price-drop',
          product,
          categoryId,
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
      title: product.title,
      url: product.url,
      imageUrl: product.imageUrl ?? existing.imageUrl ?? null,
      priceSek: product.priceSek ?? existing.priceSek,
      inStock: product.inStock,
      availabilityText: product.availabilityText,
      categoryId: categories.includes(existing.categoryId) ? existing.categoryId : categoryId,
      lastSeenAt: nowIso,
      missingSince: null,
      misses: 0,
    });
  }

  markMissingProducts({ state, okCategories, pageByCategory, seenIds: new Set(seen.keys()), nowIso });

  for (const categoryId of okCategories) {
    if (!state.seededCategories[categoryId]) state.seededCategories[categoryId] = nowIso;
  }

  pruneProducts(state, Date.parse(nowIso));

  return { alerts, okCategories, failedCategories, warnings, productCount: seen.size, newCount };
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
    id: alert.product.id,
    title: alert.product.title,
    url: alert.product.url,
    imageUrl: alert.product.imageUrl,
    priceSek: alert.product.priceSek,
    previousPriceSek: alert.previousPriceSek ?? null,
    dropPercent: alert.dropPercent ?? null,
    availabilityText: alert.product.availabilityText,
    inStock: alert.product.inStock,
    categoryId: alert.categoryId,
    categoryLabel: category?.label ?? alert.categoryId,
    delivered,
    note,
  };
}

// ── Poller ─────────────────────────────────────────────────────

export function createKomplettDemoPoller({
  getConfig,
  notifier = null,
  persistence = null,
  fetchPages = fetchKomplettDemoPages,
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

  function costGuard(config = readConfig(), nowMs = now()) {
    return computeCostGuard({ usage: state.usage, config, urlCount: config.categories.length, nowMs });
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
      try {
        result = await notifier.notifyKomplettDemo({
          alerts: toSend.map((entry) => entry.alert),
          webhookUrl: config.discordWebhookUrl,
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

    const categories = config.categories.map(getKomplettDemoCategory).filter(Boolean);
    if (!categories.length) throw new Error('Select at least one Komplett demo category first.');

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

    if (!outcome.okCategories.length) {
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
    if (!manual && !config.categories.length) {
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

  function latestFinds(config, limit = 20) {
    const selected = new Set(config.categories);
    return Object.values(state.products)
      .filter((record) => selected.has(record.categoryId) && isAvailable(record))
      .sort((a, b) => (Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt))
        || ((numericId(b.id) ?? 0) - (numericId(a.id) ?? 0)))
      .slice(0, limit)
      .map((record) => ({
        id: record.id,
        title: record.title,
        url: record.url,
        imageUrl: record.imageUrl,
        priceSek: record.priceSek,
        availabilityText: record.availabilityText,
        categoryId: record.categoryId,
        categoryLabel: getKomplettDemoCategory(record.categoryId)?.label ?? record.categoryId,
        firstSeenAt: record.firstSeenAt,
        seeded: Boolean(record.seeded),
      }));
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
    /** For tests and diagnostics. */
    getState: () => state,
  };
}
