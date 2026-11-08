import { komplettThumbnailUrl } from '../sources/komplett.js';
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
import {
  getKomplettDemoCategory,
  isGroupActive,
  normalizeKomplettDemoConfig,
} from './komplettDemoConfig.js';
import { groupMatches } from './komplettDemoPoller.js';

export const KOMPLETT_DEMO_SOURCE_ID = 'komplett-demo';
export const KOMPLETT_DEMO_SOURCE_LABEL = 'Komplett demo';
export const KOMPLETT_DEMO_CONDITION_LABEL = 'B-grade / demo';

export const KOMPLETT_DEALS_SOURCE_ID = 'komplett-deals';
export const KOMPLETT_DEALS_SOURCE_LABEL = 'Komplett deals';
export const KOMPLETT_DEALS_CONDITION_LABEL = 'Kampanj';

export const KOMPLETT_LISTING_SOURCES = Object.freeze({
  deals: Object.freeze({
    id: KOMPLETT_DEALS_SOURCE_ID,
    label: KOMPLETT_DEALS_SOURCE_LABEL,
    condition: 'deal',
    conditionLabel: KOMPLETT_DEALS_CONDITION_LABEL,
  }),
  outlet: Object.freeze({
    id: KOMPLETT_DEMO_SOURCE_ID,
    label: KOMPLETT_DEMO_SOURCE_LABEL,
    condition: 'outlet',
    conditionLabel: KOMPLETT_DEMO_CONDITION_LABEL,
  }),
});

/** Records that belong in the listing: matching watch group/category, still listed, priced. */
export function listableKomplettDemoRecords(watcherState, config) {
  const normalized = normalizeKomplettDemoConfig(config);
  const activeGroups = (normalized.groups ?? []).filter(isGroupActive);
  const selected = new Set((normalized.categories ?? []).map(String));
  return Object.values(watcherState?.products ?? {}).filter((record) => {
    if (!record || !record.id || !record.title || !record.url || record.missingSince) return false;
    if (!Number.isFinite(record.priceSek) || record.priceSek <= 0) return false;
    const feed = record.feed === 'deals' ? 'deals' : 'outlet';
    if (normalized.feeds?.[feed] === false) return false;
    if (activeGroups.length > 0) {
      return activeGroups.some((g) => groupMatches(g, { ...record, feed }));
    }
    return selected.has(String(record.categoryId));
  });
}

/** One watcher record as a listing observation (the shape mergeObservations expects). */
export function komplettDemoRecordToObservation(record, source = {}) {
  const isDeal = record.feed === 'deals';
  const meta = isDeal ? KOMPLETT_LISTING_SOURCES.deals : KOMPLETT_LISTING_SOURCES.outlet;
  const category = getKomplettDemoCategory(record.categoryId);
  const description = typeof record.description === 'string' && record.description.trim() ? record.description.trim() : null;
  // Demo PCs share a few generic names ("Komplett-PC Epic Gaming B-Grade"), so the
  // specs go in the title: that's what tells them apart and makes "5090" searchable.
  const title = category?.group === 'datorer' && description
    ? `${record.title} (${description})`
    : record.title;
  const referencePriceSek = isDeal && Number.isFinite(record.listPriceSek) && record.listPriceSek > record.priceSek
    ? record.listPriceSek
    : null;
  return {
    sourceId: source.id ?? meta.id,
    sourceLabel: source.label ?? meta.label,
    sourceType: isDeal ? 'komplett-deals' : 'komplett-demo',
    externalId: String(record.id),
    // One card per demo unit: demo items are individual units, and grouping by
    // name merged different PCs (17 configs under one "Epic Gaming" card).
    productKey: isDeal
      ? (normalizeProductIdentity(title) || `komplett-deal-${record.id}`)
      : `komplett-demo-${record.id}`,
    title,
    description,
    url: record.url,
    category: category?.label ?? (isDeal ? 'Komplett deals' : 'Komplett demo'),
    categoryGroupId: category?.group ?? null,
    condition: meta.condition,
    conditionLabel: meta.conditionLabel,
    priceSek: record.priceSek,
    marketValueSek: null,
    referencePriceSek,
    articleNumber: String(record.id),
    availability: record.inStock === false ? 'out_of_stock' : 'in_stock',
    // Thumbnail from the id, so records saved with the full-size URL get it too.
    imageUrl: komplettThumbnailUrl(record.id) ?? record.imageUrl ?? null,
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
  const outletSource = source.id ? source : KOMPLETT_LISTING_SOURCES.outlet;
  const managedSourceIds = new Set([outletSource.id, KOMPLETT_DEALS_SOURCE_ID]);
  const records = listableKomplettDemoRecords(watcherState, config);
  const observations = records.map((record) => komplettDemoRecordToObservation(
    record,
    record.feed === 'deals' ? KOMPLETT_LISTING_SOURCES.deals : outletSource,
  ));
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
    if (!managedSourceIds.has(item.sourceId) || listedKeys.has(key)) continue;
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
