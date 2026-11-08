/**
 * Inet watcher (campaign deals + Fyndhörnan outlet) — configuration.
 *
 * Lives in SQLite preferences (`preferences.inet`) and is owned by the
 * dashboard, like the Komplett demo watcher. What to alert on is defined by
 * watch groups (keywords, Inet "template" categories, price/discount/stock
 * filters), borrowed from the Elgiganten hotlist. Categories are Inet's
 * template ids; their names come from the live catalog the poller caches.
 */

import { normalizeWebhookUrl } from './hotlistConfig.js';
import { isMaskedWebhookUrl, maskWebhookUrl } from './komplettDemoConfig.js';

export { isMaskedWebhookUrl, maskWebhookUrl };

// Page-1 delta polling and proxy support allow fast intervals (down to 30 seconds / 0.5 min).
export const MIN_INTERVAL_MINUTES = 0.5;
export const MAX_INTERVAL_MINUTES = 240;
export const DEFAULT_INTERVAL_MINUTES = 20;
export const DEFAULT_JITTER_PCT = 40;
export const MAX_JITTER_PCT = 50;
// The Apify FREE plan is $5/month for the whole account; Komplett uses ~$2.5.
export const DEFAULT_MAX_MONTHLY_USD = 1.5;
export const MAX_MONTHLY_USD_LIMIT = 50;
export const MIN_MONTHLY_USD = 0.1;
export const DEFAULT_PRICE_DROP_PCT = 5;

export const MAX_GROUPS = 24;
export const MAX_KEYWORDS_PER_GROUP = 20;
export const MAX_CATEGORIES_PER_GROUP = 60;
export const GROUP_FEEDS = Object.freeze(['both', 'deals', 'outlet']);

function clampNumber(value, { min, max, fallback }) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Blank/invalid = "no constraint" (null), which differs from 0. */
function optionalNumber(value, { min, max }) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeKeywords(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const keyword = String(entry ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!keyword || seen.has(keyword.toLowerCase())) continue;
    seen.add(keyword.toLowerCase());
    out.push(keyword);
    if (out.length >= MAX_KEYWORDS_PER_GROUP) break;
  }
  return out;
}

const isTemplateId = (value) => /^\d{1,9}$/.test(String(value ?? '').trim());

/** Template ids as strings, de-duplicated, order kept. */
export function normalizeTemplateIds(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  const out = [];
  for (const entry of raw) {
    const id = String(entry ?? '').trim();
    if (isTemplateId(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_CATEGORIES_PER_GROUP) break;
  }
  return out;
}

let groupIdCounter = 0;
function makeGroupId() {
  groupIdCounter += 1;
  return `ig-${Date.now().toString(36)}-${groupIdCounter.toString(36)}`;
}

export function normalizeInetGroup(raw, index = 0) {
  const group = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = String(group.id ?? '').trim().replace(/[^\w-]/g, '').slice(0, 40);
  return {
    id: id || makeGroupId(),
    name: String(group.name ?? group.label ?? '').trim().slice(0, 80) || `Watch group ${index + 1}`,
    enabled: group.enabled !== false,
    feeds: GROUP_FEEDS.includes(group.feeds) ? group.feeds : 'both',
    keywords: normalizeKeywords(group.keywords),
    // Off = loose substring match ("5090" also matches "5090D"). On = every
    // keyword word must be a whole word of the title.
    strictKeywordMatch: group.strictKeywordMatch !== false,
    categories: normalizeTemplateIds(group.categories),
    minDiscountPct: optionalNumber(group.minDiscountPct, { min: 0, max: 99 }),
    maxPriceSek: (() => {
      const n = optionalNumber(group.maxPriceSek, { min: 0, max: 10_000_000 });
      return n && n > 0 ? Math.round(n) : null;
    })(),
    inStockOnly: group.inStockOnly === true,
    // null = use the global price-drop %; 0 = no price-drop alerts for this group.
    priceDropPct: (() => {
      const n = optionalNumber(group.priceDropPct, { min: 0, max: 90 });
      return n === null ? null : Math.round(n);
    })(),
  };
}

/**
 * A group must narrow the feeds somehow, or it would alert on every item.
 * A minimum discount alone counts ("anything ≥ 50% off").
 */
export function isGroupActive(group) {
  return Boolean(group?.enabled && (
    group.keywords?.length || group.categories?.length || (group.minDiscountPct ?? 0) > 0
  ));
}

export function groupCoversFeed(group, feedId) {
  return group.feeds === 'both' || group.feeds === feedId;
}

export const DEFAULT_INET_CONFIG = Object.freeze({
  enabled: false,
  feeds: Object.freeze({ deals: true, outlet: true }),
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  jitterPct: DEFAULT_JITTER_PCT,
  notifyPriceDropPercent: DEFAULT_PRICE_DROP_PCT,
  notifyBackInStock: true,
  discordWebhookUrl: '',
  maxMonthlyUsd: DEFAULT_MAX_MONTHLY_USD,
  groups: Object.freeze([]),
});

export function normalizeInetConfig(raw, base = DEFAULT_INET_CONFIG) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fallback = base && typeof base === 'object' ? base : DEFAULT_INET_CONFIG;
  const pick = (key) => (Object.hasOwn(input, key) ? input[key] : fallback[key]);

  const feedsIn = { ...DEFAULT_INET_CONFIG.feeds, ...(fallback.feeds ?? {}), ...(input.feeds && typeof input.feeds === 'object' ? input.feeds : {}) };
  const groupsIn = Array.isArray(pick('groups')) ? pick('groups') : [];
  const groups = [];
  const ids = new Set();
  for (const [index, rawGroup] of groupsIn.slice(0, MAX_GROUPS).entries()) {
    const group = normalizeInetGroup(rawGroup, index);
    if (ids.has(group.id)) group.id = makeGroupId();
    ids.add(group.id);
    groups.push(group);
  }

  return {
    enabled: Boolean(pick('enabled')),
    feeds: { deals: feedsIn.deals !== false, outlet: feedsIn.outlet !== false },
    intervalMinutes: Math.round(clampNumber(pick('intervalMinutes'), {
      min: MIN_INTERVAL_MINUTES, max: MAX_INTERVAL_MINUTES, fallback: DEFAULT_INTERVAL_MINUTES,
    }) * 10) / 10,
    jitterPct: Math.round(clampNumber(pick('jitterPct'), { min: 0, max: MAX_JITTER_PCT, fallback: DEFAULT_JITTER_PCT })),
    // 0 = price-drop alerts off (groups can still override).
    notifyPriceDropPercent: Math.round(clampNumber(pick('notifyPriceDropPercent'), { min: 0, max: 90, fallback: DEFAULT_PRICE_DROP_PCT })),
    notifyBackInStock: pick('notifyBackInStock') !== false,
    // Empty = fall back to the app's global DISCORD_WEBHOOK_URL.
    discordWebhookUrl: normalizeWebhookUrl(pick('discordWebhookUrl')),
    maxMonthlyUsd: Math.round(clampNumber(pick('maxMonthlyUsd'), {
      min: MIN_MONTHLY_USD, max: MAX_MONTHLY_USD_LIMIT, fallback: DEFAULT_MAX_MONTHLY_USD,
    }) * 100) / 100,
    groups,
  };
}

