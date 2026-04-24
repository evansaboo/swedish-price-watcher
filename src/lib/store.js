import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeActiveWindow } from '../scheduler.js';

const FALLBACK_WRITABLE_DATA_FILE = '/tmp/swedish-price-watcher-store.json';
const APIFY_API_BASE_URL = 'https://api.apify.com/v2';

export function createDefaultState() {
  return {
    items: {},
    deals: [],
    notifications: {},
    sourceStates: {},
    itemHistory: {},
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
  state.itemHistory = (rawState.itemHistory && typeof rawState.itemHistory === 'object') ? rawState.itemHistory : {};
  state.preferences = {
    ...state.preferences,
    ...(rawState.preferences ?? {})
  };
  state.preferences.favoriteCategories = Array.isArray(state.preferences.favoriteCategories)
    ? state.preferences.favoriteCategories.map((category) => String(category).trim()).filter(Boolean)
    : [];
  // sourceOverrides: { [sourceId]: { enabled: boolean } }
  const rawOverrides = rawState.preferences?.sourceOverrides;
  state.preferences.sourceOverrides = (rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides))
    ? rawOverrides
    : {};
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

/** Return a copy of state safe for serialization — excludes computed deals. */
function stateForSerialization(state) {
  // deals are recomputed from items at startup and after each scan,
  // so there is no need to persist them. Omitting them roughly halves
  // the state JSON size and reduces peak memory during saves.
  return { ...state, deals: [] };
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = createDefaultState();
  }

  async ensureWritableFilePath() {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    } catch (error) {
      if (['EROFS', 'EACCES', 'ENOENT'].includes(error?.code) && this.filePath !== FALLBACK_WRITABLE_DATA_FILE) {
        this.filePath = FALLBACK_WRITABLE_DATA_FILE;
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        return;
      }

      throw error;
    }
  }

  async load() {
    await this.ensureWritableFilePath();

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
    await this.ensureWritableFilePath();
    await fs.writeFile(this.filePath, `${JSON.stringify(stateForSerialization(this.state))}\n`, 'utf8');
  }
}

export class ApifyStore {
  constructor({ token, storeName = 'swedish-price-watcher-state', recordKey = 'state' }) {
    this.token = String(token ?? '').trim();
    this.storeName = String(storeName ?? '').trim() || 'swedish-price-watcher-state';
    this.recordKey = String(recordKey ?? '').trim() || 'state';
    this.storeId = null;
    this.state = createDefaultState();
  }

  async ensureStoreId() {
    if (this.storeId) {
      return this.storeId;
    }

    const response = await fetch(
      `${APIFY_API_BASE_URL}/key-value-stores?token=${encodeURIComponent(this.token)}&name=${encodeURIComponent(this.storeName)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: '{}'
      }
    );

    if (!response.ok) {
      throw new Error(`Unable to initialize Apify store: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const storeId = payload?.data?.id;

    if (!storeId) {
      throw new Error('Unable to initialize Apify store: missing store id.');
    }

    this.storeId = storeId;
    return this.storeId;
  }

  async load() {
    const storeId = await this.ensureStoreId();
    const response = await fetch(
      `${APIFY_API_BASE_URL}/key-value-stores/${encodeURIComponent(storeId)}/records/${encodeURIComponent(this.recordKey)}?token=${encodeURIComponent(this.token)}&disableRedirect=true`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json'
        }
      }
    );

    if (response.status === 404) {
      this.state = createDefaultState();
      await this.save();
      return this.state;
    }

    if (!response.ok) {
      throw new Error(`Unable to load Apify state: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    this.state = normalizeState(payload ?? {});
    return this.state;
  }

  getState() {
    return this.state;
  }

  async save() {
    const storeId = await this.ensureStoreId();
    const response = await fetch(
      `${APIFY_API_BASE_URL}/key-value-stores/${encodeURIComponent(storeId)}/records/${encodeURIComponent(this.recordKey)}?token=${encodeURIComponent(this.token)}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(stateForSerialization(this.state))
      }
    );

    if (!response.ok) {
      throw new Error(`Unable to save Apify state: ${response.status} ${response.statusText}`);
    }
  }
}
