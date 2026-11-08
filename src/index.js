import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PoliteFetcher } from './lib/fetcher.js';
import { createPurchaseService } from './services/purchaseService.js';
import { ensurePurchaseState } from './services/purchaseEngine.js';
import { ApifyStore, JsonStore, SqliteStore, migrateJsonToSqlite, reconcileStateWithSources } from './lib/store.js';
import { buildListingKey } from './lib/utils.js';
import { collectSource } from './sources/index.js';
import { computeDeals, mergeObservations } from './services/dealEngine.js';
import { createHotlistPoller } from './services/hotlistPoller.js';
import { ensureHotlistConfig, normalizeHotlistConfig } from './services/hotlistConfig.js';
import { ensureKomplettDemoConfig, normalizeKomplettDemoConfig, enabledFeedIds as komplettEnabledFeedIds } from './services/komplettDemoConfig.js';
import { createKomplettDemoPoller } from './services/komplettDemoPoller.js';
import {
  KOMPLETT_DEALS_SOURCE_ID,
  KOMPLETT_DEALS_SOURCE_LABEL,
  KOMPLETT_DEMO_SOURCE_ID,
  KOMPLETT_DEMO_SOURCE_LABEL,
  KOMPLETT_LISTING_SOURCES,
  syncKomplettDemoListing,
} from './services/komplettDemoListing.js';
import { ensureInetConfig, normalizeInetConfig, enabledFeedIds as inetEnabledFeedIds } from './services/inetConfig.js';
import { createInetPoller } from './services/inetPoller.js';
import { INET_LISTING_SOURCES, syncInetListing } from './services/inetListing.js';
import { ensureWebhallenConfig, normalizeWebhallenConfig, enabledFeedIds as webhallenEnabledFeedIds } from './services/webhallenConfig.js';
import { createWebhallenPoller } from './services/webhallenPoller.js';
import { WEBHALLEN_LISTING_SOURCES, syncWebhallenListing } from './services/webhallenListing.js';
import { ProductCache } from './services/productCache.js';
import { DiscordNotifier } from './services/notifier.js';
import { decorateAffiliateLink } from './services/affiliateLinks.js';

// The app runs four features: the Elgiganten hotlist, the Komplett demo
// watcher, the Inet watcher and the Webhallen watcher, each on its own loop.
// The NVIDIA FE stock tracker was removed on 2026-11-07. The old
// multi-source scan, its scheduler and the daily digest were retired on
// 2026-10-31; the scrapers are in archive/scrapers/.

const isRailwayRuntime = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const useApifyStateStore = isRailwayRuntime && Boolean(process.env.APIFY_TOKEN?.trim());
const config = await loadConfig();

let store;
if (useApifyStateStore) {
  store = new ApifyStore({
    token: process.env.APIFY_TOKEN.trim(),
    storeName: process.env.APIFY_STATE_STORE_NAME ?? 'swedish-price-watcher-state',
    recordKey: process.env.APIFY_STATE_RECORD_KEY ?? 'state'
  });
} else {
  // Local mode: prefer SQLite, migrate from JSON if needed
  const dbPath = config.dataFile.replace(/\.json$/, '.db');
  try {
    // One-time migration: if store.json exists but store.db doesn't, migrate automatically
    await migrateJsonToSqlite(config.dataFile, dbPath);
    store = new SqliteStore(dbPath);
  } catch (sqliteErr) {
    console.warn(`[store] SQLite unavailable (${sqliteErr.message}), falling back to JSON store`);
    store = new JsonStore(config.dataFile);
  }
}

await store.load();
console.log(`[startup] store loaded at ${process.uptime().toFixed(1)}s`);

// Items of archived sources stay in the database but are hidden from the
// dashboard, deals and product cache.
const komplettDemoSource = config.sources.find((entry) => entry.id === KOMPLETT_DEMO_SOURCE_ID)
  ?? { id: KOMPLETT_DEMO_SOURCE_ID, label: KOMPLETT_DEMO_SOURCE_LABEL, type: 'komplett-demo' };
