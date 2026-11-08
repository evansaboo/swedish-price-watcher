/**
 * Komplett demo-products watcher ("demovaror", B-grade) — configuration.
 *
 * Like the hotlist, this lives in SQLite preferences (`preferences.komplettDemo`)
 * and is owned by the dashboard. The category catalog is hard-coded: Komplett's
 * demo tree changes rarely, and discovering it live would cost an Apify run.
 */

import { normalizeWebhookUrl } from './hotlistConfig.js';

// Allow intervals down to 30 seconds (0.5 min); the cost guard stretches when needed.
export const MIN_INTERVAL_MINUTES = 0.5;
export const MAX_INTERVAL_MINUTES = 240;
export const DEFAULT_INTERVAL_MINUTES = 10;
export const DEFAULT_JITTER_PCT = 40;
export const MAX_JITTER_PCT = 50;
export const DEFAULT_MAX_MONTHLY_USD = 4;
// The Apify FREE plan is capped at $5/month for the whole account.
export const MAX_MONTHLY_USD_LIMIT = 50;
export const MIN_MONTHLY_USD = 0.1;
export const DEFAULT_PRICE_DROP_PCT = 0;

export const MAX_GROUPS = 24;
export const MAX_KEYWORDS_PER_GROUP = 20;
export const MAX_CATEGORIES_PER_GROUP = 24;
export const GROUP_FEEDS = Object.freeze(['both', 'deals', 'outlet']);

/**
 * Komplett demo categories (discovered from the live site 2026-10-31).
 * URL: https://www.komplett.se/category/<id>/demovaror/<group>/<slug>
 */
export const KOMPLETT_DEMO_CATALOG = Object.freeze([
  {
    group: 'datorutrustning', groupId: '30004', label: 'Datorutrustning',
    categories: [
      { id: '10073', slug: 'demo-bildskarmar', label: 'Bildskärmar' },
      { id: '10072', slug: 'demo-grafikkort', label: 'Grafikkort' },
      { id: '11203', slug: 'demo-haarddiskar', label: 'Hårddiskar & SSD' },
      { id: '9104', slug: 'demo-headset', label: 'Headset & hörlurar' },
      { id: '9105', slug: 'demo-minne-ram', label: 'Minne (RAM)' },
      { id: '10071', slug: 'demo-moderkort', label: 'Moderkort' },
      { id: '9102', slug: 'demo-mus', label: 'Möss' },
      { id: '10075', slug: 'demo-natverk', label: 'Nätverk' },
      { id: '10076', slug: 'demo-ovrigt', label: 'Övrig datorutrustning' },
      { id: '10542', slug: 'demo-skrivare', label: 'Skrivare' },
      { id: '9103', slug: 'demo-tangentbord', label: 'Tangentbord' },
    ],
  },
  {
    group: 'gaming', groupId: '30006', label: 'Gaming',
    categories: [
      { id: '11258', slug: 'demo-gaming', label: 'Gaming' },
    ],
  },
  {
    group: 'datorer', groupId: '10139', label: 'Datorer',
    categories: [
      { id: '10140', slug: 'demo-barbara-datorer', label: 'Bärbara datorer' },
      { id: '10141', slug: 'demo-stationara-datorer', label: 'Stationära datorer' },
      { id: '12423', slug: 'komplett-pc', label: 'Komplett-PC' },
      { id: '10142', slug: 'demo-ovrigt-i-datorer', label: 'Övrigt i datorer' },
    ],
  },
  {
    group: 'tv-ljud-bild', groupId: '10722', label: 'TV, ljud & bild',
    categories: [
      { id: '10551', slug: 'demo-tvprojektorer', label: 'TV & projektorer' },
      { id: '10661', slug: 'demo-hi-fistereodvd', label: 'Hi-Fi, stereo & DVD' },
      { id: '11001', slug: 'demo-ovrigt', label: 'Övrigt TV, ljud & bild' },
    ],
  },
  {
    group: 'mobil-klockor', groupId: '30010', label: 'Mobil & klockor',
    categories: [
      { id: '11149', slug: 'demo-mobiltelefoner', label: 'Mobiltelefoner' },
      { id: '965344', slug: 'demo-tillbehor-till-mobiler-smartwatches', label: 'Tillbehör mobil & smartwatch' },
      { id: '965343', slug: 'demo-watches', label: 'Klockor' },
    ],
  },
  {
    group: 'hem-hushaall', groupId: '30007', label: 'Hem & hushåll',
    categories: [
      { id: '11147', slug: 'demo-hem-hushaall', label: 'Hem & hushåll' },
    ],
  },
  {
    group: 'traning-halsa', groupId: '30013', label: 'Träning & hälsa',
    categories: [
      { id: '21478', slug: 'demo-traning-halsa', label: 'Träning & hälsa' },
    ],
  },
].map((entry) => Object.freeze({ ...entry, categories: Object.freeze(entry.categories.map((c) => Object.freeze(c))) })));

