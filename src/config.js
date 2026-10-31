import 'dotenv/config';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Only the sources the app still runs. Every other scan-source type was
// archived on 2026-10-31 (archive/scrapers/README.md); re-add its type here,
// and any config fields it needs below, when reviving one.
const supportedSourceTypes = new Set(['elgiganten-hotlist', 'komplett-demo']);
const isContainerRuntime = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.DOCKER === '1' || process.env.container);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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
    hostDelayMs: parsePositiveInt(process.env.HOST_DELAY_MS, 8000),
    requestTimeoutMs: parsePositiveInt(process.env.REQUEST_TIMEOUT_MS, 20000),
    maxHistoryEntries: parsePositiveInt(process.env.MAX_HISTORY_ENTRIES, 20),
    userAgent: process.env.USER_AGENT ?? 'swedish-price-watcher/0.1 (+set-contact-email)',
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL?.trim() ?? '',
    notificationCooldownHours: parsePositiveInt(process.env.NOTIFICATION_COOLDOWN_HOURS, 24),
    disableHoursOnBlock: parsePositiveInt(process.env.DISABLE_HOURS_ON_BLOCK, 12),
    thresholds: {
      minimumScore: parsePositiveInt(process.env.MINIMUM_SCORE, 65),
      minimumDiscountPercent: parsePositiveInt(process.env.MINIMUM_DISCOUNT_PERCENT, 18),
      minimumProfitSek: parsePositiveInt(process.env.MINIMUM_PROFIT_SEK, 400)
    },
    access: {
      adminToken: process.env.ADMIN_API_TOKEN?.trim() ?? ''
    },
    purchase: {
      // Optional Elgiganten sign-in. Staging works anonymously without these;
      // credentials only pre-fill delivery details to shorten manual checkout.
      elgigantenEmail: process.env.ELGIGANTEN_EMAIL?.trim() ?? '',
      elgigantenPassword: process.env.ELGIGANTEN_PASSWORD ?? '',
      sessionPath: process.env.ELGIGANTEN_SESSION_PATH?.trim() || path.join(rootDir, 'data', 'elgiganten-session.json')
    },
    sources: await loadSources(sourcesFile)
  };
}
