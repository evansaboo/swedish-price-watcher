// ═══════════════════════════════════════════════════════════════
// App — Fastify routes (thin handlers delegating to services)
// ═══════════════════════════════════════════════════════════════

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { isSourceEnabled } from './lib/utils.js';
import { buildProductSummaries } from './services/dealEngine.js';

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ── Shared helpers ─────────────────────────────────────────────

function normalizeCategoryKey(category) {
  return String(category ?? '').trim().toLowerCase();
}

function normalizeForSearch(str) {
  return String(str ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^ -\u007F\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesQuery(value, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const tokens = q.replace(/[^ -\u007F\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every(t => normalizeForSearch(value).includes(t));
}

function getFavoriteCategories(state) {
  return Array.isArray(state.preferences?.favoriteCategories)
    ? state.preferences.favoriteCategories.map(c => String(c).trim()).filter(Boolean)
    : [];
}

function getFavoriteCategorySet(state) {
  return new Set(getFavoriteCategories(state).map(normalizeCategoryKey));
}

function normalizeFavoriteCategories(categories) {
  const unique = new Map();
  for (const category of Array.isArray(categories) ? categories : []) {
    const label = String(category ?? '').trim();
    const key = normalizeCategoryKey(label);
    if (!key || unique.has(key)) continue;
    unique.set(key, label);
  }
  return [...unique.values()].sort((a, b) => a.localeCompare(b, 'sv-SE'));
}

function describeSourceStatus(source, sourceState = {}) {
  if (!source.enabled) return 'disabled';
  if (sourceState.disabledUntil) return 'cooling-down';
  if (sourceState.lastError) return 'error';
  if (sourceState.lastSuccessAt) return 'healthy';
  return 'idle';
}

function filterDeals(deals, query) {
  const search = String(query.search ?? '').trim().toLowerCase();
  const category = String(query.category ?? '').trim().toLowerCase();
  const condition = String(query.condition ?? '').trim().toLowerCase();
  const sourceId = String(query.sourceId ?? '').trim().toLowerCase();

  return deals.filter(deal =>
    (!category || normalizeCategoryKey(deal.category) === category) &&
    (!condition || deal.condition.toLowerCase() === condition) &&
    (!sourceId || deal.sourceId.toLowerCase() === sourceId) &&
    (matchesQuery(deal.title, search) || matchesQuery(deal.sourceLabel, search))
  );
}

function filterProducts(products, query) {
  const search = String(query.search ?? '').trim().toLowerCase();
  const category = String(query.category ?? '').trim().toLowerCase();
  const condition = String(query.condition ?? '').trim().toLowerCase();

  return products.filter(product =>
    (!category || normalizeCategoryKey(product.category) === category) &&
    (!condition || product.offers.some(o => o.condition.toLowerCase() === condition)) &&
    matchesQuery(product.title, search)
  );
}

// ── Scheduler validation ───────────────────────────────────────

function normalizeSchedulerUpdate(payload) {
  const normalized = {};

  if (payload?.enabled !== undefined) {
    normalized.enabled = Boolean(payload.enabled);
  }

  if (payload?.intervalMinutes !== undefined) {
    const val = Number.parseInt(String(payload.intervalMinutes), 10);
    if (!Number.isFinite(val) || val <= 0) throw new Error('intervalMinutes must be a positive integer.');
    normalized.intervalMinutes = val;
  }

  if (payload?.activeWindow !== undefined) {
    if (!payload.activeWindow || typeof payload.activeWindow !== 'object' || Array.isArray(payload.activeWindow)) {
      throw new Error('activeWindow must be an object.');
    }

    const aw = {};
    if (payload.activeWindow.enabled !== undefined) aw.enabled = Boolean(payload.activeWindow.enabled);
    if (payload.activeWindow.startTime !== undefined) {
      const s = String(payload.activeWindow.startTime).trim();
      if (!TIME_OF_DAY_PATTERN.test(s)) throw new Error('activeWindow.startTime must use HH:MM format.');
      aw.startTime = s;
    }
    if (payload.activeWindow.endTime !== undefined) {
      const e = String(payload.activeWindow.endTime).trim();
      if (!TIME_OF_DAY_PATTERN.test(e)) throw new Error('activeWindow.endTime must use HH:MM format.');
      aw.endTime = e;
    }
    if (payload.activeWindow.timeZone !== undefined) {
      const tz = String(payload.activeWindow.timeZone).trim();
      if (!tz) throw new Error('activeWindow.timeZone cannot be empty.');
      aw.timeZone = tz;
    }
    if (!Object.keys(aw).length) throw new Error('activeWindow must include enabled, startTime, endTime, or timeZone.');
    normalized.activeWindow = aw;
  }

  return normalized;
}

function buildSchedulerStatus(schedulerState, lastRunStartedAt) {
  if (!schedulerState) return null;
  if (schedulerState.nextRunAt || !schedulerState.enabled) return schedulerState;

  const intervalMinutes = Number.parseInt(String(schedulerState.intervalMinutes ?? ''), 10);
  const lastRunTs = Date.parse(lastRunStartedAt ?? '');
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0 || Number.isNaN(lastRunTs)) return schedulerState;

  return { ...schedulerState, nextRunAt: new Date(lastRunTs + intervalMinutes * 60 * 1000).toISOString() };
}

// ── Route builder ──────────────────────────────────────────────

export async function buildApp({ config, store, productCache, scanState, triggerScan, cancelScan, scheduler }) {
  const app = Fastify({ logger: false });

  try {
    await app.register(fastifyStatic, { root: config.publicDir, index: ['index.html'] });
  } catch (error) {
    console.error('[static]', error.message);
  }

  // ── Health ─────────────────────────────────────────────────────
  app.get('/health', async () => ({ ok: true }));

  // ── Status ─────────────────────────────────────────────────────
  app.get('/api/status', async () => {
    const state = store.getState();
    const sourceStatuses = config.sources.map(s => describeSourceStatus(s, state.sourceStates[s.id]));
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
        enabledSources: config.sources.filter(s => isSourceEnabled(s, state)).length,
        healthySources: sourceStatuses.filter(s => s === 'healthy').length,
        blockedSources: sourceStatuses.filter(s => s === 'error' || s === 'cooling-down').length,
        outletItems: state.deals.filter(d => d.condition === 'outlet').length,
        referencedItems: state.deals.filter(d => d.comparisonPriceSek > d.currentPriceSek).length,
        favoriteCategories: getFavoriteCategories(state).length
      },
      scheduler: schedulerState
    };
  });

  // ── Categories ─────────────────────────────────────────────────
  app.get('/api/categories', async () => {
    const categories = new Set();
    for (const item of Object.values(store.getState().items)) {
      categories.add(item.category);
    }
    return [...categories].filter(Boolean).sort((a, b) => a.localeCompare(b, 'sv-SE'));
  });

  // ── Deals & Products (legacy) ──────────────────────────────────
  app.get('/api/deals', async (request) => filterDeals(store.getState().deals, request.query));
  app.get('/api/products', async (request) => filterProducts(buildProductSummaries(store.getState()), request.query));

  // ── Outlet Products (main endpoint — uses ProductCache) ────────
  app.get('/api/outlet-products', async (request) => {
    const state = store.getState();
    const favSet = getFavoriteCategorySet(state);
    const wishlistSet = new Set(state.preferences?.wishlist ?? []);
    const q = request.query;

    return productCache.query({
      search: q.search,
      category: q.category,
      store: q.store,
      campaign: q.campaign,
      favoritesOnly: q.favoritesOnly === 'true',
      discountedOnly: q.discountedOnly === 'true',
      referenceOnly: q.referenceOnly === 'true',
      newOnly: q.newOnly === 'true',
      hotOnly: q.hotOnly === 'true',
      wishlistOnly: q.wishlistOnly === 'true',
      minDiscountPercent: Number.parseInt(q.minDiscountPercent ?? '', 10),
      minPriceSek: Number.parseInt(q.minPriceSek ?? q.minPrice ?? '', 10),
      maxPriceSek: Number.parseInt(q.maxPriceSek ?? q.maxPrice ?? '', 10),
      sortBy: q.sortBy,
      sortDir: q.sortDir,
      page: Number.parseInt(q.page ?? '1', 10),
      pageSize: Number.parseInt(q.pageSize ?? '50', 10),
    }, favSet, state.stats.lastRunStartedAt, wishlistSet);
  });

  // ── Outlet Categories (from cache) ─────────────────────────────
  app.get('/api/outlet-categories', async () => {
    const state = store.getState();
    return productCache.getCategoriesWithFavorites(getFavoriteCategorySet(state));
  });

  // ── Outlet Sources (from cache) ────────────────────────────────
  app.get('/api/outlet-sources', async () => productCache.sources);

  // ── Outlet Campaigns (from cache) ──────────────────────────────
  app.get('/api/outlet-campaigns', async () => productCache.campaigns);

  // ── Preferences ────────────────────────────────────────────────
  app.get('/api/preferences', async () => ({
    favoriteCategories: getFavoriteCategories(store.getState())
  }));

  app.put('/api/preferences/favorite-categories', async (request) => {
    const state = store.getState();
    const categories = normalizeFavoriteCategories(request.body?.categories);
    state.preferences = { ...(state.preferences ?? {}), favoriteCategories: categories };

    if (typeof store.savePreferences === 'function') {
      await store.savePreferences();
    } else {
      await store.save();
    }

    return { favoriteCategories: categories };
  });

  // ── Notification Settings ──────────────────────────────────────
  app.get('/api/notification-settings', async () => {
    const settings = store.getState().preferences?.notificationSettings ?? {};

    // Migrate legacy data to alertRules on first read
    if (!Array.isArray(settings.alertRules)) {
      const rules = [];
      const legacyWebhook = settings.keywordWebhook ?? '';
      for (const kw of (Array.isArray(settings.keywords) ? settings.keywords : [])) {
        if (!kw?.keyword) continue;
        const cats = Array.isArray(kw.categories) ? kw.categories : (kw.category ? [kw.category] : []);
        if (legacyWebhook) {
          rules.push({ id: kw.id ?? `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, label: kw.keyword, enabled: kw.enabled !== false, keywords: [kw.keyword], categories: cats, webhooks: [legacyWebhook] });
        }
      }
      for (const cw of (Array.isArray(settings.categoryWebhooks) ? settings.categoryWebhooks : [])) {
        if (!cw?.pattern || !cw?.webhook) continue;
        rules.push({ id: cw.id ?? `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, label: cw.label || cw.pattern, enabled: true, keywords: [], categories: [cw.pattern], webhooks: [cw.webhook] });
      }
      return { notificationsEnabled: settings.notificationsEnabled !== false, alertRules: rules };
    }

    return { notificationsEnabled: settings.notificationsEnabled !== false, alertRules: settings.alertRules };
  });

  app.put('/api/notification-settings', async (request, reply) => {
    const body = request.body ?? {};
    const state = store.getState();
    const notificationsEnabled = body.notificationsEnabled !== false;

    const alertRules = Array.isArray(body.alertRules)
      ? body.alertRules.map(r => {
          const keywords = (Array.isArray(r.keywords) ? r.keywords : []).filter(k => typeof k === 'string' && k.trim()).map(k => k.trim());
          const categories = (Array.isArray(r.categories) ? r.categories : []).filter(c => typeof c === 'string' && c.trim()).map(c => c.trim());
          const webhooks = (Array.isArray(r.webhooks) ? r.webhooks : []).filter(w => typeof w === 'string' && w.trim()).map(w => w.trim());
          // Migrate old excludedSources → filteredSources with mode='exclude'
          const rawFiltered = Array.isArray(r.filteredSources) ? r.filteredSources : (Array.isArray(r.excludedSources) ? r.excludedSources : []);
          const filteredSources = rawFiltered.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
          const sourceFilterMode = r.sourceFilterMode === 'include' ? 'include' : 'exclude';
          return {
            id: typeof r.id === 'string' && r.id ? r.id : `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            label: typeof r.label === 'string' ? r.label.trim() : '',
            enabled: r.enabled !== false,
            keywords, categories, webhooks, filteredSources, sourceFilterMode,
            ...(typeof r.minDiscountPercent === 'number' && Number.isFinite(r.minDiscountPercent) && r.minDiscountPercent > 0 ? { minDiscountPercent: r.minDiscountPercent } : {})
          };
        })
      : [];

    state.preferences = { ...(state.preferences ?? {}), notificationSettings: { notificationsEnabled, alertRules } };

    if (typeof store.savePreferences === 'function') {
      await store.savePreferences();
    } else {
      await store.save();
    }

    return { notificationsEnabled, alertRules };
  });

  // ── Scheduler ──────────────────────────────────────────────────
  app.get('/api/scheduler', async (_, reply) => {
    if (!scheduler?.getState) { reply.code(404); return { message: 'Scheduler is unavailable.' }; }
    return scheduler.getState();
  });

  app.put('/api/scheduler', async (request, reply) => {
    if (!scheduler?.update) { reply.code(404); return { message: 'Scheduler is unavailable.' }; }

    let update;
    try { update = normalizeSchedulerUpdate(request.body ?? {}); }
    catch (error) { reply.code(400); return { message: error.message }; }

    if (!Object.keys(update).length) { reply.code(400); return { message: 'Provide enabled, intervalMinutes, or activeWindow.' }; }

    try { return await scheduler.update(update); }
    catch (error) { reply.code(400); return { message: error.message }; }
  });

  // ── Sources ────────────────────────────────────────────────────
  app.get('/api/sources', async () => {
    const state = store.getState();
    return config.sources.map(source => {
      const schedulerEnabled = isSourceEnabled(source, state);
      return {
        id: source.id,
        label: source.label,
        type: source.type,
        enabled: source.enabled,
        schedulerEnabled,
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
    const source = config.sources.find(s => s.id === sourceId);
    if (!source) { reply.code(404); return { message: `Source not found: ${sourceId}` }; }
    if (typeof request.body?.enabled !== 'boolean') { reply.code(400); return { message: 'Provide { enabled: true|false }' }; }

    const state = store.getState();
    state.preferences = state.preferences ?? {};
    state.preferences.sourceOverrides = state.preferences.sourceOverrides ?? {};
    state.preferences.sourceOverrides[sourceId] = request.body.enabled;

    if (typeof store.savePreferences === 'function') {
      await store.savePreferences();
    } else {
      await store.save();
    }

    return { id: sourceId, label: source.label, enabled: request.body.enabled };
  });

  // ── Price History ───────────────────────────────────────────────
  app.get('/api/price-history/:listingKey', async (request, reply) => {
    const { listingKey } = request.params;
    const state = store.getState();
    const item = state.items[listingKey];
    if (!item) {
      // Check archived history
      const archived = state.itemHistory?.[listingKey];
      if (archived) return { listingKey, history: archived.history ?? [], archived: true };
      reply.code(404);
      return { message: 'Product not found.' };
    }
    return {
      listingKey,
      title: item.title,
      currentPriceSek: item.latestPriceSek,
      lowestPriceSek: item.lowestPriceSek,
      highestPriceSek: item.highestPriceSek,
      history: item.history ?? []
    };
  });

  // ── Wishlist ──────────────────────────────────────────────────
  app.get('/api/wishlist', async () => {
    const state = store.getState();
    return { items: state.preferences?.wishlist ?? [] };
  });

  app.post('/api/wishlist/:listingKey', async (request, reply) => {
    const { listingKey } = request.params;
    const state = store.getState();
    const item = state.items[listingKey];
    if (!item) { reply.code(404); return { message: 'Product not found.' }; }

    state.preferences = state.preferences ?? {};
    const wishlist = state.preferences.wishlist ?? [];
    if (!wishlist.includes(listingKey)) {
      wishlist.push(listingKey);
      state.preferences.wishlist = wishlist;
      if (typeof store.savePreferences === 'function') {
        await store.savePreferences();
      } else {
        await store.save();
      }
    }
    return { ok: true, listingKey, wishlisted: true };
  });

  app.delete('/api/wishlist/:listingKey', async (request, reply) => {
    const { listingKey } = request.params;
    const state = store.getState();
    state.preferences = state.preferences ?? {};
    const wishlist = state.preferences.wishlist ?? [];
    const idx = wishlist.indexOf(listingKey);
    if (idx !== -1) {
      wishlist.splice(idx, 1);
      state.preferences.wishlist = wishlist;
      if (typeof store.savePreferences === 'function') {
        await store.savePreferences();
      } else {
        await store.save();
      }
    }
    return { ok: true, listingKey, wishlisted: false };
  });

  // ── Scan Control ───────────────────────────────────────────────
  app.post('/api/run', async (request, reply) => {
    if (scanState.running) { reply.code(409); return { ok: false, message: 'A scan is already running.' }; }

    const rawSourceIds = request.body?.sourceIds;
    const sourceIds = Array.isArray(rawSourceIds) && rawSourceIds.length > 0
      ? rawSourceIds.map(id => String(id).trim()).filter(Boolean)
      : null;

    if (sourceIds) {
      const knownIds = new Set(config.sources.map(s => s.id));
      const unknown = sourceIds.filter(id => !knownIds.has(id));
      if (unknown.length) { reply.code(400); return { ok: false, message: `Unknown source IDs: ${unknown.join(', ')}` }; }
    }

    const canRun = sourceIds
      ? config.sources.some(s => sourceIds.includes(s.id) && s.enabled)
      : config.sources.some(s => isSourceEnabled(s, store.getState()));

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
    return { ok: true, started: true, message: sourceIds ? `Scanning: ${sourceIds.join(', ')}` : 'Live scan started.' };
  });

  app.post('/api/cancel', async (request, reply) => {
    if (!scanState.running) { reply.code(409); return { ok: false, message: 'No scan is currently running.' }; }
    const wasCancelled = cancelScan();
    return { ok: wasCancelled, message: wasCancelled ? 'Scan cancellation requested.' : 'No scan is running.' };
  });

  return app;
}
