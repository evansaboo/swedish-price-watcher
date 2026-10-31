/**
 * Komplett demo-products watcher ("demovaror", B-grade) — configuration.
 *
 * Like the hotlist, this lives in SQLite preferences (`preferences.komplettDemo`)
 * and is owned by the dashboard. The category catalog is hard-coded: Komplett's
 * demo tree changes rarely, and discovering it live would cost an Apify run.
 */

import { normalizeWebhookUrl } from './hotlistConfig.js';

// Komplett's Akamai edge blocked us for polling on a fixed, fast clock. Each
// poll is also a paid Apify actor run, so the floor is deliberately generous.
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 240;
export const DEFAULT_INTERVAL_MINUTES = 10;
export const DEFAULT_JITTER_PCT = 40;
export const MAX_JITTER_PCT = 50;
export const DEFAULT_MAX_MONTHLY_USD = 4;
// The Apify FREE plan is capped at $5/month for the whole account.
export const MAX_MONTHLY_USD_LIMIT = 50;
export const MIN_MONTHLY_USD = 0.1;

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

export const DEFAULT_KOMPLETT_DEMO_CONFIG = Object.freeze({
  enabled: false,
  categories: [],
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  jitterPct: DEFAULT_JITTER_PCT,
  notifyPriceDropPercent: 0,
  notifyBackInStock: true,
  discordWebhookUrl: '',
  maxMonthlyUsd: DEFAULT_MAX_MONTHLY_USD,
});

export function normalizeKomplettDemoConfig(raw, base = DEFAULT_KOMPLETT_DEMO_CONFIG) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fallback = base && typeof base === 'object' ? base : DEFAULT_KOMPLETT_DEMO_CONFIG;
  const pick = (key) => (Object.hasOwn(input, key) ? input[key] : fallback[key]);

  return {
    enabled: Boolean(pick('enabled')),
    categories: normalizeCategoryIds(pick('categories')),
    intervalMinutes: clampNumber(pick('intervalMinutes'), {
      min: MIN_INTERVAL_MINUTES, max: MAX_INTERVAL_MINUTES, fallback: DEFAULT_INTERVAL_MINUTES,
    }),
    jitterPct: Math.round(clampNumber(pick('jitterPct'), { min: 0, max: MAX_JITTER_PCT, fallback: DEFAULT_JITTER_PCT })),
    // 0 = price-drop alerts off.
    notifyPriceDropPercent: Math.round(clampNumber(pick('notifyPriceDropPercent'), { min: 0, max: 90, fallback: 0 })),
    notifyBackInStock: pick('notifyBackInStock') !== false,
    // Empty = fall back to the app's global DISCORD_WEBHOOK_URL.
    discordWebhookUrl: normalizeWebhookUrl(pick('discordWebhookUrl')),
    maxMonthlyUsd: Math.round(clampNumber(pick('maxMonthlyUsd'), {
      min: MIN_MONTHLY_USD, max: MAX_MONTHLY_USD_LIMIT, fallback: DEFAULT_MAX_MONTHLY_USD,
    }) * 100) / 100,
  };
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
