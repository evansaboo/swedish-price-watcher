import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { firstFinite } from './lib/utils.js';
import { buildProductSummaries } from './services/dealEngine.js';

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function matchesQuery(value, query) {
  return !query || String(value ?? '').toLowerCase().includes(query);
}

function normalizeCategoryKey(category) {
  return String(category ?? '').trim().toLowerCase();
}

function getFavoriteCategories(state) {
  return Array.isArray(state.preferences?.favoriteCategories)
    ? state.preferences.favoriteCategories.map((category) => String(category).trim()).filter(Boolean)
    : [];
}

function getFavoriteCategorySet(state) {
  return new Set(getFavoriteCategories(state).map((category) => normalizeCategoryKey(category)));
}

function normalizeFavoriteCategories(categories) {
  const unique = new Map();

  for (const category of Array.isArray(categories) ? categories : []) {
    const label = String(category ?? '').trim();
    const key = normalizeCategoryKey(label);

    if (!key || unique.has(key)) {
      continue;
    }

    unique.set(key, label);
  }

  return [...unique.values()].sort((left, right) => left.localeCompare(right, 'sv-SE'));
}

function filterDeals(deals, query) {
  const search = String(query.search ?? '').trim().toLowerCase();
  const category = String(query.category ?? '').trim().toLowerCase();
  const condition = String(query.condition ?? '').trim().toLowerCase();
  const sourceId = String(query.sourceId ?? '').trim().toLowerCase();
  const amazingOnly = String(query.amazingOnly ?? 'false') === 'true';

  return deals.filter((deal) => {
    if (amazingOnly && !deal.amazingDeal) {
      return false;
    }

    return (
      (!category || normalizeCategoryKey(deal.category) === category) &&
      (!condition || deal.condition.toLowerCase() === condition) &&
      (!sourceId || deal.sourceId.toLowerCase() === sourceId) &&
      (matchesQuery(deal.title, search) || matchesQuery(deal.sourceLabel, search))
    );
  });
}

function filterProducts(products, query) {
  const search = String(query.search ?? '').trim().toLowerCase();
  const category = String(query.category ?? '').trim().toLowerCase();
  const condition = String(query.condition ?? '').trim().toLowerCase();
  const amazingOnly = String(query.amazingOnly ?? 'false') === 'true';

  return products.filter((product) => {
    if (amazingOnly && product.amazingOfferCount === 0) {
      return false;
    }

    return (
      (!category || normalizeCategoryKey(product.category) === category) &&
      (!condition || product.offers.some((offer) => offer.condition.toLowerCase() === condition)) &&
      matchesQuery(product.title, search)
    );
  });
}

function describeSourceStatus(source, sourceState = {}) {
  if (!source.enabled) {
    return 'disabled';
  }

  if (sourceState.disabledUntil) {
    return 'cooling-down';
  }

  if (sourceState.lastError) {
    return 'error';
  }

  if (sourceState.lastSuccessAt) {
    return 'healthy';
  }

  return 'idle';
}

function buildOutletProducts(state) {
  return Object.values(state.items)
    .filter((item) => item.condition === 'outlet' && Number.isFinite(item.latestPriceSek))
    .map((item) => {
      const initialPriceSek = firstFinite(item.referencePriceSek, item.marketValueSek);
      const discountSek = Number.isFinite(initialPriceSek) ? Math.max(0, initialPriceSek - item.latestPriceSek) : null;
      const discountPercent =
        Number.isFinite(initialPriceSek) && initialPriceSek > 0
          ? Math.max(0, Math.round((discountSek / initialPriceSek) * 100))
          : null;

      return {
        listingKey: item.listingKey,
        title: item.title,
        url: item.url,
        category: item.category,
        sourceId: item.sourceId,
        sourceLabel: item.sourceLabel,
        currentPriceSek: item.latestPriceSek,
        initialPriceSek,
        discountSek,
        discountPercent,
        referenceMatched: Number.isFinite(initialPriceSek),
        referenceMatchType: item.referenceMatchType ?? null,
        referenceTitle: item.referenceTitle ?? null,
        referenceUrl: item.referenceUrl ?? null,
        availability: item.availability ?? 'unknown',
        firstSeenAt: item.firstSeenAt ?? null,
        lastSeenAt: item.lastSeenAt ?? null,
        imageUrl: item.imageUrl ?? null
      };
    })
    .sort((left, right) => {
      const rightDiscount = Number.isFinite(right.discountPercent) ? right.discountPercent : -1;
      const leftDiscount = Number.isFinite(left.discountPercent) ? left.discountPercent : -1;

      if (rightDiscount !== leftDiscount) {
        return rightDiscount - leftDiscount;
      }

      const rightDiscountSek = Number.isFinite(right.discountSek) ? right.discountSek : -1;
      const leftDiscountSek = Number.isFinite(left.discountSek) ? left.discountSek : -1;

      if (rightDiscountSek !== leftDiscountSek) {
        return rightDiscountSek - leftDiscountSek;
      }

      return left.currentPriceSek - right.currentPriceSek;
    });
}

