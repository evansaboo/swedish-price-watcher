import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PoliteFetcher } from './lib/fetcher.js';
import { ApifyStore, JsonStore, reconcileStateWithSources } from './lib/store.js';
import { buildListingKey, isSourceEnabled } from './lib/utils.js';
import { createSchedulerController, normalizeActiveWindow } from './scheduler.js';
import { collectSource } from './sources/index.js';
import { computeDeals, mergeObservations } from './services/dealEngine.js';
import { buildDigestDeals, buildDigestPayload, shouldSendDigest } from './services/digest.js';
import { ProductCache } from './services/productCache.js';
import { DiscordNotifier } from './services/notifier.js';
import { shouldSkipSourceNotifications } from './services/scanPolicy.js';

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

// Initialize product cache — materialized view for fast API queries
const productCache = new ProductCache();
const sourceLabelMap = new Map(config.sources.map(s => [s.id, s.label || s.id]));
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

  const requestedSourceIds = Array.isArray(options.sourceIds) && options.sourceIds.length > 0
    ? new Set(options.sourceIds)
    : null;

  const sourcesToRun = config.sources.filter(entry => {
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
  store.save().catch(err => console.warn(`[scan] Pre-scan save failed (non-fatal): ${err.message}`));

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

  try {
    let processingChain = Promise.resolve();

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

        processingChain = processingChain.then(async () => {
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
          if (collected.length > 0 && !partialSnapshot) {
            const seenKeys = new Set(collected.map(o => buildListingKey(o.sourceId, o.externalId)));
            let pruned = 0;
            const archiveCutoff = Date.now() - config.archiveRetentionDays * 24 * 60 * 60 * 1000;
            for (const key of Object.keys(state.items)) {
              if (state.items[key].sourceId === source.id && !seenKeys.has(key)) {
                const item = state.items[key];
                if (item.history?.length > 0) {
                  state.itemHistory[key] = {
                    history: item.history,
                    lowestPriceSek: item.lowestPriceSek,
                    highestPriceSek: item.highestPriceSek,
                    firstSeenAt: item.firstSeenAt,
                    archivedAt: new Date().toISOString()
                  };
                }
                for (const notifKey of Object.keys(state.notifications)) {
                  if (notifKey.startsWith(`${key}:`)) delete state.notifications[notifKey];
                }
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

          const isFirstSuccessfulRun = !sourceState.lastSuccessAt;
          const skipDiscordNotifications = shouldSkipSourceNotifications({ source, state, sourceState, scanState });
          sourceState.lastSuccessAt = startedAt;
          sourceState.lastError = null;
          sourceState.lastCount = collected.length;
          delete sourceState.disabledUntil;

          state.deals = computeDeals(state, config.thresholds);
          // Rebuild product cache after each source processes
          productCache.rebuild(state, sourceLabelMap);

          sourceResults.push({ sourceId: source.id, status: 'ok', count: collected.length });

          if (skipDiscordNotifications) {
            if (isFirstSuccessfulRun) console.log(`[${source.id}] Skipping Discord notifications on first successful run.`);
            if (scanState.cancelling || scanState.abortController?.signal.aborted) console.log(`[${source.id}] Scan cancelled; saved fetched data without Discord notifications.`);
            return;
          }

          const effectiveNotificationSettings = { ...(state.preferences?.notificationSettings ?? {}) };
          const sourceNotif = await notifier.notifyScan({
            deals: state.deals,
            newItems: mergeResult.newItems,
            priceDrops: mergeResult.priceDrops,
            sources: config.sources,
            state,
            notificationSettings: effectiveNotificationSettings
          });
          mergeNotif(aggregatedNotif, sourceNotif);
          mergeNotif(aggregatedNotif.alertRules, sourceNotif.alertRules);
        });

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
    fetcher.setAbortSignal(null);
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
  scheduler: { getState: () => scheduler.getState(), update: updateScheduler }
});

await app.listen({ port: config.port, host: config.host });
console.log(`Price watcher listening at http://${config.host}:${config.port}`);

if (config.runOnStart) {
  triggerScan('startup').catch(error => {
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

process.on('SIGINT', () => shutdown('SIGINT').catch(e => { console.error(e.message); process.exit(1); }));
process.on('SIGTERM', () => shutdown('SIGTERM').catch(e => { console.error(e.message); process.exit(1); }));
