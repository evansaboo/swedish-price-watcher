import fs from 'node:fs/promises';
import path from 'node:path';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { PoliteFetcher } from '../src/lib/fetcher.js';
import { JsonStore, reconcileStateWithSources } from '../src/lib/store.js';
import { collectSource } from '../src/sources/index.js';
import { computeDeals, mergeObservations } from '../src/services/dealEngine.js';
import { DiscordNotifier } from '../src/services/notifier.js';
import { isWithinActiveWindow, normalizeActiveWindow } from '../src/scheduler.js';

const SERVERLESS_DATA_FILE = '/tmp/swedish-price-watcher-store.json';
const PROJECT_DATA_FILE = path.resolve(process.cwd(), 'data/store.json');

let runtimePromise = null;

async function ensureServerlessDataFile() {
  try {
    await fs.access(SERVERLESS_DATA_FILE);
    return;
  } catch {}

  try {
    await fs.copyFile(PROJECT_DATA_FILE, SERVERLESS_DATA_FILE);
  } catch {
    // It's okay if seed file doesn't exist in deployment output.
  }
}

function createServerlessSchedulerAdapter({ state, configuredInterval, save }) {
  const existing = state.preferences?.scheduler ?? {};
  const parsedIntervalMinutes = Number.parseInt(String(existing.intervalMinutes ?? ''), 10);
  let enabled = existing.enabled === undefined ? false : Boolean(existing.enabled);
  let intervalMinutes = Number.isFinite(parsedIntervalMinutes) && parsedIntervalMinutes > 0 ? parsedIntervalMinutes : configuredInterval;
  let activeWindow = normalizeActiveWindow(existing.activeWindow);

  function getState() {
    return {
      enabled,
      intervalMinutes,
      nextRunAt: null,
      activeWindow: { ...activeWindow },
      isInActiveWindow: isWithinActiveWindow(activeWindow, new Date())
    };
  }

  return {
    getState,
    async update(next = {}) {
      if (next.enabled !== undefined) {
        enabled = Boolean(next.enabled);
      }

      if (next.intervalMinutes !== undefined) {
        const parsed = Number.parseInt(String(next.intervalMinutes), 10);

        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error('intervalMinutes must be a positive integer.');
        }

        intervalMinutes = parsed;
      }

      if (next.activeWindow !== undefined) {
        activeWindow = normalizeActiveWindow(next.activeWindow, activeWindow);
      }

      state.preferences = {
        ...(state.preferences ?? {}),
        scheduler: {
          enabled,
          intervalMinutes,
          activeWindow
        }
      };
      await save();
      return getState();
    }
  };
}

async function createRuntime() {
  const config = await loadConfig();
  config.dataFile = SERVERLESS_DATA_FILE;
  config.runOnStart = false;

  await ensureServerlessDataFile();

  const store = new JsonStore(config.dataFile);
  await store.load();
  reconcileStateWithSources(store.getState(), config.sources);
  const state = store.getState();
  const configuredInterval = Number.isFinite(config.scanIntervalMinutes) && config.scanIntervalMinutes > 0 ? config.scanIntervalMinutes : 60;
  const existingSchedulerPreference = state.preferences?.scheduler ?? {};
  const parsedSchedulerInterval = Number.parseInt(String(existingSchedulerPreference.intervalMinutes ?? ''), 10);
  const schedulerPreference = {
    enabled: existingSchedulerPreference.enabled === undefined ? false : Boolean(existingSchedulerPreference.enabled),
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

  const scheduler = createServerlessSchedulerAdapter({
    state,
    configuredInterval,
    save: () => store.save()
  });

  const app = await buildApp({
    config,
    store,
    scanState,
    triggerScan,
    scheduler,
    manualRunMode: 'blocking'
  });

  await app.ready();

  return { app };
}

function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = createRuntime();
  }

  return runtimePromise;
}

export default async function handler(req, res) {
  const runtime = await getRuntime();
  runtime.app.server.emit('request', req, res);
}
