import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PoliteFetcher } from './lib/fetcher.js';
import { createPurchaseService } from './services/purchaseService.js';
import { ensurePurchaseState } from './services/purchaseEngine.js';
import { ApifyStore, JsonStore, SqliteStore, migrateJsonToSqlite, reconcileStateWithSources } from './lib/store.js';
import { buildListingKey, isSourceEnabled } from './lib/utils.js';
import { createSchedulerController, normalizeActiveWindow } from './scheduler.js';
import { collectSource } from './sources/index.js';
import { computeDeals, mergeObservations } from './services/dealEngine.js';
import { createHotlistPoller } from './services/hotlistPoller.js';
import { ensureHotlistConfig, normalizeHotlistConfig } from './services/hotlistConfig.js';
import { buildDigestDeals, buildDigestPayload, shouldSendDigest } from './services/digest.js';
import { ProductCache } from './services/productCache.js';
import { DiscordNotifier } from './services/notifier.js';
import { shouldSkipSourceNotifications } from './services/scanPolicy.js';
import { decorateAffiliateLink } from './services/affiliateLinks.js';

const runOnce = process.argv.includes('--run-once');
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
reconcileStateWithSources(store.getState(), config.sources);
const state = store.getState();
// Recompute deals from loaded items — deals are not persisted to keep state lean.
state.deals = computeDeals(state, config.thresholds);

// Initialize product cache — materialized view for fast API queries
const productCache = new ProductCache();
const sourceLabelMap = new Map(config.sources.map(s => [s.id, s.label || s.id]));
const sourceById = new Map(config.sources.map(s => [s.id, s]));
// The hotlist runs on its own continuous loop rather than the shared scan
// cycle, so it is excluded from every scan and owned by the poller below.
const hotlistSources = config.sources.filter((entry) => entry.type?.endsWith('-hotlist') || entry.id?.endsWith('-hotlist'));
const hotlistSource = hotlistSources.find((entry) => entry.type === 'elgiganten-hotlist') ?? hotlistSources[0] ?? null;

productCache.rebuild(state, sourceLabelMap);

// Wire store invalidation to rebuild cache on saves
if (store.onInvalidate) {
  store.onInvalidate(() => productCache.rebuild(store.getState(), sourceLabelMap));
}

const configuredInterval = Number.isFinite(config.scanIntervalMinutes) && config.scanIntervalMinutes > 0 ? config.scanIntervalMinutes : 180;
const existingSchedulerPreference = state.preferences?.scheduler ?? {};
const parsedSchedulerInterval = Number.parseInt(String(existingSchedulerPreference.intervalMinutes ?? ''), 10);
const schedulerPreference = {
  enabled:
    existingSchedulerPreference.enabled === undefined
      ? config.scanIntervalMinutes > 0
      : Boolean(existingSchedulerPreference.enabled),
  intervalMinutes: Number.isFinite(parsedSchedulerInterval) && parsedSchedulerInterval > 0 ? parsedSchedulerInterval : configuredInterval,
  activeWindow: normalizeActiveWindow(existingSchedulerPreference.activeWindow)
};

state.preferences = {
  ...(state.preferences ?? {}),
  scheduler: schedulerPreference
};

// Seed the hotlist watch list from config/sources.json the first time, then
// let the dashboard own it from SQLite preferences.
if (hotlistSource) ensureHotlistConfig(state.preferences, hotlistSource);

await store.save();

const fetcher = new PoliteFetcher(config);
const notifier = new DiscordNotifier({
  webhookUrl: config.discordWebhookUrl,
  cooldownHours: config.notificationCooldownHours,
  botToken: config.purchase?.discordBotToken,
  alertChannelId: config.purchase?.discordAlertChannelId,
  // The hotlist notifies through its own webhook; this keeps its finds out of
  // the alert-rule pipeline.
  hotlistSourceId: hotlistSource?.id ?? '',
  hotlistSourceIds: hotlistSources.map(s => s.id)
});

// Shared with the HTTP layer so dashboard, Discord button and proactive
// cart-staging all run through the same spend caps and rate limits.
const purchaseService = createPurchaseService({
  config,
  getPreferences: () => store.getState().preferences,
  findItem: (listingKey) => store.getState().items?.[listingKey] ?? null,
  save: () => store.save()
});