const komplettDealsSource = config.sources.find((entry) => entry.id === KOMPLETT_DEALS_SOURCE_ID)
  ?? { id: KOMPLETT_DEALS_SOURCE_ID, label: KOMPLETT_DEALS_SOURCE_LABEL, type: 'komplett-deals' };
// The Inet watcher's two listing feeds (campaign deals, Fyndhörnan outlet).
const inetSources = Object.fromEntries(Object.entries(INET_LISTING_SOURCES).map(([feed, fallback]) => {
  const configured = config.sources.find((entry) => entry.id === fallback.id);
  return [feed, { ...fallback, ...(configured ?? {}), label: configured?.label || fallback.label }];
}));
// The Webhallen watcher's two listing feeds (Kampanjer deals, Fyndvaror outlet).
const webhallenSources = Object.fromEntries(Object.entries(WEBHALLEN_LISTING_SOURCES).map(([feed, fallback]) => {
  const configured = config.sources.find((entry) => entry.id === fallback.id);
  return [feed, { ...fallback, ...(configured ?? {}), label: configured?.label || fallback.label }];
}));
const activeSourceIds = new Set([
  ...config.sources.map((entry) => entry.id),
  komplettDemoSource.id,
  komplettDealsSource.id,
  ...Object.values(inetSources).map((source) => source.id),
  ...Object.values(webhallenSources).map((source) => source.id)
]);
{
  const { hiddenItems, hiddenSourceIds } = reconcileStateWithSources(store.getState(), activeSourceIds);
  if (hiddenItems) {
    console.log(`[startup] ${hiddenItems} item(s) from ${hiddenSourceIds.length} archived source(s) kept in the database, hidden from the dashboard.`);
  }
}
const state = store.getState();
// Recompute deals from loaded items — deals are not persisted to keep state lean.
state.deals = computeDeals(state, config.thresholds);

// Initialize product cache — materialized view for fast API queries
const productCache = new ProductCache();
const sourceLabelMap = new Map([
  [komplettDemoSource.id, komplettDemoSource.label || KOMPLETT_DEMO_SOURCE_LABEL],
  [komplettDealsSource.id, komplettDealsSource.label || KOMPLETT_DEALS_SOURCE_LABEL],
  ...Object.values(inetSources).map((source) => [source.id, source.label]),
  ...Object.values(webhallenSources).map((source) => [source.id, source.label]),
  ...config.sources.map(s => [s.id, s.label || s.id])
]);
const sourceById = new Map(config.sources.map(s => [s.id, s]));
// The hotlist runs on its own continuous loop, owned by the poller below.
const hotlistSources = config.sources.filter((entry) => entry.type?.endsWith('-hotlist') || entry.id?.endsWith('-hotlist'));
const hotlistSource = hotlistSources.find((entry) => entry.type === 'elgiganten-hotlist') ?? hotlistSources[0] ?? null;

productCache.rebuild(state, sourceLabelMap);
console.log(`[startup] deals and product cache built at ${process.uptime().toFixed(1)}s`);

// Wire store invalidation to rebuild cache on saves
if (store.onInvalidate) {
  store.onInvalidate(() => productCache.rebuild(store.getState(), sourceLabelMap));
}

state.preferences = state.preferences ?? {};

// Seed the hotlist watch list from config/sources.json the first time, then
// let the dashboard own it from SQLite preferences.
if (hotlistSource) ensureHotlistConfig(state.preferences, hotlistSource);
// The NVIDIA FE tracker is gone; drop its saved settings on the next save.
delete state.preferences.nvidiaFe;
ensureKomplettDemoConfig(state.preferences);
ensureInetConfig(state.preferences);
ensureWebhallenConfig(state.preferences);