export function ensureInetConfig(preferences) {
  const target = preferences ?? {};
  target.inet = normalizeInetConfig(target.inet);
  return target.inet;
}

export function enabledFeedIds(config) {
  return ['deals', 'outlet'].filter((id) => config?.feeds?.[id] !== false);
}

/**
 * Shape checks for a dashboard POST, so a typo is a 400 rather than a value
 * the normaliser silently drops. Returns an error message or null.
 */
export function validateInetConfigPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'Expected an Inet configuration object.';
  if (Object.hasOwn(patch, 'feeds')) {
    const feeds = patch.feeds;
    if (!feeds || typeof feeds !== 'object' || Array.isArray(feeds)) return 'feeds must be an object like { "deals": true, "outlet": true }.';
    const unknown = Object.keys(feeds).filter((key) => key !== 'deals' && key !== 'outlet');
    if (unknown.length) return `Unknown Inet feed: ${unknown.join(', ')}`;
  }
  if (Object.hasOwn(patch, 'groups')) {
    if (!Array.isArray(patch.groups)) return 'groups must be an array.';
    if (patch.groups.length > MAX_GROUPS) return `At most ${MAX_GROUPS} watch groups.`;
    for (const [index, group] of patch.groups.entries()) {
      const label = `Watch group ${index + 1}`;
      if (!group || typeof group !== 'object' || Array.isArray(group)) return `${label}: expected an object.`;
      if (group.feeds !== undefined && !GROUP_FEEDS.includes(group.feeds)) return `${label}: feeds must be one of ${GROUP_FEEDS.join(', ')}.`;
      if (group.keywords !== undefined && !Array.isArray(group.keywords)) return `${label}: keywords must be an array.`;
      if (Array.isArray(group.keywords) && group.keywords.some((k) => typeof k !== 'string')) return `${label}: keywords must be strings.`;
      if (group.categories !== undefined) {
        if (!Array.isArray(group.categories)) return `${label}: categories must be an array of Inet category ids.`;
        const bad = group.categories.filter((id) => !isTemplateId(id));
        if (bad.length) return `${label}: unknown category id${bad.length === 1 ? '' : 's'} ${bad.slice(0, 5).join(', ')}.`;
      }
    }
  }
  return null;
}

/** Config as served to the dashboard (the webhook token is never echoed back). */
export function publicInetConfig(config) {
  const normalized = normalizeInetConfig(config);
  return {
    ...normalized,
    discordWebhookUrl: maskWebhookUrl(normalized.discordWebhookUrl),
    discordWebhookConfigured: Boolean(normalized.discordWebhookUrl),
  };
}