const scanState = {
  running: false,
  cancelling: false,
  lastError: null,
  startedAt: null,
  currentSourceId: null,
  completedSources: 0,
  totalSources: 0,
  abortController: null
};

// A full scan and a hotlist poll both mutate `state` and persist it. Every
// mutation runs through this one chain so the two can never interleave.
let stateCommitChain = Promise.resolve();
function commitExclusive(fn) {
  const result = stateCommitChain.then(fn, fn);
  stateCommitChain = result.then(() => {}, () => {});
  return result;
}

async function triggerScan(trigger, options = {}) {
  if (scanState.running) {
    return store.getState().stats.lastRunSummary;
  }

  const requestedSourceIds = Array.isArray(options.sourceIds) && options.sourceIds.length > 0
    ? new Set(options.sourceIds)
    : null;

  const sourcesToRun = config.sources.filter(entry => {
    // Owned by the continuous hotlist poller, never by a scan.
    if (entry.type?.endsWith('-hotlist') || entry.id?.endsWith('-hotlist')) return false;
    if (requestedSourceIds) return requestedSourceIds.has(entry.id);
    if (!isSourceEnabled(entry, store.getState())) return false;
    if (trigger === 'scheduled' && Number.isFinite(entry.scanIntervalMinutes) && entry.scanIntervalMinutes > 0) {
      const srcState = store.getState().sourceStates[entry.id];
      const lastRun = srcState?.lastSuccessAt ?? srcState?.lastAttemptAt;
      if (lastRun) {
        const elapsedMinutes = (Date.now() - Date.parse(lastRun)) / 60_000;
        if (elapsedMinutes < entry.scanIntervalMinutes) {
          console.log(`[scheduler] Skipping ${entry.id}: last run ${Math.round(elapsedMinutes)}m ago (interval: ${entry.scanIntervalMinutes}m)`);
          return false;
        }
      }
    }
    return true;
  });

  if (!sourcesToRun.length) {
    throw Object.assign(new Error('No matching enabled sources to run.'), { statusCode: 400 });
  }

  scanState.running = true;
  scanState.cancelling = false;
  scanState.lastError = null;
  scanState.currentSourceId = null;
  scanState.completedSources = 0;
  scanState.totalSources = sourcesToRun.length;
  scanState.sourceProgress = {};
  scanState.abortController = new AbortController();
  fetcher.setAbortSignal(scanState.abortController.signal);

  const startedAt = new Date().toISOString();
  scanState.startedAt = startedAt;
  let observations = 0;
  const newItems = [];
  const priceDrops = [];
  const sourceResults = [];

  state.stats.lastRunStartedAt = startedAt;
  if (trigger === 'scheduled') {
    state.stats.lastScheduledRunStartedAt = startedAt;
  }
  // No pre-scan save — the SqliteStore writes items incrementally via
  // flushItems() after each source, so there's nothing critical to persist
  // at scan start. Saving 26k items here would block the event loop for
  // several seconds and make the UI unresponsive when a scan is triggered.

  const aggregatedNotif = {
    sent: 0, skipped: 0, failed: 0, errors: [],
    alertRules: { sent: 0, skipped: 0, failed: 0, errors: [] }
  };

  function mergeNotif(agg, n) {
    if (!n) return;
    agg.sent += n.sent ?? 0;
    agg.skipped += n.skipped ?? 0;
    agg.failed += n.failed ?? 0;
    agg.errors.push(...(n.errors ?? []));
  }

  // ── Coalesced heavy recompute ────────────────────────────────
  // Recomputing deals + rebuilding the 26k-item product cache is a multi-second
  // synchronous job. Running it after every source (14×/scan) froze the event
  // loop and made the UI unresponsive mid-scan. Instead we queue each source's
  // notification context and flush on a throttle (and once at the end): one
  // recompute serves every source that finished since the last flush.
  let lastHeavyRecomputeAt = 0;
  let dirtySinceRecompute = false;
  const pendingNotify = [];

  async function flushPending() {
    if (!dirtySinceRecompute) return;
    const t0 = Date.now();
    state.deals = computeDeals(state, config.thresholds);
    productCache.rebuild(state, sourceLabelMap);
    const recomputeMs = Date.now() - t0;
    lastHeavyRecomputeAt = Date.now();
    dirtySinceRecompute = false;

    const batch = pendingNotify.splice(0);
    if (batch.length > 0) {
      console.log(`[scan] Coalesced recompute ${recomputeMs}ms for ${batch.length} source(s): ${batch.map((c) => c.source.id).join(', ')}`);
    }
    for (const ctx of batch) {
      if (ctx.skipDiscordNotifications) {
        if (ctx.isFirstSuccessfulRun) console.log(`[${ctx.source.id}] Skipping Discord notifications on first successful run.`);
        if (scanState.cancelling || scanState.abortController?.signal.aborted) console.log(`[${ctx.source.id}] Scan cancelled; saved fetched data without Discord notifications.`);
        continue;
      }
      const effectiveNotificationSettings = { ...(state.preferences?.notificationSettings ?? {}) };
      const sourceNotif = await notifier.notifyScan({
        deals: state.deals,
        newItems: ctx.mergeResult.newItems.map((item) => decorateAffiliateLink(item, sourceById)),
        priceDrops: ctx.mergeResult.priceDrops.map((item) => decorateAffiliateLink(item, sourceById)),
        sources: config.sources,
        state,
        notificationSettings: effectiveNotificationSettings,
        wishlistTargets: state.preferences?.wishlistTargets ?? {},
        purchase: ensurePurchaseState(state.preferences),
        stageListing: purchaseService.stageListing
      });
      mergeNotif(aggregatedNotif, sourceNotif);
      mergeNotif(aggregatedNotif.alertRules, sourceNotif.alertRules);
    }
  }

  try {
    await Promise.all(
      sourcesToRun.map(async (source) => {
        const sourceState = state.sourceStates[source.id] ?? {};
        state.sourceStates[source.id] = sourceState;
        sourceState.lastAttemptAt = startedAt;

        sourceState.knownExternalIds = new Set(
          Object.values(state.items)
            .filter(item => item.sourceId === source.id)
            .map(item => item.externalId)
        );

        let collectResult;
        try {
          if (sourceState.disabledUntil && Date.parse(sourceState.disabledUntil) > Date.now()) {
            scanState.sourceProgress[source.id] = { status: 'cooling-down' };
            collectResult = { status: 'cooling-down', disabledUntil: sourceState.disabledUntil };
          } else {
            scanState.sourceProgress[source.id] = { status: 'running' };
            const sourceTimeoutMs = source.sourceTimeoutMs ?? 10 * 60 * 1000;
            const timeoutPromise = new Promise((_, reject) => {
              const t = setTimeout(() => {
                const err = new Error(`Source timed out after ${Math.round(sourceTimeoutMs / 1000)}s`);
                err.isTimeout = true;
                reject(err);
              }, sourceTimeoutMs);
              if (t.unref) t.unref();
            });
            const collected = await Promise.race([
              collectSource({ source, fetcher, sourceState, now: startedAt, preferences: state.preferences, signal: scanState.abortController.signal }),
              timeoutPromise
            ]);
            scanState.sourceProgress[source.id] = { status: 'done', count: collected.length };
            collectResult = { status: 'ok', collected };
          }
        } catch (error) {
          const cancelled = scanState.abortController?.signal.aborted || error?.name === 'AbortError' || /aborted/i.test(error?.message ?? '');
          scanState.sourceProgress[source.id] = cancelled ? { status: 'cancelled' } : { status: 'error', message: error.message };
          collectResult = cancelled ? { status: 'cancelled', error } : { status: 'error', error };
        } finally {
          scanState.completedSources += 1;
        }

        await commitExclusive(async () => {
          // The known-ID Set is scan-scoped scratch state — a Set serializes as {},
          // so it must not leak into the persisted store.
          delete sourceState.knownExternalIds;
          if (collectResult.status === 'cooling-down') {
            sourceResults.push({ sourceId: source.id, status: 'cooling-down', disabledUntil: collectResult.disabledUntil });
            return;
          }
          if (collectResult.status === 'cancelled') {
            sourceResults.push({ sourceId: source.id, status: 'cancelled' });
            return;
          }
          if (collectResult.status === 'error') {
            const { error } = collectResult;
            sourceState.lastError = error.message;
            if (error.disableHours) {
              sourceState.disabledUntil = new Date(Date.now() + error.disableHours * 60 * 60 * 1000).toISOString();
            }
            const cooldownNote = sourceState.disabledUntil ? ` — cooling down until ${sourceState.disabledUntil}` : '';
            console.error(`[${source.id}] Scan failed: ${error.message}${cooldownNote}`);
            sourceResults.push({ sourceId: source.id, status: 'error', message: error.message, disabledUntil: sourceState.disabledUntil ?? null });
            return;
          }

          const { collected } = collectResult;
          const scanCancelled = scanState.cancelling || scanState.abortController?.signal.aborted;
          if (scanCancelled && collected.length === 0) {
            sourceResults.push({ sourceId: source.id, status: 'cancelled' });
            return;
          }

          observations += collected.length;
          const mergeResult = mergeObservations(state, collected, config.maxHistoryEntries);
          newItems.push(...mergeResult.newItems);
          priceDrops.push(...mergeResult.priceDrops);

          // Prune only on complete snapshots. Cancelled scans and partial collections
          // (incremental early-stop, mid-pagination failures) would otherwise delete
          // valid items that simply weren't revisited — and re-alert them as "new" later.
          const partialSnapshot = scanCancelled || sourceState.lastScanPartial === true;
          const deletedItemKeys = [];
          if (collected.length > 0 && !partialSnapshot) {
            const seenKeys = new Set(collected.map(o => buildListingKey(o.sourceId, o.externalId)));
            let pruned = 0;
            const archiveCutoff = Date.now() - config.archiveRetentionDays * 24 * 60 * 60 * 1000;
            for (const key of Object.keys(state.items)) {
              if (state.items[key].sourceId === source.id && !seenKeys.has(key)) {
                const item = state.items[key];
                // history may be empty if not yet rebuilt by a scan; fall back to DB query
                const historyToArchive = item.history?.length > 0 ? item.history : store.getItemHistory(key);
                if (historyToArchive.length > 0) {
                  state.itemHistory[key] = {
                    history: historyToArchive,
                    lowestPriceSek: item.lowestPriceSek,
                    highestPriceSek: item.highestPriceSek,
                    firstSeenAt: item.firstSeenAt,
                    archivedAt: new Date().toISOString()
                  };
                }
                for (const notifKey of Object.keys(state.notifications)) {
                  if (notifKey.startsWith(`${key}:`)) delete state.notifications[notifKey];
                }
                deletedItemKeys.push(key);
                delete state.items[key];
                pruned += 1;
              }
            }
            for (const key of Object.keys(state.itemHistory ?? {})) {
              const entry = state.itemHistory[key];
              if (!entry?.archivedAt || Date.parse(entry.archivedAt) < archiveCutoff) {
                delete state.itemHistory[key];
              }
            }
            if (pruned > 0) console.log(`[${source.id}] Pruned ${pruned} stale item(s).`);
          }

          // Incrementally flush only the items that changed this scan to SQLite.
          // This avoids re-writing all 26k items + 122k history rows on every source
          // completion, which would block the Node.js event loop for several seconds.
          if (collected.length > 0 || deletedItemKeys.length > 0) {
            const changedKeys = collected.map(o => buildListingKey(o.sourceId, o.externalId));
            store.flushItems(changedKeys, deletedItemKeys);
          }

          const isFirstSuccessfulRun = !sourceState.lastSuccessAt;
          const skipDiscordNotifications = shouldSkipSourceNotifications({ source, state, sourceState, scanState });
          sourceState.lastSuccessAt = startedAt;
          sourceState.lastError = null;
          sourceState.lastCount = collected.length;
          delete sourceState.disabledUntil;

          // Queue this source for the next coalesced recompute + notification flush.
          // The heavy work (computeDeals + productCache.rebuild) happens in
          // flushPending — on a throttle here, and once more after all sources.
          dirtySinceRecompute = true;
          sourceResults.push({ sourceId: source.id, status: 'ok', count: collected.length });
          pendingNotify.push({ source, mergeResult, skipDiscordNotifications, isFirstSuccessfulRun });

          if (Date.now() - lastHeavyRecomputeAt >= config.recomputeIntervalMs) {
            await flushPending();
          }
        });
      })
    );

    // Final coalesced recompute — flushes any sources queued since the last
    // throttle tick and guarantees deals + cache reflect the whole scan.
    await flushPending();

    const completedAt = new Date().toISOString();
    state.stats.lastRunCompletedAt = completedAt;
    state.stats.lastRunSummary = {
      trigger,
      startedAt,
      completedAt,
      cancelled: scanState.abortController?.signal.aborted ?? false,
      observations,
      newListings: newItems.length,
      priceDrops: priceDrops.length,
      trackedItems: Object.keys(state.items).length,
      deals: state.deals.length,
      notificationSummary: aggregatedNotif,
      sourceResults
    };

    await store.save({ skipItems: true });
    return state.stats.lastRunSummary;
  } catch (error) {
    scanState.lastError = error.message;
    state.stats.lastRunCompletedAt = new Date().toISOString();
    state.stats.lastRunSummary = {
      trigger,
      startedAt,
      completedAt: state.stats.lastRunCompletedAt,
      error: error.message,
      observations,
      sourceResults
    };
    await store.save({ skipItems: true });
    throw error;
  } finally {
    scanState.running = false;
    scanState.cancelling = false;
    scanState.startedAt = null;
    scanState.currentSourceId = null;
    scanState.completedSources = 0;
    scanState.totalSources = 0;
    scanState.sourceProgress = {};
    scanState.abortController = null;
    fetcher.setAbortSignal(null);
  }
}

