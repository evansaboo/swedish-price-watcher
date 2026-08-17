import 'dotenv/config';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supportedSourceTypes = new Set(['rss', 'komplett-category', 'apify-elgiganten', 'elgiganten-algolia', 'elgiganten-campaigns', 'elgiganten-hotlist', 'webhallen-api', 'netonnet-outlet', 'proshop-outlet', 'power-deals', 'gg-deals-games', 'blocket', 'sweclockers-dagensfynd', 'inet-fyndhornan', 'kjell-outlet', 'dustin-fyndvaror', 'tradera-sold']);
const supportedNotificationModes = new Set(['new-listings', 'favorite-events', 'none']);
const isContainerRuntime = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.DOCKER === '1' || process.env.container);

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

  const affiliateEnvKey = `AFFILIATE_LINK_TEMPLATE_${String(source.id).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const rawAffiliate = asPlainObject(source.affiliateProgram);
  const affiliateLinkTemplate = String(process.env[affiliateEnvKey] ?? rawAffiliate.linkTemplate ?? '').trim();

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
    attributes: asPlainObject(source.attributes),
    affiliateProgram: affiliateLinkTemplate
      ? {
          network: String(rawAffiliate.network ?? 'affiliate').trim() || 'affiliate',
          linkTemplate: affiliateLinkTemplate
        }
      : null
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
    host: isContainerRuntime ? '0.0.0.0' : process.env.HOST ?? '127.0.0.1',
    scanIntervalMinutes: parsePositiveInt(process.env.SCAN_INTERVAL_MINUTES, 180),
    hostDelayMs: parsePositiveInt(process.env.HOST_DELAY_MS, 8000),
    requestTimeoutMs: parsePositiveInt(process.env.REQUEST_TIMEOUT_MS, 20000),
    maxHistoryEntries: parsePositiveInt(process.env.MAX_HISTORY_ENTRIES, 20),
    archiveRetentionDays: parsePositiveInt(process.env.ARCHIVE_RETENTION_DAYS, 90),
    // During a scan, the deals + product-cache recompute is expensive (seconds
    // over ~26k items) and synchronous. Coalesce it to at most once per this
    // interval so a multi-source scan doesn't freeze the event loop / UI.
    recomputeIntervalMs: parsePositiveInt(process.env.SCAN_RECOMPUTE_INTERVAL_MS, 9000),
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
    resale: {
      minSampleCount: parsePositiveInt(process.env.RESALE_MIN_SAMPLES, 3),
      resaleAdjustFactor: Number.parseFloat(process.env.RESALE_ADJUST_FACTOR ?? '') || 0.95,
      flatFeeSek: parseNonNegativeInt(process.env.RESALE_FLAT_FEE_SEK, 60),
      minNetProfitSek: parsePositiveInt(process.env.RESALE_MIN_PROFIT_SEK, 300),
      minRoiPercent: parsePositiveInt(process.env.RESALE_MIN_ROI_PERCENT, 8)
    },
    access: {
      adminToken: process.env.ADMIN_API_TOKEN?.trim() ?? '',
      premiumAccessKeys: (process.env.PREMIUM_ACCESS_KEYS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? '',
      stripeSecretKey: process.env.STRIPE_SECRET_KEY?.trim() ?? '',
      stripePriceId: process.env.STRIPE_PREMIUM_PRICE_ID?.trim() ?? '',
      publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() ?? ''
    },
    tradera: {
      draftEndpoint: process.env.TRADERA_DRAFT_ENDPOINT?.trim() ?? '',
      accessToken: process.env.TRADERA_ACCESS_TOKEN?.trim() ?? ''
    },
    purchase: {
      // Discord application credentials — required for button clicks. A webhook
      // alone is send-only and can never receive an interaction.
      discordPublicKey: process.env.DISCORD_PUBLIC_KEY?.trim() ?? '',
      // Optional. Buttons require a bot (or application-owned webhook); a plain
      // channel webhook is send-only and cannot carry message components.
      discordBotToken: process.env.DISCORD_BOT_TOKEN?.trim() ?? '',
      discordAlertChannelId: process.env.DISCORD_ALERT_CHANNEL_ID?.trim() ?? '',
      // Allow-list of Discord user IDs permitted to press purchase buttons.
      discordOwnerIds: (process.env.DISCORD_OWNER_IDS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
      // Optional Elgiganten sign-in. Staging works anonymously without these;
      // credentials only pre-fill delivery details to shorten manual checkout.
      elgigantenEmail: process.env.ELGIGANTEN_EMAIL?.trim() ?? '',
      elgigantenPassword: process.env.ELGIGANTEN_PASSWORD ?? '',
      sessionPath: process.env.ELGIGANTEN_SESSION_PATH?.trim() || path.join(rootDir, 'data', 'elgiganten-session.json')
    },
    llm: {
      enabled: (process.env.LLM_CLASSIFIER_ENABLED ?? 'true') !== 'false',
      provider: (process.env.LLM_PROVIDER || 'gemini').toLowerCase(),
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
      ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
      ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:3b',
      cacheFile: path.resolve(rootDir, process.env.LLM_CACHE_FILE ?? 'data/llm-model-cache.json'),
      batchSize: parsePositiveInt(process.env.LLM_BATCH_SIZE, 25),
      maxTitlesPerRun: parsePositiveInt(process.env.LLM_MAX_TITLES_PER_RUN, 400),
      requestTimeoutMs: parsePositiveInt(process.env.LLM_REQUEST_TIMEOUT_MS, 30000),
      minRequestIntervalMs: parseNonNegativeInt(process.env.LLM_MIN_REQUEST_INTERVAL_MS, 6000)
    },
    sources: await loadSources(sourcesFile)
  };
}
