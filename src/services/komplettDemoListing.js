/**
 * Mirrors the Komplett demo watcher's tracked products into the main listing.
 *
 * The watcher (services/komplettDemoPoller.js) owns fetching, cadence and
 * Discord alerts, and keeps its products in its own SQLite record. This module
 * turns that state into ordinary observations and merges them into
 * `state.items` exactly like the hotlist does, so Komplett demo units show up
 * in /api/outlet-products, search, filters, CSV export and price history.
 *
 * It never alerts: the watcher already decided (and seeded silently) what is
 * worth a Discord message. Products the watcher marks as gone (`missingSince`),
 * or whose category is no longer selected, drop out of the listing, the same
 * way a hotlist item that falls out of the hotlist does.
 */

import { buildListingKey, normalizeProductIdentity } from '../lib/utils.js';
import { mergeObservations } from './dealEngine.js';
import { getKomplettDemoCategory } from './komplettDemoConfig.js';

export const KOMPLETT_DEMO_SOURCE_ID = 'komplett-demo';
export const KOMPLETT_DEMO_SOURCE_LABEL = 'Komplett demo';
export const KOMPLETT_DEMO_CONDITION_LABEL = 'B-grade / demo';

/** Records that belong in the listing: selected category, still listed, priced. */
export function listableKomplettDemoRecords(watcherState, config) {
  const selected = new Set((config?.categories ?? []).map(String));
  return Object.values(watcherState?.products ?? {}).filter((record) =>
    record
    && record.id
    && record.title
    && record.url
    && selected.has(String(record.categoryId))
    && !record.missingSince
    && Number.isFinite(record.priceSek)
    && record.priceSek > 0
  );
}

/** One watcher record as a listing observation (the shape mergeObservations expects). */
export function komplettDemoRecordToObservation(record, source = {}) {
  const category = getKomplettDemoCategory(record.categoryId);
  return {
    sourceId: source.id ?? KOMPLETT_DEMO_SOURCE_ID,
    sourceLabel: source.label ?? KOMPLETT_DEMO_SOURCE_LABEL,
    sourceType: 'komplett-demo',
    externalId: String(record.id),
    productKey: normalizeProductIdentity(String(record.title).replace(/\b-?\s*b-?grade\b/gi, '')),
    title: record.title,
    url: record.url,
    category: category?.label ?? 'Komplett demo',
    categoryGroupId: category?.group ?? null,
    condition: 'outlet',
    conditionLabel: KOMPLETT_DEMO_CONDITION_LABEL,
    priceSek: record.priceSek,
    // Komplett's listing JSON carries no new-unit price, so there is no
    // reference price and no discount to show.
    marketValueSek: null,
    referencePriceSek: null,
    articleNumber: String(record.id),
    availability: record.inStock === false ? 'out_of_stock' : 'in_stock',
    imageUrl: record.imageUrl ?? null,
    notes: record.availabilityText ?? null,
    seenAt: record.lastSeenAt ?? record.firstSeenAt ?? new Date().toISOString()
  };
}

/**
 * Sync the listing with the watcher state. Mutates `state` (items and the
 * itemHistory archive) and returns the keys the caller must persist.
 *
 * `getItemHistory(listingKey)` supplies the persisted price history of an item
 * whose in-memory history is empty (SqliteStore loads history lazily), so a
 * removed product's history is archived rather than lost.
 *
 * @returns {{ listed: number, newCount: number, newKeys: string[], changedKeys: string[], deletedKeys: string[] }}
 */
export function syncKomplettDemoListing({ state, watcherState, config, source = {}, maxHistoryEntries = 20, getItemHistory = null }) {
  const sourceId = source.id ?? KOMPLETT_DEMO_SOURCE_ID;
  const records = listableKomplettDemoRecords(watcherState, config);
  const observations = records.map((record) => komplettDemoRecordToObservation(record, source));
  const { newItems } = mergeObservations(state, observations, maxHistoryEntries);

  // A newly mirrored product keeps the date the watcher first saw it, so a
  // backfill after deploy doesn't make every seeded product look brand new.
  const firstSeenById = new Map(records.map((record) => [String(record.id), record.firstSeenAt]));
  for (const item of newItems) {
    const firstSeenAt = firstSeenById.get(String(item.externalId));
    if (firstSeenAt && (!item.firstSeenAt || Date.parse(firstSeenAt) < Date.parse(item.firstSeenAt))) {
      item.firstSeenAt = firstSeenAt;
    }
  }

  const listedKeys = new Set(observations.map((o) => buildListingKey(o.sourceId, o.externalId)));
  const deletedKeys = [];
  for (const [key, item] of Object.entries(state.items)) {
    if (item.sourceId !== sourceId || listedKeys.has(key)) continue;
    const history = item.history?.length > 0 ? item.history : getItemHistory?.(key) ?? [];
    if (history.length > 0) {
      state.itemHistory = state.itemHistory ?? {};
      state.itemHistory[key] = {
        history,
        lowestPriceSek: item.lowestPriceSek,
        highestPriceSek: item.highestPriceSek,
        firstSeenAt: item.firstSeenAt,
        archivedAt: new Date().toISOString()
      };
    }
    // Cooldown keys of a removed product go too, like a pruned hotlist item.
    for (const notifKey of Object.keys(state.notifications ?? {})) {
      if (notifKey.startsWith(`${key}:`)) delete state.notifications[notifKey];
    }
    deletedKeys.push(key);
    delete state.items[key];
  }

  return {
    listed: observations.length,
    newCount: newItems.length,
    newKeys: newItems.map((item) => item.listingKey),
    changedKeys: [...listedKeys],
    deletedKeys
  };
}