// Metadata and preferences only: items are written incrementally through
// flushItems(), and a full item sync of the whole table isn't needed here.
await store.save({ skipItems: true });
console.log(`[startup] store saved at ${process.uptime().toFixed(1)}s`);

const fetcher = new PoliteFetcher(config);
const notifier = new DiscordNotifier({
  webhookUrl: config.discordWebhookUrl,
  cooldownHours: config.notificationCooldownHours
});

// Shared with the HTTP layer so dashboard staging and proactive
// cart-staging both run through the same spend caps and rate limits.
const purchaseService = createPurchaseService({
  config,
  getPreferences: () => store.getState().preferences,
  findItem: (listingKey) => store.getState().items?.[listingKey] ?? null,
  save: () => store.save({ skipItems: true })
});

// The hotlist poll and the Komplett demo listing sync both mutate `state`
// and persist it. Every mutation runs through this one chain so they never
// interleave.
let stateCommitChain = Promise.resolve();
function commitExclusive(fn) {
  const result = stateCommitChain.then(fn, fn);
  stateCommitChain = result.then(() => {}, () => {});
  return result;
}

// ── Hotlist: continuous Elgiganten poller ──────────────────────
// Targets high-resale categories and flash deals on a dedicated loop.

async function runHotlistPoll() {
  if (!hotlistSources.length) return { count: 0, newCount: 0 };

  const startedAt = new Date().toISOString();
  const allCollected = [];
  const activeHotlistSourceIds = new Set();
  const hotlistErrors = [];

  const hotlistConfig = state.preferences?.hotlist ?? {};
  const sourcesEnabled = hotlistConfig.sources ?? {};

  const pollPromises = hotlistSources.map(async (src) => {
    if (src.enabled === false) return;
    if (sourcesEnabled[src.id] === false) return;
    activeHotlistSourceIds.add(src.id);
    const sourceState = state.sourceStates[src.id] ?? {};
    state.sourceStates[src.id] = sourceState;

    if (sourceState.disabledUntil && Date.parse(sourceState.disabledUntil) > Date.now()) {
      return;
    }

    sourceState.lastAttemptAt = startedAt;

    try {
      const items = await collectSource({
        source: src,
        fetcher,
        sourceState,
        now: startedAt,
        preferences: state.preferences
      });
      if (Array.isArray(items)) {
        allCollected.push(...items);
      }
      sourceState.lastSuccessAt = startedAt;
      sourceState.lastError = null;
      sourceState.lastCount = items ? items.length : 0;
      delete sourceState.disabledUntil;
    } catch (error) {
      sourceState.lastError = error.message;
      if (error.disableHours) {
        sourceState.disabledUntil = new Date(Date.now() + error.disableHours * 60 * 60 * 1000).toISOString();
      }
      hotlistErrors.push(`${src.id}: ${error.message}`);
    }
  });

  await Promise.allSettled(pollPromises);

  if (hotlistErrors.length && !allCollected.length) {
    await commitExclusive(async () => {
      state.stats.hotlist = {
        ...(state.stats.hotlist ?? {}),
        lastPollAt: startedAt,
        lastError: hotlistErrors.join('; ')
      };
    });
  }

  const collected = allCollected;

  return commitExclusive(async () => {
    const mergeResult = mergeObservations(state, collected, config.maxHistoryEntries);

    // Anything that fell out of the hotlist has sold out or stopped being a
    // deal, so it should disappear from the dashboard too.
    const deletedItemKeys = [];
    if (collected.length > 0) {
      const seenKeys = new Set(collected.map(o => buildListingKey(o.sourceId, o.externalId)));
      for (const key of Object.keys(state.items)) {
        if (!activeHotlistSourceIds.has(state.items[key].sourceId) || seenKeys.has(key)) continue;
        const item = state.items[key];
        const historyToArchive = item.history?.length > 0 ? item.history : store.getItemHistory?.(key) ?? [];
        if (historyToArchive.length > 0) {
          state.itemHistory[key] = {
            history: historyToArchive,
            lowestPriceSek: item.lowestPriceSek,
            highestPriceSek: item.highestPriceSek,
            firstSeenAt: item.firstSeenAt,
            archivedAt: new Date().toISOString()
          };
        }
        deletedItemKeys.push(key);
        delete state.items[key];
      }
    }

    // Prune only expired notification cooldown entries so an item that briefly
    // drops out on a lagging Algolia replica cannot re-alert within cooldownMs.
    const notifCutoffMs = Date.now() - notifier.cooldownMs;
    for (const [notifKey, sentAt] of Object.entries(state.notifications)) {
      const sentMs = Date.parse(sentAt);
      if (!Number.isFinite(sentMs) || sentMs < notifCutoffMs) {
        delete state.notifications[notifKey];
      }
    }

    const isFirstSuccessfulRun = !state.stats.hotlist?.lastSuccessAt;
    const hotlistPreference = state.preferences?.hotlist ?? {};
    const skipDiscordNotifications = isFirstSuccessfulRun || hotlistPreference.enabled === false;
    state.stats.hotlist = {
      ...(state.stats.hotlist ?? {}),
      lastSuccessAt: startedAt,
      lastError: null,
      lastCount: collected.length
    };

    if (collected.length > 0 || deletedItemKeys.length > 0) {
      store.flushItems(collected.map(o => buildListingKey(o.sourceId, o.externalId)), deletedItemKeys);
    }

    const changed = mergeResult.newItems.length > 0
      || mergeResult.priceDrops.length > 0
      || deletedItemKeys.length > 0;

    // Most polls find exactly what the previous one did, so the recompute is
    // change-gated.
    if (changed) {
      state.deals = computeDeals(state, config.thresholds);
      productCache.rebuild(state, sourceLabelMap);
    }

    if (!skipDiscordNotifications && (mergeResult.newItems.length || mergeResult.priceDrops.length)) {
      const hotlistConfig = state.preferences?.hotlist ?? {};
      const newItems = mergeResult.newItems.map((item) => decorateAffiliateLink(item, sourceById));
      const priceDrops = mergeResult.priceDrops.map((item) => decorateAffiliateLink(item, sourceById));
      // The hotlist posts to its own channel; its watch groups already decided
      // what matters.
      const notif = await notifier.notifyHotlist({
        newItems,
        priceDrops,
        state,
        webhookUrl: hotlistConfig.webhookUrl,
        notifyPriceDrops: hotlistConfig.notifyPriceDrops !== false,
        purchase: ensurePurchaseState(state.preferences),
        stageListing: purchaseService.stageListing
      });

      state.stats.hotlist = {
        ...(state.stats.hotlist ?? {}),
        lastNotificationSummary: notif
      };
    } else if (isFirstSuccessfulRun && collected.length) {
      console.log(`[hotlist] First successful poll — suppressing ${collected.length} alert(s).`);
    }

    state.stats.hotlist = {
      ...(state.stats.hotlist ?? {}),
      lastPollAt: startedAt,
      lastCount: collected.length,
      lastNewListings: mergeResult.newItems.length,
      lastPriceDrops: mergeResult.priceDrops.length,
      lastRemoved: deletedItemKeys.length,
      lastError: null
    };

    if (changed) {
      await store.save({ skipItems: true });
    }

    return { count: collected.length, newCount: mergeResult.newItems.length };
  });
}