function cancelScan() {
  if (!scanState.running) return false;
  scanState.cancelling = true;
  scanState.abortController?.abort();
  return true;
}

// ── Hotlist: continuous multi-store poller ─────────────────────
// Deliberately independent of the scan scheduler. A scan takes minutes and
// walks every source; a hotlist poll targets high-resale categories and
// flash deals across Elgiganten and Amazon.se on a dedicated loop.

async function runHotlistPoll() {
  if (!hotlistSources.length) return { count: 0, newCount: 0 };

  const startedAt = new Date().toISOString();
  const allCollected = [];
  const activeHotlistSourceIds = new Set();
  const hotlistErrors = [];

  for (const src of hotlistSources) {
    if (src.enabled === false) continue;
    activeHotlistSourceIds.add(src.id);
    const sourceState = state.sourceStates[src.id] ?? {};
    state.sourceStates[src.id] = sourceState;

    if (sourceState.disabledUntil && Date.parse(sourceState.disabledUntil) > Date.now()) {
      continue;
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
  }

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
        for (const notifKey of Object.keys(state.notifications)) {
          if (notifKey.startsWith(`${key}:`)) delete state.notifications[notifKey];
        }
        deletedItemKeys.push(key);
        delete state.items[key];
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

    // Most polls find exactly what the previous one did. Recomputing deals and
    // rebuilding the 26k-item product cache every 90s for no change would burn
    // seconds of event loop for nothing, so the heavy work is change-gated.
    if (changed) {
      state.deals = computeDeals(state, config.thresholds);
      productCache.rebuild(state, sourceLabelMap);
    }

    if (!skipDiscordNotifications && (mergeResult.newItems.length || mergeResult.priceDrops.length)) {
      const hotlistConfig = state.preferences?.hotlist ?? {};
      const newItems = mergeResult.newItems.map((item) => decorateAffiliateLink(item, sourceById));
      const priceDrops = mergeResult.priceDrops.map((item) => decorateAffiliateLink(item, sourceById));
      // The hotlist posts to its own channel and is deliberately not run
      // through the alert rules — its watch groups already decided what
      // matters, and routing through unrelated keyword rules sent finds to
      // whichever channel happened to match. It is completely independent
      // of normal scan notification toggles.
      const notif = await notifier.notifyHotlist({
        newItems,
        priceDrops,
        state,
        webhookUrl: hotlistConfig.webhookUrl,
        notifyPriceDrops: hotlistConfig.notifyPriceDrops !== false,
        purchase: ensurePurchaseState(state.preferences),
        stageListing: purchaseService.stageListing
      });

      // Wishlist targets stay active: those are per-item prices the user set
      // explicitly, and they already have their own webhook and toggle.
      const wishlist = await notifier.notifyWishlistTargets({
        newItems,
        priceDrops,
        state,
        wishlistTargets: state.preferences?.wishlistTargets ?? {},
        config: notificationSettings.wishlistAlerts
      });

      state.stats.hotlist = {
        ...(state.stats.hotlist ?? {}),
        lastNotificationSummary: { ...notif, wishlistAlerts: wishlist }
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
  getConfig: () => state.preferences?.hotlist ?? { enabled: false, intervalSeconds: 90, jitterPct: 20 },
  // A full scan holds the commit mutex for minutes; polling through it would
  // just queue up stale work, so the poller yields and retries.
  isPaused: () => scanState.running
});

async function updateHotlistConfig(nextConfig) {
  const updated = normalizeHotlistConfig(nextConfig, state.preferences?.hotlist ?? {});
  state.preferences = { ...(state.preferences ?? {}), hotlist: updated };
  await (store.savePreferences ?? store.save).call(store);
  hotlistPoller.reschedule();
  return updated;
}

if (runOnce) {
  const summary = await triggerScan('cli');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const scheduler = createSchedulerController({
  run: () => triggerScan('scheduled'),
  enabled: schedulerPreference.enabled,
  intervalMinutes: schedulerPreference.intervalMinutes,
  activeWindow: schedulerPreference.activeWindow
});

// ── Daily digest ───────────────────────────────────────────────
// Checked every minute; fires once per Stockholm day at/after the
// configured time. Empty days are marked sent without posting.
async function maybeSendDigest() {
  const digest = state.preferences?.notificationSettings?.digest;
  if (!shouldSendDigest(digest, state.stats.lastDigestSentAt)) return;

  state.stats.lastDigestSentAt = new Date().toISOString();
  const deals = buildDigestDeals(state, {
    maxItems: digest.maxItems ?? 10,
    minScore: digest.minScore ?? 0
  });

  if (deals.length === 0) {
    console.log('[digest] No new deals in the last 24h — skipping today\'s digest.');
  } else {
    try {
      await notifier.sendToWebhook(buildDigestPayload(deals), digest.webhook.trim());
      console.log(`[digest] Sent daily digest with ${deals.length} deal(s).`);
    } catch (error) {
      console.error('[digest]', error.message);
    }
  }
  store.save().catch((err) => console.warn(`[digest] Save failed (non-fatal): ${err.message}`));
}

const digestTimer = setInterval(() => { maybeSendDigest().catch((err) => console.error('[digest]', err.message)); }, 60_000);
if (digestTimer.unref) digestTimer.unref();

async function updateScheduler(nextSettings = {}) {
  const updated = scheduler.update(nextSettings);
  state.preferences = {
    ...(state.preferences ?? {}),
    scheduler: { enabled: updated.enabled, intervalMinutes: updated.intervalMinutes, activeWindow: updated.activeWindow }
  };
  await (store.savePreferences ?? store.save).call(store);
  return updated;
}

const app = await buildApp({
  config,
  store,
  productCache,
  scanState,
  triggerScan,
  cancelScan,
  fetcher,
  scheduler: { getState: () => scheduler.getState(), update: updateScheduler },
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
    : null
});

await app.listen({ port: config.port, host: config.host });
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

if (config.runOnStart) {
  triggerScan('startup').catch(error => {
    scanState.lastError = error.message;
    console.error('[startup-scan]', error.message);
  });
}

async function shutdown(signal) {
  scheduler.stop();
  hotlistPoller.stop();
  await app.close();
  console.log(`${signal} received, shutting down.`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT').catch(e => { console.error(e.message); process.exit(1); }));
process.on('SIGTERM', () => shutdown('SIGTERM').catch(e => { console.error(e.message); process.exit(1); }));
