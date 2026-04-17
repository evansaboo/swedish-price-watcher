import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PoliteFetcher } from './lib/fetcher.js';
import { ApifyStore, JsonStore, reconcileStateWithSources } from './lib/store.js';
import { createSchedulerController, isWithinActiveWindow, normalizeActiveWindow } from './scheduler.js';
import { collectSource } from './sources/index.js';
import { computeDeals, mergeObservations } from './services/dealEngine.js';
import { DiscordNotifier } from './services/notifier.js';

const runOnce = process.argv.includes('--run-once');
const isServerlessRuntime = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const useApifyStateStore = isServerlessRuntime && Boolean(process.env.APIFY_TOKEN?.trim());
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
  lastError: null,
  startedAt: null,
  currentSourceId: null,
  completedSources: 0,
  totalSources: 0
};

let scheduler = null;

async function triggerScan(trigger) {
  if (scanState.running) {
    return store.getState().stats.lastRunSummary;
  }

  scanState.running = true;
  scanState.lastError = null;
  scanState.currentSourceId = null;
  scanState.completedSources = 0;
  scanState.totalSources = config.sources.filter((entry) => entry.enabled).length;

  const startedAt = new Date().toISOString();
  scanState.startedAt = startedAt;
  let observations = 0;
  const newItems = [];
  const priceDrops = [];
  const sourceResults = [];

  state.stats.lastRunStartedAt = startedAt;
  await store.save();

  try {
    for (const source of config.sources.filter((entry) => entry.enabled)) {
      scanState.currentSourceId = source.id;
      const sourceState = state.sourceStates[source.id] ?? {};
      state.sourceStates[source.id] = sourceState;
      sourceState.lastAttemptAt = startedAt;

      try {
        if (sourceState.disabledUntil && Date.parse(sourceState.disabledUntil) > Date.now()) {
          sourceResults.push({
            sourceId: source.id,
            status: 'cooling-down',
            disabledUntil: sourceState.disabledUntil
          });
          continue;
        }

        const collected = await collectSource({
          source,
          fetcher,
          sourceState,
          now: startedAt
        });

        observations += collected.length;
        const mergeResult = mergeObservations(state, collected, config.maxHistoryEntries);
        newItems.push(...mergeResult.newItems);
        priceDrops.push(...mergeResult.priceDrops);
        sourceState.lastSuccessAt = startedAt;
        sourceState.lastError = null;
        sourceState.lastCount = collected.length;
        delete sourceState.disabledUntil;

        sourceResults.push({
          sourceId: source.id,
          status: 'ok',
          count: collected.length
        });
      } catch (error) {
        sourceState.lastError = error.message;

        if (error.disableHours) {
          sourceState.disabledUntil = new Date(Date.now() + error.disableHours * 60 * 60 * 1000).toISOString();
        }

        sourceResults.push({
          sourceId: source.id,
          status: 'error',
          message: error.message,
          disabledUntil: sourceState.disabledUntil ?? null
        });
      } finally {
        scanState.completedSources += 1;
      }
    }

    state.deals = computeDeals(state, config.thresholds);

    const notificationSummary = await notifier.notifyScan({
      deals: state.deals,
      newItems,
      priceDrops,
      sources: config.sources,
      state
    });
    const completedAt = new Date().toISOString();

    state.stats.lastRunCompletedAt = completedAt;
    state.stats.lastRunSummary = {
      trigger,
      startedAt,
      completedAt,
      observations,
      newListings: newItems.length,
      priceDrops: priceDrops.length,
      trackedItems: Object.keys(state.items).length,
      deals: state.deals.length,
      amazingDeals: state.deals.filter((deal) => deal.amazingDeal).length,
      notificationSummary,
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
    scanState.startedAt = null;
    scanState.currentSourceId = null;
    scanState.completedSources = 0;
    scanState.totalSources = 0;
  }
}

if (runOnce) {
  const summary = await triggerScan('cli');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

function createServerlessSchedulerAdapter(initialPreference) {
  let current = {
    enabled: Boolean(initialPreference.enabled),
    intervalMinutes: initialPreference.intervalMinutes,
    activeWindow: initialPreference.activeWindow
  };

  return {
    getState() {
      return {
        ...current,
        nextRunAt: null,
        isInActiveWindow: isWithinActiveWindow(current.activeWindow, new Date())
      };
    },
    update(next = {}) {
      if (next.enabled !== undefined) {
        current.enabled = Boolean(next.enabled);
      }

      if (next.intervalMinutes !== undefined) {
        const intervalMinutes = Number.parseInt(String(next.intervalMinutes), 10);

        if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
          throw new Error('intervalMinutes must be a positive integer.');
        }

        current.intervalMinutes = intervalMinutes;
      }

      if (next.activeWindow !== undefined) {
        current.activeWindow = normalizeActiveWindow(next.activeWindow, current.activeWindow);
      }

      return this.getState();
    },
    stop() {}
  };
}

scheduler = isServerlessRuntime
  ? createServerlessSchedulerAdapter(schedulerPreference)
  : createSchedulerController({
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
  scheduler: {
    getState: () => scheduler.getState(),
    update: updateScheduler
  },
  manualRunMode: isServerlessRuntime ? 'blocking' : 'background',
  serveStatic: true
});

await app.ready();

if (!isServerlessRuntime) {
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
    scheduler?.stop();
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
}

export default async function handler(req, res) {
  app.server.emit('request', req, res);
}