const hotlistPoller = createHotlistPoller({
  run: runHotlistPoll,
  getConfig: () => state.preferences?.hotlist ?? { enabled: false, intervalSeconds: 90, jitterPct: 20 }
});

async function updateHotlistConfig(nextConfig) {
  const updated = normalizeHotlistConfig(nextConfig, state.preferences?.hotlist ?? {});
  state.preferences = { ...(state.preferences ?? {}), hotlist: updated };
  await (store.savePreferences ?? store.save).call(store);
  hotlistPoller.reschedule();
  return updated;
}

// ── Komplett demo-products watcher ─────────────────────────────
// Its own randomised loop (like the hotlist). Every poll is one Apify actor
// run; state lives in its own SQLite record so restarts never re-alert.
const KOMPLETT_DEMO_RECORD = 'komplett-demo';
const komplettDemoPersistence = typeof store.loadRecord === 'function'
  ? {
      load: () => store.loadRecord(KOMPLETT_DEMO_RECORD),
      save: (value) => store.saveRecord(KOMPLETT_DEMO_RECORD, value)
    }
  : {
      load: () => state.stats.komplettDemo ?? null,
      save: async (value) => {
        state.stats.komplettDemo = value;
        await commitExclusive(() => store.save({ skipItems: true }));
      }
    };

