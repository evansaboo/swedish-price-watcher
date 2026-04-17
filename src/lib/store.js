import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeActiveWindow } from '../scheduler.js';

export function createDefaultState() {
  return {
    items: {},
    deals: [],
    notifications: {},
    sourceStates: {},
    preferences: {
      favoriteCategories: []
    },
    stats: {
      lastRunStartedAt: null,
      lastRunCompletedAt: null,
      lastRunSummary: null
    }
  };
}

function normalizeState(rawState = {}) {
  const state = createDefaultState();

  state.items = rawState.items ?? {};
  state.deals = Array.isArray(rawState.deals) ? rawState.deals : [];
  state.notifications = rawState.notifications ?? {};
  state.sourceStates = rawState.sourceStates ?? {};
  state.preferences = {
    ...state.preferences,
    ...(rawState.preferences ?? {})
  };
  state.preferences.favoriteCategories = Array.isArray(state.preferences.favoriteCategories)
    ? state.preferences.favoriteCategories.map((category) => String(category).trim()).filter(Boolean)
    : [];
  if (Object.prototype.hasOwnProperty.call(rawState.preferences ?? {}, 'scheduler')) {
    const schedulerEnabled = state.preferences.scheduler?.enabled;
    const schedulerIntervalMinutes = Number.parseInt(String(state.preferences.scheduler?.intervalMinutes ?? ''), 10);
    state.preferences.scheduler = {
      enabled: schedulerEnabled === undefined ? true : Boolean(schedulerEnabled),
      intervalMinutes: Number.isFinite(schedulerIntervalMinutes) && schedulerIntervalMinutes > 0 ? schedulerIntervalMinutes : 180,
      activeWindow: normalizeActiveWindow(state.preferences.scheduler?.activeWindow)
    };
  } else {
    delete state.preferences.scheduler;
  }
  state.stats = {
    ...state.stats,
    ...(rawState.stats ?? {})
  };

  for (const item of Object.values(state.items)) {
    item.history = Array.isArray(item.history) ? item.history : [];
  }

  return state;
}

export function reconcileStateWithSources(state, sources) {
  const allowedSourceIds = new Set(sources.map((source) => source.id));

  for (const [listingKey, item] of Object.entries(state.items)) {
    if (!allowedSourceIds.has(item.sourceId)) {
      delete state.items[listingKey];
    }
  }

  state.deals = state.deals.filter((deal) => state.items[deal.listingKey]);

  for (const sourceId of Object.keys(state.sourceStates)) {
    if (!allowedSourceIds.has(sourceId)) {
      delete state.sourceStates[sourceId];
    }
  }

  for (const notificationKey of Object.keys(state.notifications)) {
    const sourceId = notificationKey.split(':', 1)[0];

    if (!allowedSourceIds.has(sourceId)) {
      delete state.notifications[notificationKey];
    }
  }

  const lastRunSummary = state.stats?.lastRunSummary;

  if (lastRunSummary?.sourceResults?.length) {
    const hasUnknownSources = lastRunSummary.sourceResults.some((result) => !allowedSourceIds.has(result.sourceId));

    if (hasUnknownSources) {
      state.stats.lastRunStartedAt = null;
      state.stats.lastRunCompletedAt = null;
      state.stats.lastRunSummary = null;
    }
  }

  return state;
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = createDefaultState();
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const file = await fs.readFile(this.filePath, 'utf8');
      this.state = normalizeState(JSON.parse(file));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      this.state = createDefaultState();
      await this.save();
    }

    return this.state;
  }

  getState() {
    return this.state;
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }
}