const CATEGORY_BY_ID = new Map(
  KOMPLETT_DEMO_CATALOG.flatMap((group) => group.categories.map((category) => [
    category.id,
    Object.freeze({ ...category, group: group.group, groupLabel: group.label }),
  ])),
);

/** Flat category record ({ id, slug, label, group, groupLabel }) or null. */
export function getKomplettDemoCategory(id) {
  return CATEGORY_BY_ID.get(String(id ?? '').trim()) ?? null;
}

export function listKomplettDemoCategories() {
  return [...CATEGORY_BY_ID.values()];
}

function clampNumber(value, { min, max, fallback }) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Keep only catalog ids, de-duplicated, in catalog order. */
export function normalizeCategoryIds(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  const wanted = new Set(raw.map((entry) => String(entry ?? '').trim()).filter((id) => CATEGORY_BY_ID.has(id)));
  return [...CATEGORY_BY_ID.keys()].filter((id) => wanted.has(id));
}

/** Category ids in `value` that are not in the catalog (for 400 responses). */
export function findUnknownCategoryIds(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? '').trim()).filter((id) => id && !CATEGORY_BY_ID.has(id));
}

function normalizeStringList(value, { max = 20, maxLen = 80 } = {}) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,;]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const trimmed = String(item ?? '').trim().slice(0, maxLen);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeOptionalNumber(value, { min = 0, max = 1_000_000 } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

function normalizeGroupId(value, index) {
  const cleaned = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || `kg-${index + 1}`;
}

export function normalizeKomplettGroup(raw, index = 0) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const keywords = normalizeStringList(input.keywords, { max: MAX_KEYWORDS_PER_GROUP, maxLen: 80 });
  const categories = normalizeCategoryIds(input.categories).slice(0, MAX_CATEGORIES_PER_GROUP);
  const feedsRaw = String(input.feeds ?? 'both').trim().toLowerCase();
  const feeds = GROUP_FEEDS.includes(feedsRaw) ? feedsRaw : 'both';
  const fallbackName = categories.length === 1
    ? (getKomplettDemoCategory(categories[0])?.label || 'Watch group')
    : keywords[0]
      ? keywords.slice(0, 2).join(', ')
      : categories.length > 1
        ? categories.map((id) => getKomplettDemoCategory(id)?.label || id).slice(0, 2).join(', ')
        : `Group ${index + 1}`;
  const name = String(input.name ?? '').trim().slice(0, 60) || fallbackName;

  return {
    id: normalizeGroupId(input.id, index),
    name,
    enabled: input.enabled !== false,
    feeds,
    keywords,
    // Default true: multi-word keywords must appear as a contiguous phrase in the title/description.
    strictKeywordMatch: input.strictKeywordMatch !== false,
    categories,
    minDiscountPct: normalizeOptionalNumber(input.minDiscountPct, { min: 1, max: 95 }),
    maxPriceSek: normalizeOptionalNumber(input.maxPriceSek, { min: 1, max: 500_000 }),
    inStockOnly: Boolean(input.inStockOnly),
    // null = inherit global notifyPriceDropPercent; 0 = off for this group; 1-90 = group threshold.
    priceDropPct: normalizeOptionalNumber(input.priceDropPct, { min: 0, max: 90 }),
  };
}

/** A group is usable if enabled and has at least one scope selector or filter. */
export function isGroupActive(group) {
  if (!group || !group.enabled) return false;
  return Boolean(
    (group.keywords && group.keywords.length > 0)
    || (group.categories && group.categories.length > 0)
    || group.minDiscountPct != null
    || group.maxPriceSek != null,
  );
}

/** Does this group apply to the given feed ('deals' | 'outlet')? */
export function groupCoversFeed(group, feedId) {
  if (!group) return false;
  if (group.feeds === 'both' || !group.feeds) return true;
  return group.feeds === feedId;
}