/**
 * Mirror the watcher's tracked products into the main listing. Runs after
 * every successful check, after a settings change, and once at startup so the
 * listing is filled from the saved watcher state straight after a deploy.
 * Never sends alerts; the watcher does that itself.
 */
function syncKomplettDemoIntoListing(watcherState = komplettDemoPoller.getState()) {
  return commitExclusive(async () => {
    const result = syncKomplettDemoListing({
      state,
      watcherState,
      config: normalizeKomplettDemoConfig(state.preferences?.komplettDemo ?? {}),
      source: komplettDemoSource,
      maxHistoryEntries: config.maxHistoryEntries,
      getItemHistory: (key) => store.getItemHistory?.(key) ?? []
    });
    store.flushItems(result.changedKeys, result.deletedKeys);
    state.deals = computeDeals(state, config.thresholds);
    productCache.rebuild(state, sourceLabelMap);
    // Archived history of removed products lives in item_archive.
    if (result.deletedKeys.length) await store.save({ skipItems: true });
    return result;
  });
}

const komplettDemoPoller = createKomplettDemoPoller({
  getConfig: () => state.preferences?.komplettDemo ?? {},
  notifier,
  persistence: komplettDemoPersistence,
  onStateChange: (watcherState) => syncKomplettDemoIntoListing(watcherState)
});

async function updateKomplettDemoConfig(nextConfig) {
  const updated = normalizeKomplettDemoConfig(nextConfig, state.preferences?.komplettDemo ?? {});
  state.preferences = { ...(state.preferences ?? {}), komplettDemo: updated };
  await (store.savePreferences ?? store.save).call(store);
  komplettDemoPoller.reschedule();
  // A deselected category's products leave the listing straight away.
  await syncKomplettDemoIntoListing().catch((error) => console.error('[komplett-demo] Listing update failed:', error.message));
  return updated;
}

{
  const { listed, newKeys, deletedKeys } = await syncKomplettDemoIntoListing();
  console.log(`[komplett-demo] Listing: ${listed} demo product(s) from the watcher's saved state (${newKeys.length} added, ${deletedKeys.length} removed).`);
}

// ── Inet watcher (campaign deals + Fyndhörnan outlet) ──────────
// Same pattern as the Komplett watcher: its own randomised loop, one Apify
// run per check (Inet is never contacted from this machine), state in its
// own SQLite record, and every tracked item mirrored into the listing.
const INET_RECORD = 'inet';
const inetPersistence = typeof store.loadRecord === 'function'
  ? {
      load: () => store.loadRecord(INET_RECORD),
      save: (value) => store.saveRecord(INET_RECORD, value)
    }
  : {
      load: () => state.stats.inet ?? null,
      save: async (value) => {
        state.stats.inet = value;
        await commitExclusive(() => store.save({ skipItems: true }));
      }
    };

function syncInetIntoListing(watcherState = inetPoller.getState()) {
  return commitExclusive(async () => {
    const result = syncInetListing({
      state,
      watcherState,
      config: normalizeInetConfig(state.preferences?.inet ?? {}),
      sources: inetSources,
      maxHistoryEntries: config.maxHistoryEntries,
      getItemHistory: (key) => store.getItemHistory?.(key) ?? []
    });
    store.flushItems(result.changedKeys, result.deletedKeys);
    state.deals = computeDeals(state, config.thresholds);
    productCache.rebuild(state, sourceLabelMap);
    if (result.deletedKeys.length) await store.save({ skipItems: true });
    return result;
  });
}

