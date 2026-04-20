import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PoliteFetcher } from './lib/fetcher.js';
import { ApifyStore, JsonStore, reconcileStateWithSources } from './lib/store.js';
import { buildListingKey, isSourceEnabled } from './lib/utils.js';
import { createSchedulerController, normalizeActiveWindow } from './scheduler.js';
import { collectSource } from './sources/index.js';
import { computeDeals, mergeObservations } from './services/dealEngine.js';
import { DiscordNotifier } from './services/notifier.js';

const runOnce = process.argv.includes('--run-once');
const isRailwayRuntime = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const useApifyStateStore = isRailwayRuntime && Boolean(process.env.APIFY_TOKEN?.trim());
const config = await loadConfig();
const store = useApifyStateStore
  ? new ApifyStore({
      token: process.env.APIFY_TOKEN.trim(),
      storeName: process.env.APIFY_STATE_STORE_NAME ?? 'swedish-price-watcher-state',
      recordKey: process.env.APIFY_STATE_RECORD_KEY ?? 'state'
    })
  : new JsonStore(config.dataFile);

await store.load();
reconcileStateWithSources(store.getState(), config.sources);
const state = store.getState();
// Recompute deals from loaded items — deals are not persisted to keep state lean.
state.deals = computeDeals(state, config.thresholds);
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

await store.save();