function filterOutletProducts(products, query, favoriteCategorySet) {
  const search = String(query.search ?? '').trim().toLowerCase();
  const category = String(query.category ?? '').trim().toLowerCase();
  const favoritesOnly = String(query.favoritesOnly ?? 'false') === 'true';
  const discountedOnly = String(query.discountedOnly ?? 'false') === 'true';
  const referenceOnly = String(query.referenceOnly ?? 'false') === 'true';
  const minDiscountPercent = Number.parseInt(String(query.minDiscountPercent ?? ''), 10);
  const maxPriceSek = Number.parseInt(String(query.maxPriceSek ?? query.maxPrice ?? ''), 10);

  return products.filter((product) => {
    const productCategoryKey = normalizeCategoryKey(product.category);

    if (favoritesOnly && !favoriteCategorySet.has(productCategoryKey)) {
      return false;
    }

    if (discountedOnly && !(Number.isFinite(product.discountSek) && product.discountSek > 0)) {
      return false;
    }

    if (referenceOnly && !Number.isFinite(product.initialPriceSek)) {
      return false;
    }

    if (Number.isFinite(minDiscountPercent) && minDiscountPercent > 0) {
      if (!(Number.isFinite(product.discountPercent) && product.discountPercent >= minDiscountPercent)) {
        return false;
      }
    }

    if (Number.isFinite(maxPriceSek) && maxPriceSek > 0 && product.currentPriceSek > maxPriceSek) {
      return false;
    }

    return (
      (!category || productCategoryKey === category) &&
      (matchesQuery(product.title, search) || matchesQuery(product.category, search))
    );
  });
}

function buildOutletCategoryStats(products, favoriteCategorySet) {
  const categories = new Map();

  for (const product of products) {
    const key = normalizeCategoryKey(product.category);

    if (!key) {
      continue;
    }

    if (!categories.has(key)) {
      categories.set(key, {
        name: product.category,
        key,
        count: 0,
        discountedCount: 0,
        favorite: favoriteCategorySet.has(key)
      });
    }

    const category = categories.get(key);
    category.count += 1;

    if (Number.isFinite(product.discountSek) && product.discountSek > 0) {
      category.discountedCount += 1;
    }
  }

  return [...categories.values()].sort((left, right) => left.name.localeCompare(right.name, 'sv-SE'));
}

function normalizeSchedulerUpdate(payload) {
  const normalized = {};

  if (payload?.enabled !== undefined) {
    normalized.enabled = Boolean(payload.enabled);
  }

  if (payload?.intervalMinutes !== undefined) {
    const intervalMinutes = Number.parseInt(String(payload.intervalMinutes), 10);

    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      throw new Error('intervalMinutes must be a positive integer.');
    }

    normalized.intervalMinutes = intervalMinutes;
  }

  if (payload?.activeWindow !== undefined) {
    if (!payload.activeWindow || typeof payload.activeWindow !== 'object' || Array.isArray(payload.activeWindow)) {
      throw new Error('activeWindow must be an object.');
    }

    const activeWindow = {};

    if (payload.activeWindow.enabled !== undefined) {
      activeWindow.enabled = Boolean(payload.activeWindow.enabled);
    }

    if (payload.activeWindow.startTime !== undefined) {
      const startTime = String(payload.activeWindow.startTime).trim();

      if (!TIME_OF_DAY_PATTERN.test(startTime)) {
        throw new Error('activeWindow.startTime must use HH:MM format.');
      }

      activeWindow.startTime = startTime;
    }

    if (payload.activeWindow.endTime !== undefined) {
      const endTime = String(payload.activeWindow.endTime).trim();

      if (!TIME_OF_DAY_PATTERN.test(endTime)) {
        throw new Error('activeWindow.endTime must use HH:MM format.');
      }

      activeWindow.endTime = endTime;
    }

    if (payload.activeWindow.timeZone !== undefined) {
      const timeZone = String(payload.activeWindow.timeZone).trim();

      if (!timeZone) {
        throw new Error('activeWindow.timeZone cannot be empty.');
      }

      activeWindow.timeZone = timeZone;
    }

    if (!Object.keys(activeWindow).length) {
      throw new Error('activeWindow must include enabled, startTime, endTime, or timeZone.');
    }

    normalized.activeWindow = activeWindow;
  }

  return normalized;
}

