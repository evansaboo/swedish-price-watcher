/**
 * Hotlist configuration — the user-editable definition of what the Elgiganten
 * hotlist poller watches.
 *
 * The poller runs continuously and independently of the scan scheduler, so its
 * settings live in the SQLite-backed preferences (not in `config/sources.json`)
 * and can be changed from the dashboard without a redeploy.
 *
 * `config/sources.json` still supplies the seed used the very first time, so a
 * fresh install starts with a sensible resale-focused watch list.
 */

// A poll is a single Algolia request, but polling faster than this stops being
// "polite" and starts looking like scraping.
export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 3600;
export const DEFAULT_INTERVAL_SECONDS = 90;

export const MAX_GROUPS = 24;
export const MAX_KEYWORDS_PER_GROUP = 12;
export const MAX_VALUES_PER_FIELD = 40;
// Every keyword becomes its own sub-query inside the one multi-query request.
// Capping the total keeps a single poll to one reasonably sized round-trip.
export const MAX_SUBQUERIES = 60;

const DEFAULT_MIN_DISCOUNT_PCT = 15;
const DEFAULT_HITS_PER_GROUP = 100;
const MAX_HITS_PER_GROUP = 200;

/**
 * The hotlist posts to its own Discord webhook rather than borrowing the alert
 * rules'. Sharing them meant a hotlist find fired whichever unrelated rule
 * happened to match its title, and the Hotlist tab gave no indication of where
 * its notifications were going.
 */
export function normalizeWebhookUrl(value) {
  const url = String(value ?? '').trim();
  if (!url) return '';
  // Anything else would be posted to blindly on every poll.
  if (!/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(url)) return '';
  return url;
}

function clampNumber(value, { min, max, fallback }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Optional numeric field: absent/blank means "no constraint", which is
 * different from zero.
 */
function optionalPositiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function optionalPercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, 0), 99);
}

