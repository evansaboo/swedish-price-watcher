import 'dotenv/config';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supportedSourceTypes = new Set(['rss', 'html-page', 'html-list', 'komplett-category', 'komplett-sitemap', 'apify-elgiganten', 'apify-komplett', 'elgiganten-algolia', 'elgiganten-campaigns', 'webhallen-api', 'netonnet-outlet', 'proshop-outlet', 'power-deals', 'gg-deals-games']);
const supportedNotificationModes = new Set(['new-listings', 'favorite-events', 'none']);
const isRailwayRuntime = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : [];
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asPlainObjectArray(value) {
  return Array.isArray(value) ? value.map((entry) => asPlainObject(entry)).filter((entry) => Object.keys(entry).length) : [];
}

function normalizeNotificationMode(value) {
  const mode = String(value ?? 'new-listings').trim();
  return supportedNotificationModes.has(mode) ? mode : 'new-listings';
}

function sanitizeSource(rawSource) {
  const source = { ...rawSource };

  if (!source.id) {
    throw new Error('Every source must have an id.');
  }

  if (!supportedSourceTypes.has(source.type)) {
    throw new Error(`Unsupported source type "${source.type}" in ${source.id}.`);
  }

  return {
    ...source,
    enabled: Boolean(source.enabled),
    category: source.category ?? 'uncategorized',
    condition: source.condition ?? 'new',
    shippingEstimateSek: Number(source.shippingEstimateSek ?? 0),
    feesEstimateSek: Number(source.feesEstimateSek ?? 0),
    marketValueSek: source.marketValueSek == null ? null : Number(source.marketValueSek),
    referencePriceSek: source.referencePriceSek == null ? null : Number(source.referencePriceSek),
    resaleEstimateSek: source.resaleEstimateSek == null ? null : Number(source.resaleEstimateSek),
    sitemapUrl: source.sitemapUrl ?? null,
    includePaths: asStringArray(source.includePaths),
    excludePaths: asStringArray(source.excludePaths),
    matchReferenceIncludePaths: asStringArray(source.matchReferenceIncludePaths),
    matchReferenceExcludePaths: asStringArray(source.matchReferenceExcludePaths),
    categoryRoots: asStringArray(source.categoryRoots),
    maxItems: source.maxItems == null ? null : Number(source.maxItems),
    maxPages: source.maxPages == null ? null : Number(source.maxPages),
    categoryUrl: source.categoryUrl ?? null,
    refPriceLookupPerScan: source.refPriceLookupPerScan == null ? null : Number(source.refPriceLookupPerScan),
    updatedSinceDays: source.updatedSinceDays == null ? null : Number(source.updatedSinceDays),
    notificationMode: normalizeNotificationMode(source.notificationMode),
    notificationBatchSize: parsePositiveInt(source.notificationBatchSize, 5),
    actorId: source.actorId ?? null,
    actorInput: asPlainObject(source.actorInput),
    actorInputVariants: asPlainObjectArray(source.actorInputVariants),
    actorKeywordQueries: asStringArray(source.actorKeywordQueries),
    actorKeywordResultsWanted: parsePositiveInt(source.actorKeywordResultsWanted, 500),
    actorKeywordMaxPages: parsePositiveInt(source.actorKeywordMaxPages, 30),
    actorTimeoutMs: parsePositiveInt(source.actorTimeoutMs, 120000),
    actorRequestRetries: parseNonNegativeInt(source.actorRequestRetries, 3),
    actorRetryBaseMs: parsePositiveInt(source.actorRetryBaseMs, 1200),
    actorRetryMaxMs: parsePositiveInt(source.actorRetryMaxMs, 12000),
    apiTokenEnvVar: String(source.apiTokenEnvVar ?? 'APIFY_TOKEN').trim() || 'APIFY_TOKEN',
    apiTokenEnvVars: asStringArray(source.apiTokenEnvVars),
    referenceLookup: source.referenceLookup !== false,
    referenceLookupMaxPerScan: parseNonNegativeInt(source.referenceLookupMaxPerScan, 300),
    referenceLookupConcurrency: parsePositiveInt(source.referenceLookupConcurrency, 6),
    referenceLookupRetryHours: parsePositiveInt(source.referenceLookupRetryHours, 24),
    referenceLookupResultsWanted: parsePositiveInt(source.referenceLookupResultsWanted, 80),
    referenceLookupMaxPages: parsePositiveInt(source.referenceLookupMaxPages, 2),
    selectors: asPlainObject(source.selectors),
    attributes: asPlainObject(source.attributes)
  };
}

async function loadSources(filePath) {
  try {
    const file = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(file);
    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    return sources.map(sanitizeSource);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }

    throw new Error(`Unable to load sources from ${filePath}: ${error.message}`);
  }
}

export async function loadConfig() {
  const sourcesFile = path.resolve(rootDir, process.env.SOURCES_FILE ?? 'config/sources.json');

  return {
    rootDir,
    publicDir: path.resolve(rootDir, 'public'),
    dataFile: path.resolve(rootDir, process.env.DATA_FILE ?? 'data/store.json'),
    sourcesFile,
    port: parsePositiveInt(process.env.PORT, 3030),
    host: isRailwayRuntime ? '0.0.0.0' : process.env.HOST ?? '127.0.0.1',
    scanIntervalMinutes: parsePositiveInt(process.env.SCAN_INTERVAL_MINUTES, 180),
    hostDelayMs: parsePositiveInt(process.env.HOST_DELAY_MS, 8000),
    requestTimeoutMs: parsePositiveInt(process.env.REQUEST_TIMEOUT_MS, 20000),
    maxHistoryEntries: parsePositiveInt(process.env.MAX_HISTORY_ENTRIES, 10),
    userAgent: process.env.USER_AGENT ?? 'swedish-price-watcher/0.1 (+set-contact-email)',
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL?.trim() ?? '',
    notificationCooldownHours: parsePositiveInt(process.env.NOTIFICATION_COOLDOWN_HOURS, 24),
    disableHoursOnBlock: parsePositiveInt(process.env.DISABLE_HOURS_ON_BLOCK, 12),
    runOnStart: process.env.RUN_ON_START !== 'false',
    thresholds: {
      minimumScore: parsePositiveInt(process.env.MINIMUM_SCORE, 65),
      minimumDiscountPercent: parsePositiveInt(process.env.MINIMUM_DISCOUNT_PERCENT, 18),
      minimumProfitSek: parsePositiveInt(process.env.MINIMUM_PROFIT_SEK, 400)
    },
    sources: await loadSources(sourcesFile)
  };
}