export function buildLegacyCategoryGroup(catId, index = 0) {
  const cat = getKomplettDemoCategory(catId);
  if (!cat) return null;
  return normalizeKomplettGroup({
    id: `kg-cat-${cat.id}`,
    name: cat.label,
    enabled: true,
    feeds: 'both',
    keywords: [],
    strictKeywordMatch: true,
    categories: [cat.id],
    minDiscountPct: null,
    maxPriceSek: null,
    inStockOnly: false,
    priceDropPct: null,
  }, index);
}

export const DEFAULT_KOMPLETT_DEMO_CONFIG = Object.freeze({
  enabled: false,
  feeds: Object.freeze({ deals: true, outlet: true }),
  categories: Object.freeze([]),
  groups: Object.freeze([]),
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  jitterPct: DEFAULT_JITTER_PCT,
  notifyPriceDropPercent: DEFAULT_PRICE_DROP_PCT,
  notifyBackInStock: true,
  discordWebhookUrl: '',
  maxMonthlyUsd: DEFAULT_MAX_MONTHLY_USD,
});

export function normalizeKomplettDemoConfig(raw, base = DEFAULT_KOMPLETT_DEMO_CONFIG) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fallback = base && typeof base === 'object' ? base : DEFAULT_KOMPLETT_DEMO_CONFIG;
  const pick = (key) => (Object.hasOwn(input, key) ? input[key] : fallback[key]);

  const rawFeeds = input.feeds && typeof input.feeds === 'object' ? input.feeds : {};
  const baseFeeds = fallback.feeds && typeof fallback.feeds === 'object'
    ? fallback.feeds
    : DEFAULT_KOMPLETT_DEMO_CONFIG.feeds;
  const feeds = {
    deals: Object.hasOwn(rawFeeds, 'deals') ? Boolean(rawFeeds.deals) : Boolean(baseFeeds.deals ?? true),
    outlet: Object.hasOwn(rawFeeds, 'outlet') ? Boolean(rawFeeds.outlet) : Boolean(baseFeeds.outlet ?? true),
  };

  const hasExplicitGroups = Object.hasOwn(input, 'groups') && Array.isArray(input.groups);
  const hasExplicitCategories = Object.hasOwn(input, 'categories');

  let rawGroups;
  if (hasExplicitGroups) {
    rawGroups = input.groups;
  } else if (hasExplicitCategories) {
    const legacyCats = normalizeCategoryIds(input.categories);
    rawGroups = legacyCats.map((id, idx) => buildLegacyCategoryGroup(id, idx)).filter(Boolean);
  } else if (Array.isArray(fallback.groups) && fallback.groups.length > 0) {
    rawGroups = fallback.groups;
  } else if (Array.isArray(fallback.categories) && fallback.categories.length > 0) {
    const legacyCats = normalizeCategoryIds(fallback.categories);
    rawGroups = legacyCats.map((id, idx) => buildLegacyCategoryGroup(id, idx)).filter(Boolean);
  } else {
    rawGroups = [];
  }

  const seenIds = new Set();
  const groups = [];
  for (const [idx, entry] of rawGroups.slice(0, MAX_GROUPS).entries()) {
    const group = normalizeKomplettGroup(entry, idx);
    let id = group.id;
    let suffix = 2;
    while (seenIds.has(id)) {
      id = `${group.id}-${suffix++}`;
    }
    seenIds.add(id);
    groups.push({ ...group, id });
  }

  // Keep `categories` synchronized with the enabled watch groups (or explicit categories).
  const groupCategories = normalizeCategoryIds(
    groups.filter((g) => g.enabled !== false).flatMap((g) => g.categories || []),
  );
  const categories = hasExplicitGroups
    ? (hasExplicitCategories && groupCategories.length === 0 ? normalizeCategoryIds(input.categories) : groupCategories)
    : hasExplicitCategories
      ? normalizeCategoryIds(input.categories)
      : groupCategories.length > 0
        ? groupCategories
        : normalizeCategoryIds(fallback.categories);

  return {
    enabled: Boolean(pick('enabled')),
    feeds,
    categories,
    groups,
    intervalMinutes: clampNumber(pick('intervalMinutes'), {
      min: MIN_INTERVAL_MINUTES, max: MAX_INTERVAL_MINUTES, fallback: DEFAULT_INTERVAL_MINUTES,
    }),
    jitterPct: Math.round(clampNumber(pick('jitterPct'), { min: 0, max: MAX_JITTER_PCT, fallback: DEFAULT_JITTER_PCT })),
    // 0 = price-drop alerts off.
    notifyPriceDropPercent: Math.round(clampNumber(pick('notifyPriceDropPercent'), { min: 0, max: 90, fallback: DEFAULT_PRICE_DROP_PCT })),
    notifyBackInStock: pick('notifyBackInStock') !== false,
    // Empty = fall back to the app's global DISCORD_WEBHOOK_URL.
    discordWebhookUrl: normalizeWebhookUrl(pick('discordWebhookUrl')),
    maxMonthlyUsd: Math.round(clampNumber(pick('maxMonthlyUsd'), {
      min: MIN_MONTHLY_USD, max: MAX_MONTHLY_USD_LIMIT, fallback: DEFAULT_MAX_MONTHLY_USD,
    }) * 100) / 100,
  };
}