const fetcher = new PoliteFetcher(config);
const notifier = new DiscordNotifier({
  webhookUrl: config.discordWebhookUrl,
  cooldownHours: config.notificationCooldownHours
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

async function triggerScan(trigger, options = {}) {
  if (scanState.running) {
    return store.getState().stats.lastRunSummary;
  }

  // Optional: limit scan to specific source IDs
  const requestedSourceIds = Array.isArray(options.sourceIds) && options.sourceIds.length > 0
    ? new Set(options.sourceIds)
    : null;

  const sourcesToRun = config.sources.filter(
    (entry) => {
      // Manual scan with explicit sourceIds: always allow regardless of enabled state
      if (requestedSourceIds) return requestedSourceIds.has(entry.id);
      // Scheduled / full scan: respect enabled overrides
      return isSourceEnabled(entry, store.getState());
    }
  );

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
  await store.save();

  // Aggregate notification summaries from per-source notifications
  const aggregatedNotif = {
    sent: 0, skipped: 0, failed: 0, errors: [],
    // amazingDeals removed: not used anymore

    newListings: { sent: 0, skipped: 0, failed: 0, messages: 0, errors: [] },
    favoriteCategoryEvents: { sent: 0, skipped: 0, failed: 0, newListingEvents: 0, priceDropEvents: 0, errors: [] },
    keywordMatches: { sent: 0, skipped: 0, failed: 0, errors: [] }
  };

  function mergeNotif(agg, n) {
    if (!n) return;
    agg.sent += n.sent ?? 0;
    agg.skipped += n.skipped ?? 0;
    agg.failed += n.failed ?? 0;
    agg.errors.push(...(n.errors ?? []));
    if (n.messages != null) agg.messages = (agg.messages ?? 0) + n.messages;
    if (n.newListingEvents != null) agg.newListingEvents = (agg.newListingEvents ?? 0) + n.newListingEvents;
    if (n.priceDropEvents != null) agg.priceDropEvents = (agg.priceDropEvents ?? 0) + n.priceDropEvents;
  }

  try {
    // Each source runs concurrently (I/O phase).  As each one finishes, its results
    // are immediately processed via a serialized mutex chain — so state mutations,
    // Discord notifications, and store saves happen one source at a time.
    // This means the products table and Discord are updated incrementally as each
    // source completes, without waiting for all sources to finish.
    let processingChain = Promise.resolve();

    await Promise.all(
      sourcesToRun.map(async (source) => {
        const sourceState = state.sourceStates[source.id] ?? {};
        state.sourceStates[source.id] = sourceState;
        sourceState.lastAttemptAt = startedAt;

        // ── I/O phase: runs concurrently with other sources ─────────────────
        let collectResult;
        try {
          if (sourceState.disabledUntil && Date.parse(sourceState.disabledUntil) > Date.now()) {
            scanState.sourceProgress[source.id] = { status: 'cooling-down' };
            collectResult = { status: 'cooling-down', disabledUntil: sourceState.disabledUntil };
          } else {
            scanState.sourceProgress[source.id] = { status: 'running' };
            const collected = await collectSource({ source, fetcher, sourceState, now: startedAt });
            scanState.sourceProgress[source.id] = { status: 'done', count: collected.length };
            collectResult = { status: 'ok', collected };
          }
        } catch (error) {
          scanState.sourceProgress[source.id] = { status: 'error', message: error.message };
          collectResult = { status: 'error', error };
        } finally {
          scanState.completedSources += 1;
        }

        // ── Processing phase: serialized via mutex chain ─────────────────────
        // Setting processingChain is synchronous (no await between read + write),
        // so there is no race when multiple workers reach this line concurrently.
        processingChain = processingChain.then(async () => {
          if (scanState.abortController?.signal.aborted) {
            sourceResults.push({ sourceId: source.id, status: 'cancelled' });
            return;
          }

          if (collectResult.status === 'cooling-down') {
            sourceResults.push({ sourceId: source.id, status: 'cooling-down', disabledUntil: collectResult.disabledUntil });
            return;
          }

          if (collectResult.status === 'error') {
            const { error } = collectResult;
            sourceState.lastError = error.message;
            if (error.disableHours) {
              sourceState.disabledUntil = new Date(Date.now() + error.disableHours * 60 * 60 * 1000).toISOString();
            }
            sourceResults.push({ sourceId: source.id, status: 'error', message: error.message, disabledUntil: sourceState.disabledUntil ?? null });
            await store.save();
            return;
          }

          const { collected } = collectResult;
          observations += collected.length;
          const mergeResult = mergeObservations(state, collected, config.maxHistoryEntries);
          newItems.push(...mergeResult.newItems);
          priceDrops.push(...mergeResult.priceDrops);

          if (collected.length > 0) {
            const seenKeys = new Set(collected.map((o) => buildListingKey(o.sourceId, o.externalId)));
            let pruned = 0;
            for (const key of Object.keys(state.items)) {
              if (state.items[key].sourceId === source.id && !seenKeys.has(key)) {
                delete state.items[key];
                pruned += 1;
              }
            }
            if (pruned > 0) console.log(`[${source.id}] Pruned ${pruned} stale item(s).`);
          }

          sourceState.lastSuccessAt = startedAt;
          sourceState.lastError = null;
          sourceState.lastCount = collected.length;
          delete sourceState.disabledUntil;

          state.deals = computeDeals(state, config.thresholds);

          // Save state immediately so the products API returns fresh data as each
          // source finishes — Discord notifications run after so they never block
          // the table from updating.
          await store.save();

          sourceResults.push({ sourceId: source.id, status: 'ok', count: collected.length });

          // Send Discord notifications after state is persisted.
          const sourceNotif = await notifier.notifyScan({
            deals: state.deals,
            newItems: mergeResult.newItems,
            priceDrops: mergeResult.priceDrops,
            sources: config.sources,
            state,
            notificationSettings: state.preferences?.notificationSettings
          });
          mergeNotif(aggregatedNotif, sourceNotif);
          // amazingDeals removed: no-op
          mergeNotif(aggregatedNotif.newListings, sourceNotif.newListings);
          mergeNotif(aggregatedNotif.favoriteCategoryEvents, sourceNotif.favoriteCategoryEvents);
          mergeNotif(aggregatedNotif.keywordMatches, sourceNotif.keywordMatches);
        });

        // Wait for this source's turn in the processing queue before resolving.
        await processingChain;
      })
    );

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
      // amazingDeals summary removed
      notificationSummary: aggregatedNotif,
      sourceResults
    };

    await store.save();
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
    await store.save();
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
  }
}

function cancelScan() {
  if (!scanState.running) return false;
  scanState.cancelling = true;
  scanState.abortController?.abort();
  return true;
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

async function updateScheduler(nextSettings = {}) {
  const updated = scheduler.update(nextSettings);

  state.preferences = {
    ...(state.preferences ?? {}),
    scheduler: {
      enabled: updated.enabled,
      intervalMinutes: updated.intervalMinutes,
      activeWindow: updated.activeWindow
    }
  };

  await store.save();
  return updated;
}

const app = await buildApp({
  config,
  store,
  scanState,
  triggerScan,
  cancelScan,
  scheduler: {
    getState: () => scheduler.getState(),
    update: updateScheduler
  }
});

await app.listen({
  port: config.port,
  host: config.host
});

console.log(`Price watcher listening at http://${config.host}:${config.port}`);

if (config.runOnStart) {
  triggerScan('startup').catch((error) => {
    scanState.lastError = error.message;
    console.error('[startup-scan]', error.message);
  });
}

async function shutdown(signal) {
  scheduler.stop();
  await app.close();
  console.log(`${signal} received, shutting down.`);
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
});