const inetPoller = createInetPoller({
  getConfig: () => state.preferences?.inet ?? {},
  notifier,
  persistence: inetPersistence,
  onStateChange: (watcherState) => syncInetIntoListing(watcherState)
});

async function updateInetConfig(nextConfig) {
  const updated = normalizeInetConfig(nextConfig, state.preferences?.inet ?? {});
  state.preferences = { ...(state.preferences ?? {}), inet: updated };
  await (store.savePreferences ?? store.save).call(store);
  inetPoller.reschedule();
  // A switched-off feed's items leave the listing straight away.
  await syncInetIntoListing().catch((error) => console.error('[inet] Listing update failed:', error.message));
  return updated;
}

{
  const { listed, newKeys, deletedKeys } = await syncInetIntoListing();
  console.log(`[inet] Listing: ${listed} item(s) from the watcher's saved state (${newKeys.length} added, ${deletedKeys.length} removed).`);
}

// ── Webhallen watcher (campaign deals + Fyndvaror outlet) ──────
// Same pattern as the Inet watcher: its own randomised loop, one Apify run per
// check (Webhallen is never contacted from this machine), state in its own
// SQLite record, and every tracked item mirrored into the listing.
const WEBHALLEN_RECORD = 'webhallen';
const webhallenPersistence = typeof store.loadRecord === 'function'
  ? {
      load: () => store.loadRecord(WEBHALLEN_RECORD),
      save: (value) => store.saveRecord(WEBHALLEN_RECORD, value)
    }
  : {
      load: () => state.stats.webhallen ?? null,
      save: async (value) => {
        state.stats.webhallen = value;
        await commitExclusive(() => store.save({ skipItems: true }));
      }
    };

function syncWebhallenIntoListing(watcherState = webhallenPoller.getState()) {
  return commitExclusive(async () => {
    const result = syncWebhallenListing({
      state,
      watcherState,
      config: normalizeWebhallenConfig(state.preferences?.webhallen ?? {}),
      sources: webhallenSources,
      maxHistoryEntries: config.maxHistoryEntries,
      getItemHistory: (key) => store.getItemHistory?.(key) ?? []
    });
    store.flushItems(result.changedKeys, result.deletedKeys);
    state.deals = computeDeals(state, config.thresholds);
    productCache.rebuild(state, sourceLabelMap);
    if (result.deletedKeys.length) await store.save({ skipItems: true });
    return result;
  });
}

const webhallenPoller = createWebhallenPoller({
  getConfig: () => state.preferences?.webhallen ?? {},
  notifier,
  persistence: webhallenPersistence,
  onStateChange: (watcherState) => syncWebhallenIntoListing(watcherState)
});

async function updateWebhallenConfig(nextConfig) {
  const updated = normalizeWebhallenConfig(nextConfig, state.preferences?.webhallen ?? {});
  state.preferences = { ...(state.preferences ?? {}), webhallen: updated };
  await (store.savePreferences ?? store.save).call(store);
  webhallenPoller.reschedule();
  // A switched-off feed's items leave the listing straight away.
  await syncWebhallenIntoListing().catch((error) => console.error('[webhallen] Listing update failed:', error.message));
  return updated;
}

{
  const { listed, newKeys, deletedKeys } = await syncWebhallenIntoListing();
  console.log(`[webhallen] Listing: ${listed} item(s) from the watcher's saved state (${newKeys.length} added, ${deletedKeys.length} removed).`);
}

