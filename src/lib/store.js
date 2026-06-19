import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeActiveWindow } from '../scheduler.js';

let BetterSqlite3;
try {
  BetterSqlite3 = (await import('better-sqlite3')).default;
} catch {
  // better-sqlite3 not available — SqliteStore will throw on instantiation
}

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
      favoriteCategories: [],
      wishlist: []
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
  const rawOverrides = rawState.preferences?.sourceOverrides;
  state.preferences.sourceOverrides = (rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides))
    ? rawOverrides
    : {};
  state.preferences.wishlist = Array.isArray(state.preferences.wishlist)
    ? state.preferences.wishlist.filter(k => typeof k === 'string' && k)
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

/** Return a copy of state safe for serialization — excludes computed deals. */
function stateForSerialization(state) {
  return { ...state, deals: [] };
}

/** Extract only the preferences sub-object for fast partial saves. */
function preferencesForSerialization(state) {
  return state.preferences ?? {};
}

/**
 * Atomic file write: write to temp file then rename. Prevents corruption on crash.
 */
async function atomicWriteFile(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, data, 'utf8');
  await fs.rename(tmpPath, filePath);
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.preferencesFilePath = filePath.replace(/(\.[^.]+)?$/, '.preferences$1');
    this.state = createDefaultState();
    this._saveTimer = null;
    this._savePromise = null;
    this._onInvalidate = null; // Callback for cache invalidation
  }

  /** Register a callback to be called after any save completes (for cache rebuild). */
  onInvalidate(fn) {
    this._onInvalidate = fn;
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

    // Overlay fast-path preferences file if it exists
    try {
      const prefFile = await fs.readFile(this.preferencesFilePath, 'utf8');
      const savedPrefs = JSON.parse(prefFile);
      if (savedPrefs && typeof savedPrefs === 'object') {
        this.state.preferences = normalizeState({ preferences: savedPrefs }).preferences;
      }
    } catch {
      // Preferences file doesn't exist yet
    }

    return this.state;
  }

  getState() {
    return this.state;
  }

  /** Full state save with atomic write. */
  async save() {
    await this.ensureWritableFilePath();
    const json = JSON.stringify(stateForSerialization(this.state));
    await atomicWriteFile(this.filePath, json + '\n');
    this._onInvalidate?.();
  }

  /**
   * Incremental flush — writes only the specified items to disk.
   * No-op on JsonStore (full save happens at end of scan).
   */
  flushItems() { /* no-op for JsonStore */ }

  /** History is in-memory for JsonStore — just read from item.history. */
  getItemHistory(listingKey) {
    const state = this.getState();
    const item = state.items?.[listingKey];
    return Array.isArray(item?.history) ? item.history : [];
  }

  /** Fast save: only writes the small preferences object (~1 KB). */
  async savePreferences() {
    await this.ensureWritableFilePath();
    const json = JSON.stringify(preferencesForSerialization(this.state));
    await atomicWriteFile(this.preferencesFilePath, json + '\n');
    this._onInvalidate?.();
  }

  /**
   * Debounced save — coalesces multiple rapid mutations into a single write.
   * Returns a promise that resolves when the save completes.
   */
  debouncedSave(delayMs = 500) {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._savePromise = new Promise((resolve, reject) => {
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        this.save().then(resolve).catch(reject);
      }, delayMs);
    });
    return this._savePromise;
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
        body: '{}',
        signal: AbortSignal.timeout(30_000)
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
        },
        signal: AbortSignal.timeout(60_000)
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

    // Overlay fast-path preferences record if it exists.
    try {
      const prefResponse = await fetch(
        `${APIFY_API_BASE_URL}/key-value-stores/${encodeURIComponent(storeId)}/records/${encodeURIComponent(this.recordKey + '-preferences')}?token=${encodeURIComponent(this.token)}&disableRedirect=true`,
        { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }
      );
      if (prefResponse.ok) {
        const savedPrefs = await prefResponse.json();
        if (savedPrefs && typeof savedPrefs === 'object') {
          this.state.preferences = normalizeState({ preferences: savedPrefs }).preferences;
        }
      }
    } catch {
      // Preferences record missing — use preferences from main state.
    }

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
        body: JSON.stringify(stateForSerialization(this.state)),
        signal: AbortSignal.timeout(90_000)
      }
    );

    if (!response.ok) {
      throw new Error(`Unable to save Apify state: ${response.status} ${response.statusText}`);
    }
  }

  /** Fast save: only writes the small preferences record (~1 KB) to Apify KV. */
  async savePreferences() {
    const storeId = await this.ensureStoreId();
    const response = await fetch(
      `${APIFY_API_BASE_URL}/key-value-stores/${encodeURIComponent(storeId)}/records/${encodeURIComponent(this.recordKey + '-preferences')}?token=${encodeURIComponent(this.token)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(preferencesForSerialization(this.state)),
        signal: AbortSignal.timeout(30_000)
      }
    );

    if (!response.ok) {
      throw new Error(`Unable to save Apify preferences: ${response.status} ${response.statusText}`);
    }
  }

  /** No-op: ApifyStore uses full saves only. */
  flushItems() {}

  /** History is in-memory for ApifyStore — just read from item.history. */
  getItemHistory(listingKey) {
    const state = this.getState();
    const item = state.items?.[listingKey];
    return Array.isArray(item?.history) ? item.history : [];
  }
}

// ═══════════════════════════════════════════════════════════════
// SqliteStore — SQLite-backed persistent store
//
// Schema:
//   items          — one row per tracked product (data as JSON blob, history separate)
//   price_history  — one row per price observation per item (indexed, append-only)
//   source_states  — one row per scraper source
//   notifications  — cooldown log (notification_key → sent_at)
//   item_archive   — items that left scrapers (kept for history)
//   scan_stats     — latest run stats + summary
//
// Preferences are still kept in a small sidecar JSON file for fast atomic saves.
// ═══════════════════════════════════════════════════════════════

const DDL = `
  CREATE TABLE IF NOT EXISTS items (
    listing_key  TEXT PRIMARY KEY,
    source_id    TEXT NOT NULL,
    data_json    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_id);

  CREATE TABLE IF NOT EXISTS price_history (
    listing_key TEXT NOT NULL,
    price_sek   REAL NOT NULL,
    seen_at     TEXT NOT NULL,
    PRIMARY KEY (listing_key, seen_at),
    FOREIGN KEY (listing_key) REFERENCES items(listing_key) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS source_states (
    source_id  TEXT PRIMARY KEY,
    state_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    notification_key TEXT PRIMARY KEY,
    sent_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS item_archive (
    listing_key TEXT PRIMARY KEY,
    data_json   TEXT NOT NULL,
    archived_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scan_stats (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
`;

export class SqliteStore {
  constructor(dbPath) {
    if (!BetterSqlite3) throw new Error('better-sqlite3 is not installed. Run: npm install better-sqlite3');
    this.dbPath = dbPath;
    this.preferencesFilePath = dbPath.replace(/(\.[^.]+)?$/, '.preferences.json');
    this.state = createDefaultState();
    this._db = null;
    this._saveTimer = null;
    this._savePromise = null;
    this._onInvalidate = null;
    // Prepared statements — initialised in #open()
    this._stmts = null;
  }

  onInvalidate(fn) { this._onInvalidate = fn; }

  #open() {
    if (this._db) return;
    this._db = new BetterSqlite3(this.dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('synchronous = NORMAL');
    this._db.pragma('foreign_keys = ON');
    this._db.pragma('cache_size = -32000'); // 32 MB page cache
    this._db.exec(DDL);
    this._stmts = {
      upsertItem:      this._db.prepare('INSERT OR REPLACE INTO items (listing_key, source_id, data_json) VALUES (?, ?, ?)'),
      deleteItem:      this._db.prepare('DELETE FROM items WHERE listing_key = ?'),
      allItemKeys:     this._db.prepare('SELECT listing_key FROM items'),
      allItems:        this._db.prepare('SELECT listing_key, data_json FROM items'),
      insertHistory:   this._db.prepare('INSERT OR IGNORE INTO price_history (listing_key, price_sek, seen_at) VALUES (?, ?, ?)'),
      historyForItem:  this._db.prepare('SELECT price_sek, seen_at FROM price_history WHERE listing_key = ? ORDER BY seen_at'),
      upsertSource:    this._db.prepare('INSERT OR REPLACE INTO source_states (source_id, state_json) VALUES (?, ?)'),
      allSources:      this._db.prepare('SELECT source_id, state_json FROM source_states'),
      upsertNotif:     this._db.prepare('INSERT OR REPLACE INTO notifications (notification_key, sent_at) VALUES (?, ?)'),
      deleteNotif:     this._db.prepare('DELETE FROM notifications WHERE notification_key = ?'),
      allNotifs:       this._db.prepare('SELECT notification_key, sent_at FROM notifications'),
      upsertArchive:   this._db.prepare('INSERT OR REPLACE INTO item_archive (listing_key, data_json, archived_at) VALUES (?, ?, ?)'),
      allArchive:      this._db.prepare('SELECT listing_key, data_json FROM item_archive'),
      upsertStats:     this._db.prepare('INSERT OR REPLACE INTO scan_stats (key, value_json) VALUES (?, ?)'),
      getStats:        this._db.prepare('SELECT value_json FROM scan_stats WHERE key = ?'),
    };
  }

  async load() {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    this.#open();

    // ── Items ──────────────────────────────────────────────────────
    const items = {};
    for (const row of this._stmts.allItems.all()) {
      try {
        const item = JSON.parse(row.data_json);
        item.history = []; // history loaded lazily from DB on first access
        items[row.listing_key] = item;
      } catch { /* skip corrupted rows */ }
    }

    // NOTE: price_history is NOT loaded here — doing so for 100K+ rows blocks the
    // event loop for 30-60s on low-end hardware (Raspberry Pi). Instead:
    //   • history is rebuilt incrementally during scans via mergeObservations()
    //   • the /api/price-history endpoint queries DB on-demand via getItemHistory()
    //   • archiving reads DB on-demand via getItemHistory() for items with no in-memory history

    // ── Source states ──────────────────────────────────────────────
    const sourceStates = {};
    for (const row of this._stmts.allSources.all()) {
      try { sourceStates[row.source_id] = JSON.parse(row.state_json); } catch { /* */ }
    }

    // ── Notifications ──────────────────────────────────────────────
    const notifications = {};
    for (const row of this._stmts.allNotifs.all()) {
      notifications[row.notification_key] = row.sent_at;
    }

    // ── Item archive ───────────────────────────────────────────────
    const itemHistory = {};
    for (const row of this._stmts.allArchive.all()) {
      try { itemHistory[row.listing_key] = JSON.parse(row.data_json); } catch { /* */ }
    }

    // ── Scan stats ─────────────────────────────────────────────────
    const statsRow = this._stmts.getStats.get('stats');
    const stats = statsRow
      ? JSON.parse(statsRow.value_json)
      : { lastRunStartedAt: null, lastRunCompletedAt: null, lastRunSummary: null };

    this.state = normalizeState({ items, sourceStates, notifications, itemHistory, stats });
    this.state.sourceStates = sourceStates; // normalizeState resets this
    this.state.notifications = notifications;
    this.state.itemHistory = itemHistory;
    this.state.stats = { ...createDefaultState().stats, ...stats };

    // ── Overlay preferences sidecar ────────────────────────────────
    try {
      const prefFile = await fs.readFile(this.preferencesFilePath, 'utf8');
      const savedPrefs = JSON.parse(prefFile);
      if (savedPrefs && typeof savedPrefs === 'object') {
        this.state.preferences = normalizeState({ preferences: savedPrefs }).preferences;
      }
    } catch { /* preferences file doesn't exist yet */ }

    return this.state;
  }

  getState() { return this.state; }

  /** Query price history for a single item directly from SQLite (synchronous). */
  getItemHistory(listingKey) {
    this.#open();
    const rows = this._stmts.historyForItem.all(listingKey);
    return rows.map(r => ({ priceSek: r.price_sek, seenAt: r.seen_at }));
  }

  /**
   * Full state persistence — runs in a single SQLite transaction.
   *
   * Pass `{ skipItems: true }` during and after scans — items are already
   * written incrementally via flushItems() and don't need to be re-synced.
   * This makes the end-of-scan save lightweight (metadata only).
   */
  async save({ skipItems = false } = {}) {
    this.#open();
    const { items, sourceStates, notifications, itemHistory, stats } = this.state;
    const stmts = this._stmts;

    this._db.transaction(() => {
      if (!skipItems) {
        // ── Items: full sync (startup / migration / periodic) ──────
        const dbKeys = new Set(stmts.allItemKeys.all().map(r => r.listing_key));
        const stateKeys = new Set(Object.keys(items));

        for (const [key, item] of Object.entries(items)) {
          const { history = [], ...data } = item;
          stmts.upsertItem.run(key, item.sourceId, JSON.stringify(data));
          for (const h of history) {
            if (h.priceSek != null && h.seenAt) stmts.insertHistory.run(key, h.priceSek, h.seenAt);
          }
        }
        for (const key of dbKeys) {
          if (!stateKeys.has(key)) stmts.deleteItem.run(key); // cascades to price_history
        }
      }

      // ── Source states ────────────────────────────────────────────
      for (const [id, s] of Object.entries(sourceStates)) {
        stmts.upsertSource.run(id, JSON.stringify(s));
      }

      // ── Notifications: sync additions and removals ───────────────
      const dbNotifKeys = new Set(stmts.allNotifs.all().map(r => r.notification_key));
      for (const [key, sentAt] of Object.entries(notifications)) {
        stmts.upsertNotif.run(key, sentAt);
      }
      for (const key of dbNotifKeys) {
        if (!(key in notifications)) stmts.deleteNotif.run(key);
      }

      // ── Item archive ─────────────────────────────────────────────
      for (const [key, hist] of Object.entries(itemHistory)) {
        stmts.upsertArchive.run(key, JSON.stringify(hist), hist.archivedAt ?? new Date().toISOString());
      }

      // ── Scan stats ───────────────────────────────────────────────
      stmts.upsertStats.run('stats', JSON.stringify(stats));
    })();

    this._onInvalidate?.();
  }

  /**
   * Incremental item flush — called after each source completes during a scan.
   * Only writes items that actually changed (O(scan_results) vs O(all_items)).
   *
   * - changedKeys: listing keys of all items returned by this source's scan
   * - deletedKeys: listing keys of items pruned from state this scan
   *
   * Only the last history entry is inserted per item; all prior entries were
   * already persisted in previous flushes (INSERT OR IGNORE is idempotent).
   */
  flushItems(changedKeys, deletedKeys) {
    if ((!changedKeys?.length && !deletedKeys?.length) || !BetterSqlite3) return;
    this.#open();
    const { items } = this.state;
    const stmts = this._stmts;

    this._db.transaction(() => {
      for (const key of changedKeys) {
        const item = items[key];
        if (!item) continue;
        const { history = [], ...data } = item;
        stmts.upsertItem.run(key, item.sourceId, JSON.stringify(data));
        // Only persist the most-recent history entry — previous entries are
        // already in the DB from earlier flushes. INSERT OR IGNORE is safe
        // if this entry was already written (e.g. price unchanged this scan).
        const last = history.at(-1);
        if (last?.priceSek != null && last?.seenAt) {
          stmts.insertHistory.run(key, last.priceSek, last.seenAt);
        }
      }
      for (const key of deletedKeys) {
        stmts.deleteItem.run(key); // cascades to price_history
      }
    })();
  }

  /** Fast save: only writes the small preferences sidecar (~1 KB). */
  async savePreferences() {
    await atomicWriteFile(this.preferencesFilePath, JSON.stringify(this.state.preferences ?? {}) + '\n');
    this._onInvalidate?.();
  }

  debouncedSave(delayMs = 500) {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._savePromise = new Promise((resolve, reject) => {
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        this.save().then(resolve).catch(reject);
      }, delayMs);
    });
    return this._savePromise;
  }
}

// ═══════════════════════════════════════════════════════════════
// migrateJsonToSqlite — one-time migration from JsonStore → SqliteStore
// ═══════════════════════════════════════════════════════════════

/**
 * Reads an existing store.json and writes all data into a new store.db.
 * The JSON file is renamed to store.json.migrated on success (kept as backup).
 * No-ops if the db file already exists.
 */
export async function migrateJsonToSqlite(jsonPath, dbPath) {
  // Already migrated or db exists
  try { await fs.access(dbPath); return false; } catch { /* db doesn't exist yet — proceed */ }

  let raw;
  try { raw = await fs.readFile(jsonPath, 'utf8'); } catch { return false; } // no json to migrate

  console.log('[sqlite] Migrating store.json → store.db …');
  const t0 = Date.now();
  const rawState = JSON.parse(raw);
  const store = new SqliteStore(dbPath);
  store.state = normalizeState(rawState);
  store.state.sourceStates = rawState.sourceStates ?? {};
  store.state.notifications = rawState.notifications ?? {};
  store.state.itemHistory = rawState.itemHistory ?? {};
  store.state.stats = { ...createDefaultState().stats, ...(rawState.stats ?? {}) };

  await store.save();

  // Preserve preferences sidecar path if the JSON store had one
  const jsonPrefPath = jsonPath.replace(/(\.[^.]+)?$/, '.preferences.json');
  if (store.preferencesFilePath !== jsonPrefPath) {
    try {
      const prefData = await fs.readFile(jsonPrefPath, 'utf8');
      await atomicWriteFile(store.preferencesFilePath, prefData);
    } catch { /* no sidecar — fine */ }
  }

  await fs.rename(jsonPath, jsonPath + '.migrated');
  console.log(`[sqlite] Migration complete in ${Date.now() - t0}ms — ${Object.keys(rawState.items ?? {}).length} items transferred.`);
  return true;
}