function normalizeStringList(value, limit = MAX_VALUES_PER_FIELD) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]/)
      : [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const trimmed = String(entry ?? '').trim();
    if (!trimmed) continue;
    const dedupeKey = trimmed.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

let groupIdCounter = 0;
function makeGroupId() {
  groupIdCounter += 1;
  return `hg-${Date.now().toString(36)}-${groupIdCounter.toString(36)}`;
}

export function normalizeHotlistGroup(raw, index = 0) {
  const group = raw && typeof raw === 'object' ? raw : {};
  const taxonomyIds = normalizeStringList(group.taxonomyIds);
  const taxonomyNames = normalizeStringList(group.taxonomyNames);
  const brands = normalizeStringList(group.brands);
  const keywords = normalizeStringList(group.keywords, MAX_KEYWORDS_PER_GROUP);

  return {
    id: String(group.id ?? '').trim() || makeGroupId(),
    label: String(group.label ?? '').trim() || `Watch group ${index + 1}`,
    enabled: group.enabled !== false,
    taxonomyIds,
    taxonomyNames,
    brands,
    keywords,
    // Algolia is typo-tolerant, which is great for a search box and bad for an
    // alerting rule: a "RTX 5090" watch would happily match an RTX 5070. When
    // strict matching is on, a hit must also literally contain the keyword's
    // significant tokens in its title.
    strictKeywordMatch: group.strictKeywordMatch !== false,
    minDiscountPct: optionalPercent(group.minDiscountPct),
    minPriceSek: optionalPositiveNumber(group.minPriceSek),
    maxPriceSek: optionalPositiveNumber(group.maxPriceSek),
  };
}

/**
 * A group is only pollable if it narrows the catalogue somehow. Without any
 * filter or keyword it would match the entire store.
 */
export function isGroupPollable(group) {
  return Boolean(
    group.taxonomyIds.length ||
    group.taxonomyNames.length ||
    group.brands.length ||
    group.keywords.length
  );
}

export function normalizeHotlistConfig(raw, seed = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const hasGroups = Array.isArray(input.groups);
  const sourceGroups = hasGroups ? input.groups : (seed.groups ?? []);

  const groups = sourceGroups
    .slice(0, MAX_GROUPS)
    .map((group, index) => normalizeHotlistGroup(group, index));

  return {
    enabled: input.enabled === undefined ? seed.enabled !== false : Boolean(input.enabled),
    webhookUrl: normalizeWebhookUrl(input.webhookUrl ?? seed.webhookUrl),
    notifyPriceDrops: input.notifyPriceDrops === undefined
      ? seed.notifyPriceDrops !== false
      : Boolean(input.notifyPriceDrops),
    intervalSeconds: Math.round(clampNumber(
      input.intervalSeconds ?? seed.intervalSeconds,
      { min: MIN_INTERVAL_SECONDS, max: MAX_INTERVAL_SECONDS, fallback: DEFAULT_INTERVAL_SECONDS },
    )),
    // Randomised delay around the base interval so polls never land on a
    // perfectly predictable clock tick.
    jitterPct: Math.round(clampNumber(
      input.jitterPct ?? seed.jitterPct,
      { min: 0, max: 50, fallback: 20 },
    )),
    minDiscountPct: Math.round(clampNumber(
      input.minDiscountPct ?? seed.minDiscountPct,
      { min: 0, max: 99, fallback: DEFAULT_MIN_DISCOUNT_PCT },
    )),
    hitsPerGroup: Math.round(clampNumber(
      input.hitsPerGroup ?? seed.hitsPerGroup,
      { min: 1, max: MAX_HITS_PER_GROUP, fallback: DEFAULT_HITS_PER_GROUP },
    )),
    sources: {
      'elgiganten-hotlist': true,
      'amazon-hotlist': true,
      ...(seed.sources && typeof seed.sources === 'object' ? seed.sources : {}),
      ...(input.sources && typeof input.sources === 'object' ? input.sources : {})
    },
    groups,
  };
}

/**
 * Build the initial config from the `config/sources.json` entry, so existing
 * installs keep the watch groups they already had.
 */
export function seedHotlistConfigFromSource(source = {}) {
  return normalizeHotlistConfig({
    enabled: source.enabled !== false,
    intervalSeconds: source.pollIntervalSeconds,
    minDiscountPct: source.minDiscountPct,
    hitsPerGroup: source.hitsPerGroup,
    groups: (source.watchGroups ?? []).map((group) => ({
      ...group,
      keywords: group.keywords ?? (group.query ? [group.query] : []),
    })),
  });
}

export function ensureHotlistConfig(preferences, seedSource) {
  const target = preferences ?? {};
  const existing = target.hotlist;
  target.hotlist = existing
    ? normalizeHotlistConfig(existing)
    : seedHotlistConfigFromSource(seedSource ?? {});

  adoptWebhookFromLegacyAlertRule(target, seedSource?.id);

  return target.hotlist;
}

/**
 * Before the hotlist had its own webhook, the only way to route its finds
 * anywhere was an alert rule scoped to the hotlist source. Those rules stop
 * matching now that the two systems are separate, so carry the webhook over
 * rather than silently dropping notifications the user had working.
 */
function adoptWebhookFromLegacyAlertRule(preferences, hotlistSourceId) {
  if (!hotlistSourceId || preferences.hotlist.webhookUrl) return;

  const rules = preferences.notificationSettings?.alertRules;
  if (!Array.isArray(rules)) return;

  const legacy = rules.find((rule) => {
    const sources = rule?.filteredSources ?? rule?.excludedSources ?? [];
    return rule?.sourceFilterMode === 'include'
      && sources.length === 1
      && sources[0] === hotlistSourceId
      && (rule.webhooks ?? []).some((w) => normalizeWebhookUrl(w));
  });
  if (!legacy) return;

  const webhook = (legacy.webhooks ?? []).map(normalizeWebhookUrl).find(Boolean);
  preferences.hotlist.webhookUrl = webhook;
  console.log(
    `[hotlist] Adopted the webhook from alert rule "${legacy.label ?? legacy.id}" — `
    + 'that rule no longer matches hotlist items and can be deleted.'
  );
}

export function activeGroups(config) {
  return (config.groups ?? []).filter((group) => group.enabled && isGroupPollable(group));
}

/**
 * How many Algolia sub-queries a config costs per poll — surfaced in the UI so
 * the user can see the cost of adding keywords.
 */
export function countSubqueries(config) {
  return activeGroups(config).reduce(
    (total, group) => total + Math.max(group.keywords.length, 1),
    0,
  );
}