const app = await buildApp({
  config,
  store,
  productCache,
  fetcher,
  notifier,
  hotlist: hotlistSource
    ? {
        source: hotlistSource,
        getConfig: () => state.preferences?.hotlist ?? {},
        update: updateHotlistConfig,
        getStatus: () => ({
          ...hotlistPoller.getStatus(),
          ...(state.stats.hotlist ?? {}),
          sourceId: hotlistSource.id
        }),
        pollNow: () => hotlistPoller.pollNow()
      }
    : null,
  komplettDemo: {
    getConfig: () => state.preferences?.komplettDemo ?? {},
    update: updateKomplettDemoConfig,
    getStatus: () => komplettDemoPoller.getStatus(),
    getCatalog: () => komplettDemoPoller.getCatalog(),
    pollNow: () => komplettDemoPoller.pollNow()
  },
  inet: {
    getConfig: () => state.preferences?.inet ?? {},
    update: updateInetConfig,
    getStatus: () => inetPoller.getStatus(),
    getCatalog: () => inetPoller.getCatalog(),
    pollNow: () => inetPoller.pollNow()
  },
  webhallen: {
    getConfig: () => state.preferences?.webhallen ?? {},
    update: updateWebhallenConfig,
    getStatus: () => webhallenPoller.getStatus(),
    getCatalog: () => webhallenPoller.getCatalog(),
    pollNow: () => webhallenPoller.pollNow()
  }
});

await app.listen({ port: config.port, host: config.host });
console.log(`[startup] listening at ${process.uptime().toFixed(1)}s`);
console.log(`Price watcher listening at http://${config.host}:${config.port}`);

if (hotlistSource) {
  hotlistPoller.start();
  const hotlistPreference = state.preferences?.hotlist ?? {};
  console.log(
    `[hotlist] Continuous poller ${hotlistPreference.enabled === false ? 'configured (disabled)' : 'started'} — ` +
    `every ~${hotlistPreference.intervalSeconds}s ±${hotlistPreference.jitterPct}% ` +
    `across ${(hotlistPreference.groups ?? []).filter((g) => g.enabled).length} watch group(s).`
  );
}

komplettDemoPoller.start();
{
  const pref = normalizeKomplettDemoConfig(state.preferences?.komplettDemo ?? {});
  console.log(
    `[komplett] Watcher ${pref.enabled ? 'started' : 'configured (disabled)'} — ` +
    `every ~${pref.intervalMinutes} min ±${pref.jitterPct}%, feeds: ${komplettEnabledFeedIds(pref).join(', ') || 'none'}, ` +
    `${pref.groups.filter((g) => g.enabled).length} watch group(s).`
  );
}

inetPoller.start();
{
  const pref = normalizeInetConfig(state.preferences?.inet ?? {});
  console.log(
    `[inet] Watcher ${pref.enabled ? 'started' : 'configured (disabled)'} — ` +
    `every ~${pref.intervalMinutes} min ±${pref.jitterPct}%, feeds: ${inetEnabledFeedIds(pref).join(', ') || 'none'}, ` +
    `${pref.groups.filter((g) => g.enabled).length} watch group(s).`
  );
}

webhallenPoller.start();
{
  const pref = normalizeWebhallenConfig(state.preferences?.webhallen ?? {});
  console.log(
    `[webhallen] Watcher ${pref.enabled ? 'started' : 'configured (disabled)'} — ` +
    `every ~${pref.intervalMinutes} min ±${pref.jitterPct}%, feeds: ${webhallenEnabledFeedIds(pref).join(', ') || 'none'}, ` +
    `${pref.groups.filter((g) => g.enabled).length} watch group(s).`
  );
}

async function shutdown(signal) {
  hotlistPoller.stop();
  komplettDemoPoller.stop();
  inetPoller.stop();
  webhallenPoller.stop();
  await app.close();
  console.log(`${signal} received, shutting down.`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT').catch(e => { console.error(e.message); process.exit(1); }));
process.on('SIGTERM', () => shutdown('SIGTERM').catch(e => { console.error(e.message); process.exit(1); }));