function buildSchedulerStatus(schedulerState, lastRunStartedAt) {
  if (!schedulerState) {
    return null;
  }

  if (schedulerState.nextRunAt) {
    return schedulerState;
  }

  if (!schedulerState.enabled) {
    return schedulerState;
  }

  const intervalMinutes = Number.parseInt(String(schedulerState.intervalMinutes ?? ''), 10);
  const lastRunTimestamp = Date.parse(lastRunStartedAt ?? '');

  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0 || Number.isNaN(lastRunTimestamp)) {
    return schedulerState;
  }

  return {
    ...schedulerState,
    nextRunAt: new Date(lastRunTimestamp + intervalMinutes * 60 * 1000).toISOString()
  };
}

function evaluateScheduledScan(schedulerState, lastRunStartedAt, isRunning) {
  if (isRunning) {
    return { shouldRun: false, reason: 'scan-running' };
  }

  if (!schedulerState?.enabled) {
    return { shouldRun: false, reason: 'scheduler-disabled' };
  }

  if (schedulerState.activeWindow?.enabled && schedulerState.isInActiveWindow === false) {
    return { shouldRun: false, reason: 'outside-active-window' };
  }

  const intervalMinutes = Number.parseInt(String(schedulerState.intervalMinutes ?? ''), 10);

  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    return { shouldRun: false, reason: 'invalid-interval' };
  }

  const now = Date.now();
  const lastRunTimestamp = Date.parse(lastRunStartedAt ?? '');

  if (!Number.isNaN(lastRunTimestamp)) {
    const elapsedMs = now - lastRunTimestamp;
    const intervalMs = intervalMinutes * 60 * 1000;

    if (elapsedMs < intervalMs) {
      return {
        shouldRun: false,
        reason: 'not-due',
        nextRunAt: new Date(lastRunTimestamp + intervalMs).toISOString()
      };
    }
  }

  return { shouldRun: true };
}