export function enabledFeedIds(config) {
  const feeds = config?.feeds ?? DEFAULT_KOMPLETT_DEMO_CONFIG.feeds;
  const out = [];
  if (feeds.deals) out.push('deals');
  if (feeds.outlet) out.push('outlet');
  return out;
}

export function validateKomplettDemoConfigPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.';
  }
  if (Object.hasOwn(body, 'categories')) {
    if (!Array.isArray(body.categories)) {
      return 'categories must be an array of Komplett category IDs.';
    }
    const unknown = findUnknownCategoryIds(body.categories);
    if (unknown.length > 0) {
      return `Unknown Komplett demo category id(s): ${unknown.join(', ')}`;
    }
  }
  if (Object.hasOwn(body, 'groups')) {
    if (!Array.isArray(body.groups)) return 'groups must be an array.';
    if (body.groups.length > MAX_GROUPS) return `At most ${MAX_GROUPS} watch groups are allowed.`;
    for (const [idx, g] of body.groups.entries()) {
      if (!g || typeof g !== 'object' || Array.isArray(g)) {
        return `groups[${idx}] must be an object.`;
      }
      if (Object.hasOwn(g, 'categories') && Array.isArray(g.categories)) {
        const unknown = findUnknownCategoryIds(g.categories);
        if (unknown.length > 0) {
          return `Unknown Komplett category id(s) in groups[${idx}]: ${unknown.join(', ')}`;
        }
      }
    }
  }
  if (Object.hasOwn(body, 'feeds')) {
    if (!body.feeds || typeof body.feeds !== 'object' || Array.isArray(body.feeds)) {
      return 'feeds must be an object ({ deals, outlet }).';
    }
  }
  if (Object.hasOwn(body, 'discordWebhookUrl') && !isMaskedWebhookUrl(body.discordWebhookUrl)) {
    const rawUrl = String(body.discordWebhookUrl ?? '').trim();
    if (rawUrl && !normalizeWebhookUrl(rawUrl)) {
      return 'Discord webhook URL must be https://discord.com/api/webhooks/<id>/<token>.';
    }
  }
  return null;
}

export function ensureKomplettDemoConfig(preferences) {
  const target = preferences ?? {};
  target.komplettDemo = normalizeKomplettDemoConfig(target.komplettDemo);
  return target.komplettDemo;
}

const WEBHOOK_MASK = '••••••';

/**
 * The dashboard GET is not admin-gated, so the webhook token is never echoed
 * back in full. Posting the masked value back keeps the stored webhook.
 */
export function maskWebhookUrl(url) {
  const value = String(url ?? '');
  if (!value) return '';
  const match = value.match(/^(https:\/\/[^/]+\/api\/webhooks\/\d+\/)(.*)$/i);
  return match ? `${match[1]}${WEBHOOK_MASK}` : WEBHOOK_MASK;
}

export function isMaskedWebhookUrl(value) {
  return String(value ?? '').includes(WEBHOOK_MASK);
}

/** Config as served to the dashboard. */
export function publicKomplettDemoConfig(config) {
  const normalized = normalizeKomplettDemoConfig(config);
  return {
    ...normalized,
    discordWebhookUrl: maskWebhookUrl(normalized.discordWebhookUrl),
    discordWebhookConfigured: Boolean(normalized.discordWebhookUrl),
  };
}
