import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { firstFinite, isSourceEnabled } from './lib/utils.js';
import { buildProductSummaries } from './services/dealEngine.js';

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NEW_PRODUCT_FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

function matchesQuery(value, query) {
  return !query || String(value ?? '').toLowerCase().includes(query);
}

function normalizeCategoryKey(category) {
  return String(category ?? '').trim().toLowerCase();
}

function toTimestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

function isNewOutletProduct(product, latestRunStartedAt) {
  const firstSeenTimestamp = toTimestamp(product.firstSeenAt);

  if (firstSeenTimestamp == null) {
    return false;
  }

  const latestRunTimestamp = toTimestamp(latestRunStartedAt);

  if (latestRunTimestamp != null) {
    return firstSeenTimestamp >= latestRunTimestamp;
  }

  return Date.now() - firstSeenTimestamp <= NEW_PRODUCT_FALLBACK_WINDOW_MS;
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

  return deals.filter((deal) => {
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

  return products.filter((product) => {
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

// Returns effective enabled state — runtime store override takes precedence over config file
// (defined in src/lib/utils.js and imported above)

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

const VALID_SORT_COLUMNS = new Set([
  'title', 'category', 'currentPriceSek', 'initialPriceSek',
  'discountSek', 'discountPercent', 'lastSeenAt'
]);
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function sortAndPaginateProducts(products, query) {
  const sortBy = VALID_SORT_COLUMNS.has(query.sortBy) ? query.sortBy : 'discountPercent';
  const sortDir = query.sortDir === 'asc' ? 1 : -1;
  const rawPage = Number.parseInt(String(query.page ?? '1'), 10);
  const rawSize = Number.parseInt(String(query.pageSize ?? String(DEFAULT_PAGE_SIZE)), 10);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(rawSize) ? rawSize : DEFAULT_PAGE_SIZE));

  // Compute aggregates over the full filtered set before slicing
  const discounted = products.filter((p) => Number.isFinite(p.discountSek) && p.discountSek > 0).length;
  const matched = products.filter((p) => Number.isFinite(p.initialPriceSek)).length;
  const discountValues = products.map((p) => p.discountPercent).filter((v) => Number.isFinite(v));
  const avgDiscountPercent = discountValues.length
    ? Math.round(discountValues.reduce((sum, v) => sum + v, 0) / discountValues.length)
    : null;

  const sorted = [...products].sort((a, b) => {
    let cmp;
    if (sortBy === 'title' || sortBy === 'category') {
      cmp = String(a[sortBy] ?? '').localeCompare(String(b[sortBy] ?? ''), 'sv-SE');
    } else if (sortBy === 'lastSeenAt') {
      cmp = (Date.parse(a.lastSeenAt) || 0) - (Date.parse(b.lastSeenAt) || 0);
    } else {
      const va = Number.isFinite(a[sortBy]) ? a[sortBy] : -Infinity;
      const vb = Number.isFinite(b[sortBy]) ? b[sortBy] : -Infinity;
      cmp = va - vb;
    }
    if (cmp !== 0) return cmp * sortDir;
    return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'sv-SE');
  });

  const total = sorted.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const page = Math.min(Math.max(1, Number.isFinite(rawPage) ? rawPage : 1), totalPages);
  const offset = (page - 1) * pageSize;

  return {
    items: sorted.slice(offset, offset + pageSize),
    total,
    page,
    pageSize,
    totalPages,
    aggregates: { discounted, matched, avgDiscountPercent }
  };
}

function filterOutletProducts(products, query, favoriteCategorySet, latestRunStartedAt = null) {
  const search = String(query.search ?? '').trim().toLowerCase();
  const category = String(query.category ?? '').trim().toLowerCase();
  const store = String(query.store ?? '').trim().toLowerCase();
  const favoritesOnly = String(query.favoritesOnly ?? 'false') === 'true';
  const discountedOnly = String(query.discountedOnly ?? 'false') === 'true';
  const referenceOnly = String(query.referenceOnly ?? 'false') === 'true';
  const newOnly = String(query.newOnly ?? 'false') === 'true';
  const minDiscountPercent = Number.parseInt(String(query.minDiscountPercent ?? ''), 10);
  const minPriceSek = Number.parseInt(String(query.minPriceSek ?? query.minPrice ?? ''), 10);
  const maxPriceSek = Number.parseInt(String(query.maxPriceSek ?? query.maxPrice ?? ''), 10);

  return products.filter((product) => {
    const productCategoryKey = normalizeCategoryKey(product.category);

    if (store && product.sourceId !== store) {
      return false;
    }

    if (favoritesOnly && !favoriteCategorySet.has(productCategoryKey)) {
      return false;
    }

    if (discountedOnly && !(Number.isFinite(product.discountSek) && product.discountSek > 0)) {
      return false;
    }

    if (referenceOnly && !Number.isFinite(product.initialPriceSek)) {
      return false;
    }

    if (newOnly && !isNewOutletProduct(product, latestRunStartedAt)) {
      return false;
    }

    if (Number.isFinite(minDiscountPercent) && minDiscountPercent > 0) {
      if (!(Number.isFinite(product.discountPercent) && product.discountPercent >= minDiscountPercent)) {
        return false;
      }
    }

    if (Number.isFinite(minPriceSek) && minPriceSek > 0 && product.currentPriceSek < minPriceSek) {
      return false;
    }

    if (Number.isFinite(maxPriceSek) && maxPriceSek > 0 && product.currentPriceSek > maxPriceSek) {
      return false;
    }

    return (
      (!category || productCategoryKey === category) &&
      (matchesQuery(product.title, search) || matchesQuery(product.category, search) || matchesQuery(product.sourceLabel, search))
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

export async function buildApp({ config, store, scanState, triggerScan, cancelScan, scheduler }) {
  const app = Fastify({ logger: false });

  try {
    await app.register(fastifyStatic, {
      root: config.publicDir,
      index: ['index.html']
    });
  } catch (error) {
    console.error('[static]', error.message);
  }

  app.get('/health', async () => ({ ok: true }));

  app.get('/api/status', async () => {
    const state = store.getState();
    const sourceStatuses = config.sources.map((source) => describeSourceStatus(source, state.sourceStates[source.id]));
    const schedulerState = buildSchedulerStatus(scheduler?.getState?.() ?? null, state.stats.lastScheduledRunStartedAt);

    return {
      isRunning: scanState.running,
      isCancelling: scanState.cancelling,
      lastError: scanState.lastError,
      lastRunStartedAt: state.stats.lastRunStartedAt,
      lastRunCompletedAt: state.stats.lastRunCompletedAt,
      lastRunSummary: state.stats.lastRunSummary,
      scanProgress: {
        startedAt: scanState.startedAt,
        completedSources: scanState.completedSources,
        totalSources: scanState.totalSources,
        sourceProgress: scanState.sourceProgress ?? {}
      },
      counts: {
        trackedItems: Object.keys(state.items).length,
        deals: state.deals.length,

        enabledSources: config.sources.filter((source) => isSourceEnabled(source, state)).length,
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
    const filtered = filterOutletProducts(buildOutletProducts(state), request.query, favoriteCategorySet, state.stats.lastRunStartedAt);
    return sortAndPaginateProducts(filtered, request.query);
  });

  app.get('/api/outlet-categories', async () => {
    const state = store.getState();
    const favoriteCategorySet = getFavoriteCategorySet(state);
    return buildOutletCategoryStats(buildOutletProducts(state), favoriteCategorySet);
  });

  app.get('/api/outlet-sources', async () => {
    const state = store.getState();
    const seen = new Map();
    for (const item of Object.values(state.items)) {
      if (!seen.has(item.sourceId)) {
        seen.set(item.sourceId, item.sourceLabel ?? item.sourceId);
      }
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
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

  app.get('/api/notification-settings', async () => {
    const settings = store.getState().preferences?.notificationSettings ?? {};
    return {
      keywordWebhook: settings.keywordWebhook ?? '',
      keywords: Array.isArray(settings.keywords) ? settings.keywords : [],
      categoryWebhooks: Array.isArray(settings.categoryWebhooks) ? settings.categoryWebhooks : [],
      schedulerNotificationTypes: settings.schedulerNotificationTypes ?? null
    };
  });

  app.put('/api/notification-settings', async (request, reply) => {
    const body = request.body ?? {};
    const state = store.getState();

    const keywordWebhook = typeof body.keywordWebhook === 'string' ? body.keywordWebhook.trim() : '';

    const keywords = Array.isArray(body.keywords)
      ? body.keywords
          .filter((k) => k && typeof k.keyword === 'string' && k.keyword.trim())
          .map((k) => ({
            id: typeof k.id === 'string' && k.id ? k.id : `kw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            keyword: k.keyword.trim(),
            enabled: k.enabled !== false
          }))
      : [];

    const categoryWebhooks = Array.isArray(body.categoryWebhooks)
      ? body.categoryWebhooks
          .filter((c) => c && typeof c.pattern === 'string' && c.pattern.trim() && typeof c.webhook === 'string' && c.webhook.trim())
          .map((c) => ({
            id: typeof c.id === 'string' && c.id ? c.id : `cw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            pattern: c.pattern.trim(),
            label: typeof c.label === 'string' ? c.label.trim() : c.pattern.trim(),
            webhook: c.webhook.trim()
          }))
      : [];

    let schedulerNotificationTypes;
    if (body.schedulerNotificationTypes && typeof body.schedulerNotificationTypes === 'object' && !Array.isArray(body.schedulerNotificationTypes)) {
      schedulerNotificationTypes = {
        favorites: Boolean(body.schedulerNotificationTypes.favorites),
        keywords: Boolean(body.schedulerNotificationTypes.keywords),
        categories: Boolean(body.schedulerNotificationTypes.categories)
      };
    }

    state.preferences = {
      ...(state.preferences ?? {}),
      notificationSettings: {
        keywordWebhook,
        keywords,
        categoryWebhooks,
        ...(schedulerNotificationTypes !== undefined ? { schedulerNotificationTypes } : {})
      }
    };

    if (typeof store.save === 'function') {
      await store.save();
    }

    return { keywordWebhook, keywords, categoryWebhooks, schedulerNotificationTypes };
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

    return config.sources.map((source) => {
      const schedulerEnabled = isSourceEnabled(source, state); // respects runtime overrides
      return {
        id: source.id,
        label: source.label,
        type: source.type,
        enabled: source.enabled,           // config-file value only — for Sources section
        schedulerEnabled,                  // scheduler override — for Scanners section
        status: describeSourceStatus({ ...source, enabled: schedulerEnabled }, state.sourceStates[source.id]),
        lastSuccessAt: state.sourceStates[source.id]?.lastSuccessAt ?? null,
        lastCount: state.sourceStates[source.id]?.lastCount ?? null,
        lastError: state.sourceStates[source.id]?.lastError ?? null,
        disabledUntil: state.sourceStates[source.id]?.disabledUntil ?? null
      };
    });
  });

  app.patch('/api/sources/:id', async (request, reply) => {
    const sourceId = request.params.id;
    const source = config.sources.find((s) => s.id === sourceId);

    if (!source) {
      reply.code(404);
      return { message: `Source not found: ${sourceId}` };
    }

    if (typeof request.body?.enabled !== 'boolean') {
      reply.code(400);
      return { message: 'Provide { enabled: true|false }' };
    }

    const state = store.getState();
    state.preferences = state.preferences ?? {};
    state.preferences.sourceOverrides = state.preferences.sourceOverrides ?? {};
    state.preferences.sourceOverrides[sourceId] = request.body.enabled;

    if (typeof store.save === 'function') {
      await store.save();
    }

    return {
      id: sourceId,
      label: source.label,
      enabled: request.body.enabled
    };
  });

  app.post('/api/run', async (request, reply) => {
    if (scanState.running) {
      reply.code(409);
      return { ok: false, message: 'A scan is already running.' };
    }

    const rawSourceIds = request.body?.sourceIds;
    const sourceIds = Array.isArray(rawSourceIds) && rawSourceIds.length > 0
      ? rawSourceIds.map((id) => String(id).trim()).filter(Boolean)
      : null;

    // Validate that requested source IDs exist
    if (sourceIds) {
      const knownIds = new Set(config.sources.map((s) => s.id));
      const unknown = sourceIds.filter((id) => !knownIds.has(id));

      if (unknown.length) {
        reply.code(400);
        return { ok: false, message: `Unknown source IDs: ${unknown.join(', ')}` };
      }
    }

    // For manual scans with explicit sourceIds, only require the source to exist (not necessarily scheduler-enabled)
    // For a full scan, require at least one scheduler-enabled source
    const canRun = sourceIds
      ? config.sources.some((source) => sourceIds.includes(source.id) && source.enabled)
      : config.sources.some((source) => isSourceEnabled(source, store.getState()));

    if (!canRun) {
      reply.code(400);
      return {
        ok: false,
        message: sourceIds
          ? `None of the requested sources are enabled: ${sourceIds.join(', ')}`
          : 'No sources are enabled. Add or enable a source in config/sources.json.'
      };
    }

    triggerScan('manual', { sourceIds }).catch(() => {});
    reply.code(202);

    return {
      ok: true,
      started: true,
      message: sourceIds ? `Scanning: ${sourceIds.join(', ')}` : 'Live scan started.'
    };
  });

  app.post('/api/cancel', async (request, reply) => {
    if (!scanState.running) {
      reply.code(409);
      return { ok: false, message: 'No scan is currently running.' };
    }
    const wasCancelled = cancelScan();
    return { ok: wasCancelled, message: wasCancelled ? 'Scan cancellation requested.' : 'No scan is running.' };
  });

  return app;
}