export async function buildApp({ config, store, scanState, triggerScan, scheduler, manualRunMode = 'background', serveStatic = true }) {
  const app = Fastify({ logger: false });

  if (serveStatic) {
    try {
      await app.register(fastifyStatic, {
        root: config.publicDir,
        index: ['index.html']
      });
    } catch (error) {
      console.error('[static]', error.message);
    }
  }

  async function runScheduledScanIfDue() {
    if (manualRunMode !== 'blocking' || !scheduler?.getState) {
      return { ran: false, reason: 'disabled' };
    }

    if (!config.sources.some((source) => source.enabled)) {
      return { ran: false, reason: 'no-enabled-sources' };
    }

    const state = store.getState();
    const schedulerState = buildSchedulerStatus(scheduler.getState(), state.stats.lastRunStartedAt);
    const decision = evaluateScheduledScan(schedulerState, state.stats.lastRunStartedAt, scanState.running);

    if (!decision.shouldRun) {
      return { ran: false, reason: decision.reason };
    }

    await triggerScan('scheduled');
    return { ran: true, reason: 'scheduled' };
  }

  app.get('/health', async () => ({ ok: true }));

  app.get('/api/status', async () => {
    if (manualRunMode === 'blocking') {
      try {
        await runScheduledScanIfDue();
      } catch (error) {
        scanState.lastError = error.message;
      }
    }

    const state = store.getState();
    const sourceStatuses = config.sources.map((source) => describeSourceStatus(source, state.sourceStates[source.id]));
    const currentSource = config.sources.find((source) => source.id === scanState.currentSourceId);
    const schedulerState = buildSchedulerStatus(scheduler?.getState?.() ?? null, state.stats.lastRunStartedAt);

    return {
      isRunning: scanState.running,
      lastError: scanState.lastError,
      lastRunStartedAt: state.stats.lastRunStartedAt,
      lastRunCompletedAt: state.stats.lastRunCompletedAt,
      lastRunSummary: state.stats.lastRunSummary,
      scanProgress: {
        startedAt: scanState.startedAt,
        currentSourceId: scanState.currentSourceId,
        currentSourceLabel: currentSource?.label ?? scanState.currentSourceId,
        completedSources: scanState.completedSources,
        totalSources: scanState.totalSources
      },
      counts: {
        trackedItems: Object.keys(state.items).length,
        deals: state.deals.length,
        amazingDeals: state.deals.filter((deal) => deal.amazingDeal).length,
        enabledSources: config.sources.filter((source) => source.enabled).length,
        healthySources: sourceStatuses.filter((status) => status === 'healthy').length,
        blockedSources: sourceStatuses.filter((status) => status === 'error' || status === 'cooling-down').length,
        outletItems: state.deals.filter((deal) => deal.condition === 'outlet').length,
        referencedItems: state.deals.filter((deal) => deal.comparisonPriceSek > deal.currentPriceSek).length,
        favoriteCategories: getFavoriteCategories(state).length
      },
      scheduler: schedulerState
    };
  });

  app.get('/api/categories', async () => {
    const categories = new Set();

    for (const item of Object.values(store.getState().items)) {
      categories.add(item.category);
    }

    return [...categories].filter(Boolean).sort((left, right) => left.localeCompare(right, 'sv-SE'));
  });

  app.get('/api/deals', async (request) => filterDeals(store.getState().deals, request.query));
  app.get('/api/products', async (request) => filterProducts(buildProductSummaries(store.getState()), request.query));

  app.get('/api/outlet-products', async (request) => {
    const state = store.getState();
    const favoriteCategorySet = getFavoriteCategorySet(state);
    return filterOutletProducts(buildOutletProducts(state), request.query, favoriteCategorySet);
  });

  app.get('/api/outlet-categories', async () => {
    const state = store.getState();
    const favoriteCategorySet = getFavoriteCategorySet(state);
    return buildOutletCategoryStats(buildOutletProducts(state), favoriteCategorySet);
  });

  app.get('/api/preferences', async () => ({
    favoriteCategories: getFavoriteCategories(store.getState())
  }));

  app.put('/api/preferences/favorite-categories', async (request) => {
    const state = store.getState();
    const categories = normalizeFavoriteCategories(request.body?.categories);

    state.preferences = {
      ...(state.preferences ?? {}),
      favoriteCategories: categories
    };

    if (typeof store.save === 'function') {
      await store.save();
    }

    return {
      favoriteCategories: categories
    };
  });

  app.get('/api/scheduler', async (_, reply) => {
    if (!scheduler?.getState) {
      reply.code(404);
      return { message: 'Scheduler is unavailable.' };
    }

    return scheduler.getState();
  });

  app.put('/api/scheduler', async (request, reply) => {
    if (!scheduler?.update) {
      reply.code(404);
      return { message: 'Scheduler is unavailable.' };
    }

    let update;

    try {
      update = normalizeSchedulerUpdate(request.body ?? {});
    } catch (error) {
      reply.code(400);
      return { message: error.message };
    }

    if (!Object.keys(update).length) {
      reply.code(400);
      return { message: 'Provide enabled, intervalMinutes, or activeWindow.' };
    }

    try {
      return await scheduler.update(update);
    } catch (error) {
      reply.code(400);
      return { message: error.message };
    }
  });

  app.get('/api/sources', async () => {
    const state = store.getState();

    return config.sources.map((source) => ({
      ...source,
      status: describeSourceStatus(source, state.sourceStates[source.id]),
      state: state.sourceStates[source.id] ?? {}
    }));
  });

  app.post('/api/run', async (_, reply) => {
    if (scanState.running) {
      reply.code(409);
      return { ok: false, message: 'A scan is already running.' };
    }

    if (!config.sources.some((source) => source.enabled)) {
      reply.code(400);
      return {
        ok: false,
        message: 'No sources are enabled. Add or enable a source in config/sources.json.'
      };
    }

    if (manualRunMode === 'blocking') {
      const summary = await triggerScan('manual');
      return {
        ok: true,
        started: true,
        completed: true,
        message: 'Live scan completed.',
        summary
      };
    }

    triggerScan('manual').catch(() => {});
    reply.code(202);

    return {
      ok: true,
      started: true,
      message: 'Live scan started.'
    };
  });

  app.get('/api/cron', async (_, reply) => {
    if (!scheduler?.getState) {
      reply.code(404);
      return { ok: false, message: 'Scheduler is unavailable.' };
    }

    if (!config.sources.some((source) => source.enabled)) {
      return { ok: true, ran: false, reason: 'no-enabled-sources' };
    }

    const state = store.getState();
    const schedulerState = buildSchedulerStatus(scheduler.getState(), state.stats.lastRunStartedAt);
    const decision = evaluateScheduledScan(schedulerState, state.stats.lastRunStartedAt, scanState.running);

    if (!decision.shouldRun) {
      return {
        ok: true,
        ran: false,
        reason: decision.reason,
        nextRunAt: decision.nextRunAt ?? schedulerState?.nextRunAt ?? null
      };
    }

    const summary = await triggerScan('scheduled');
    return {
      ok: true,
      ran: true,
      summary
    };
  });

  return app;
}
