/**
 * Mirrors the Webhallen watcher's tracked items into the main listing, the way
 * inetListing.js and komplettDemoListing.js do for Inet and Komplett.
 *
 * Every item of the enabled feeds is listed (not only watch-group matches),
 * making Webhallen's Kampanjer and Fyndvaror searchable and filterable next to
 * the other stores.
 *
 * It never alerts; the watcher already decided (and seeded silently) what is
 * worth a Discord message. Items the watcher marks as gone, or whose feed is
 * switched off, drop out of the listing.
 */

import { buildListingKey } from '../lib/utils.js';
import { mergeObservations } from './dealEngine.js';
import { enabledFeedIds } from './webhallenConfig.js';

export const WEBHALLEN_DEALS_SOURCE_ID = 'webhallen-deals';
export const WEBHALLEN_DEALS_SOURCE_LABEL = 'Webhallen deals';
export const WEBHALLEN_OUTLET_SOURCE_ID = 'webhallen-outlet';
export const WEBHALLEN_OUTLET_SOURCE_LABEL = 'Webhallen outlet';
export const WEBHALLEN_DEALS_CONDITION_LABEL = 'Kampanj';
export const WEBHALLEN_OUTLET_CONDITION_LABEL = 'Fyndvara';

export const WEBHALLEN_LISTING_SOURCES = Object.freeze({
  deals: Object.freeze({
    id: WEBHALLEN_DEALS_SOURCE_ID,
    label: WEBHALLEN_DEALS_SOURCE_LABEL,
    type: 'webhallen-deals',
  }),
  outlet: Object.freeze({
    id: WEBHALLEN_OUTLET_SOURCE_ID,
    label: WEBHALLEN_OUTLET_SOURCE_LABEL,
    type: 'webhallen-outlet',
  }),
});

const CONDITION_BUCKETS = [
  [/klass\s*1|nyskick/i, 'Fyndvara klass 1'],
  [/klass\s*2|gott\s+skick/i, 'Fyndvara klass 2'],
  [/klass\s*3|anv[äa]nt\s+skick/i, 'Fyndvara klass 3'],
];

export function webhallenConditionLabel(sellingPoint) {
  const text = String(sellingPoint ?? '').trim();
  if (!text) return WEBHALLEN_OUTLET_CONDITION_LABEL;
  const bucket = CONDITION_BUCKETS.find(([pattern]) => pattern.test(text));
  return bucket ? bucket[1] : WEBHALLEN_OUTLET_CONDITION_LABEL;
}

/** Records that belong in the listing: enabled feed, still listed, priced. */
export function listableWebhallenRecords(watcherState, config) {
  const feeds = new Set(enabledFeedIds(config));
  return Object.values(watcherState?.products ?? {}).filter((record) =>
    record
    && record.id
    && record.title
    && record.url
    && feeds.has(record.feed)
    && !record.missingSince
    && Number.isFinite(record.priceSek)
    && record.priceSek > 0
  );
}

function availabilityOf(record) {
  if (record.inWebStock) return Number.isFinite(record.webQty) && record.webQty <= 2 ? 'few_left' : 'in_stock';
  if (record.storeQty > 0) return 'few_left';
  return 'out_of_stock';
}

function stockNote(record) {
  const parts = [];
  if (Number.isFinite(record.webQty)) parts.push(`Webblager: ${record.webQty}`);
  if (record.storeQty > 0) parts.push(`I butik: ${record.storeQty}`);
  return parts.join(' · ') || null;
}

/** One watcher record as a listing observation (the shape mergeObservations expects). */
export function webhallenRecordToObservation(record, { catalog = {}, sources = WEBHALLEN_LISTING_SOURCES } = {}) {
  const isOutlet = record.feed === 'outlet';
  const source = sources[record.feed] ?? WEBHALLEN_LISTING_SOURCES[record.feed];
  const categoryName = record.categoryName ?? catalog?.[String(record.categoryId ?? '')]?.name ?? null;
  const sellingPoint = typeof record.sellingPoint === 'string' && record.sellingPoint.trim()
    ? record.sellingPoint.trim()
    : null;
  return {
    sourceId: source.id,
    sourceLabel: source.label,
    sourceType: source.type ?? WEBHALLEN_LISTING_SOURCES[record.feed].type,
    externalId: String(record.id),
    productKey: `webhallen-${record.id}`,
    title: record.title,
    description: sellingPoint,
    url: record.url,
    category: categoryName && categoryName !== 'Default' ? categoryName : 'Webhallen',
    categoryGroupId: record.categoryId ? `webhallen-cat-${record.categoryId}` : null,
    condition: isOutlet ? 'outlet' : 'deal',
    conditionLabel: isOutlet ? webhallenConditionLabel(sellingPoint) : WEBHALLEN_DEALS_CONDITION_LABEL,
    priceSek: record.priceSek,
    marketValueSek: null,
    referencePriceSek: Number.isFinite(record.listPriceSek) && record.listPriceSek > record.priceSek
      ? record.listPriceSek
      : null,
    articleNumber: String(record.fyndwareParentId ?? record.id),
    availability: availabilityOf(record),
    imageUrl: record.imageUrl ?? null,
    notes: stockNote(record),
    seenAt: record.lastSeenAt ?? record.firstSeenAt ?? new Date().toISOString(),
  };
}

/**
 * Sync the listing with the watcher state. Mutates `state` (items and the
 * itemHistory archive) and returns the keys the caller must persist.
 *
 * @returns {{ listed: number, newCount: number, newKeys: string[], changedKeys: string[], deletedKeys: string[] }}
 */
export function syncWebhallenListing({
  state,
  watcherState,
  config,
  sources = WEBHALLEN_LISTING_SOURCES,
  maxHistoryEntries = 20,
  getItemHistory = null,
}) {
  const sourceIds = new Set(Object.values(sources).map((source) => source.id));
  const catalog = watcherState?.catalog ?? {};
  const records = listableWebhallenRecords(watcherState, config);
  const observations = records.map((record) => webhallenRecordToObservation(record, { catalog, sources }));
  const { newItems } = mergeObservations(state, observations, maxHistoryEntries);

  // A newly mirrored item keeps the date the watcher first saw it, so a
  // backfill after deploy doesn't make every seeded item look brand new.
  const firstSeenByKey = new Map(records.map((record, index) => [
    buildListingKey(observations[index].sourceId, observations[index].externalId),
    record.firstSeenAt,
  ]));
  for (const item of newItems) {
    const firstSeenAt = firstSeenByKey.get(item.listingKey);
    if (firstSeenAt && (!item.firstSeenAt || Date.parse(firstSeenAt) < Date.parse(item.firstSeenAt))) {
      item.firstSeenAt = firstSeenAt;
    }
  }

  const listedKeys = new Set(observations.map((o) => buildListingKey(o.sourceId, o.externalId)));
  const deletedKeys = [];
  for (const [key, item] of Object.entries(state.items)) {
    if (!sourceIds.has(item.sourceId) || listedKeys.has(key)) continue;
    const history = item.history?.length > 0 ? item.history : getItemHistory?.(key) ?? [];
    if (history.length > 0) {
      state.itemHistory = state.itemHistory ?? {};
      state.itemHistory[key] = {
        history,
        lowestPriceSek: item.lowestPriceSek,
        highestPriceSek: item.highestPriceSek,
        firstSeenAt: item.firstSeenAt,
        archivedAt: new Date().toISOString(),
      };
    }
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
    deletedKeys,
  };
}
