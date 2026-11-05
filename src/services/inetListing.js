/**
 * Mirrors the Inet watcher's tracked items into the main listing, the way
 * komplettDemoListing.js does for Komplett demo products.
 *
 * Every item of the enabled feeds is listed (not only watch-group matches):
 * about 650 rows (≈270 campaign deals + ≈390 outlet units on 2026-11-05),
 * which the product cache and SQLite handle easily, and it makes the whole of
 * Inet's campaign and Fyndhörnan range searchable next to the other stores.
 *
 * It never alerts; the watcher already decided (and seeded silently) what is
 * worth a Discord message. Items the watcher marks as gone, or whose feed is
 * switched off, drop out of the listing.
 */

import { buildListingKey } from '../lib/utils.js';
import { mergeObservations } from './dealEngine.js';
import { enabledFeedIds } from './inetConfig.js';

export const INET_DEALS_SOURCE_ID = 'inet-deals';
export const INET_DEALS_SOURCE_LABEL = 'Inet deals';
export const INET_OUTLET_SOURCE_ID = 'inet-outlet';
export const INET_OUTLET_SOURCE_LABEL = 'Inet outlet';
export const INET_DEALS_CONDITION_LABEL = 'Kampanj';
export const INET_OUTLET_CONDITION_LABEL = 'Fyndhörnan';

export const INET_LISTING_SOURCES = Object.freeze({
  deals: Object.freeze({ id: INET_DEALS_SOURCE_ID, label: INET_DEALS_SOURCE_LABEL, type: 'inet-deals' }),
  outlet: Object.freeze({ id: INET_OUTLET_SOURCE_ID, label: INET_OUTLET_SOURCE_LABEL, type: 'inet-outlet' }),
});

/**
 * Short condition for the listing's condition filter. Inet's condition is
 * free text with many spellings ("Ej original förpackning", "EJ
 * originalförpackning", "Ej i originalkartong"… 18 variants on 2026-11-05),
 * so it is bucketed; the full text stays in the item's description and the
 * Discord alert. Ordered by what matters most to a buyer.
 */
const CONDITION_BUCKETS = [
  [/demo/i, 'Demoexemplar'],
  [/ersättningsprodukt/i, 'Ersättningsprodukt'],
  [/spår av användning|repor|repa|skavmärk|kosmetisk|begagnad/i, 'Spår av användning'],
  [/skadad förpackning|skadad kartong/i, 'Skadad förpackning'],
  [/(saknar|ej|utan|inte)\b.*(förpackning|kartong)|förpackning av annan|annan förpackning/i, 'Ej originalförpackning'],
  [/saknar .*tillbehör|enbart|endast|ofullständig/i, 'Saknar tillbehör'],
  [/oöppnad/i, 'Oöppnad förpackning'],
  [/öppnad/i, 'Öppnad förpackning'],
];

export function inetConditionLabel(sellingPoint) {
  const text = String(sellingPoint ?? '').trim();
  if (!text) return INET_OUTLET_CONDITION_LABEL;
  const bucket = CONDITION_BUCKETS.find(([pattern]) => pattern.test(text));
  return bucket ? bucket[1] : INET_OUTLET_CONDITION_LABEL;
}

/** Records that belong in the listing: enabled feed, still listed, priced. */
export function listableInetRecords(watcherState, config) {
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
  // Outlet units are one unit held in a store; deals may be store-only.
  if (record.storeQty > 0) return 'few_left';
  return 'out_of_stock';
}

function stockNote(record) {
  const parts = [];
  if (Number.isFinite(record.webQty)) parts.push(`Webblager: ${record.webQty}`);
  if (record.storeQty > 0) parts.push(`I butik: ${record.storeQty}`);
  if (record.purchaseStatus && record.purchaseStatus !== 'Purchasable') parts.push(record.purchaseStatus);
  return parts.join(' · ') || null;
}

/** One watcher record as a listing observation (the shape mergeObservations expects). */
export function inetRecordToObservation(record, { catalog = {}, sources = INET_LISTING_SOURCES } = {}) {
  const isOutlet = record.feed === 'outlet';
  const source = sources[record.feed] ?? INET_LISTING_SOURCES[record.feed];
  const categoryName = catalog?.[String(record.templateId ?? '')]?.name ?? null;
  const sellingPoint = typeof record.sellingPoint === 'string' && record.sellingPoint.trim() ? record.sellingPoint.trim() : null;
  return {
    sourceId: source.id,
    sourceLabel: source.label,
    sourceType: source.type ?? INET_LISTING_SOURCES[record.feed].type,
    externalId: String(record.id),
    // One card per item: outlet units are individual units, and name-grouping
    // would merge them with each other and with the campaign item.
    productKey: `inet-${record.id}`,
    title: record.title,
    // Outlet: the unit's condition. Deals: Inet's one-line pitch ("AM5-moderkort").
    description: sellingPoint,
    url: record.url,
    category: categoryName && categoryName !== 'Default' ? categoryName : 'Inet',
    categoryGroupId: record.templateId ? `inet-template-${record.templateId}` : null,
    condition: isOutlet ? 'outlet' : 'deal',
    conditionLabel: isOutlet ? inetConditionLabel(sellingPoint) : INET_DEALS_CONDITION_LABEL,
    priceSek: record.priceSek,
    marketValueSek: null,
    // Inet's ordinary price ("listPrice"), only when it is above the current one.
    referencePriceSek: Number.isFinite(record.listPriceSek) && record.listPriceSek > record.priceSek ? record.listPriceSek : null,
    articleNumber: String(record.bargainParentId ?? record.id),
    availability: availabilityOf(record),
    imageUrl: record.imageUrl ?? null,
    notes: stockNote(record),
    seenAt: record.lastSeenAt ?? record.firstSeenAt ?? new Date().toISOString()
  };
}

/**
 * Sync the listing with the watcher state. Mutates `state` (items and the
 * itemHistory archive) and returns the keys the caller must persist.
 *
 * @returns {{ listed: number, newCount: number, newKeys: string[], changedKeys: string[], deletedKeys: string[] }}
 */
export function syncInetListing({ state, watcherState, config, sources = INET_LISTING_SOURCES, maxHistoryEntries = 20, getItemHistory = null }) {
  const sourceIds = new Set(Object.values(sources).map((source) => source.id));
  const catalog = watcherState?.catalog ?? {};
  const records = listableInetRecords(watcherState, config);
  const observations = records.map((record) => inetRecordToObservation(record, { catalog, sources }));
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
        archivedAt: new Date().toISOString()
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
    deletedKeys
  };
}
