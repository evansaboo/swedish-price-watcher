// ═══════════════════════════════════════════════════════════════
// App — Fastify routes (thin handlers delegating to services)
// ═══════════════════════════════════════════════════════════════

import Fastify from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSourceEnabled } from './lib/utils.js';
import { createIndexHtmlBuilder } from './lib/assetVersion.js';
import { buildProductSummaries } from './services/dealEngine.js';
import { buildAffiliateUrl, decorateAffiliatePayload } from './services/affiliateLinks.js';
import { extractBearerToken } from './services/accessControl.js';
import {
  MAX_GROUPS,
  MAX_KEYWORDS_PER_GROUP,
  MAX_SUBQUERIES,
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  countSubqueries,
  normalizeHotlistConfig,
  normalizeWebhookUrl
} from './services/hotlistConfig.js';
import { getTaxonomyCatalog, searchCatalog } from './sources/elgigantenTaxonomy.js';
import { fetchAmazonSuggestions } from './sources/amazonHotlist.js';
import { getElgigantenBlockStatus, clearElgigantenBlock } from './sources/elgigantenAuth.js';
import {
  ensurePurchaseState,
  normalizePurchaseSettings,
  armListing,
  disarmListing,
  pruneExpiredArms,
  findArmByToken,
  checkArmUsable,
  recordAttempt,
  summarizePurchaseState
} from './services/purchaseEngine.js';
import {
  verifyDiscordRequest,
  handleInteraction,
  extractDiscordUserId
} from './services/discordInteractions.js';
import { createPurchaseService } from './services/purchaseService.js';
import { normalizeNvidiaConfig, ensureNvidiaConfig, DEFAULT_NVIDIA_CONFIG } from './services/nvidiaConfig.js';
import { GPU_DISPLAY_ORDER, CARD_METADATA } from './sources/nvidia.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ── Shared helpers ─────────────────────────────────────────────

// Feature 3 — wishlist target-price alert config. { enabled, webhook }
function normalizeWishlistAlertsConfig(raw) {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: cfg.enabled === true,
    webhook: typeof cfg.webhook === 'string' ? cfg.webhook.trim() : ''
  };
}

// Feature 3 — set or clear a wishlist item's target price on state.preferences.wishlistTargets.
function applyWishlistTarget(state, listingKey, rawTarget) {
  state.preferences = state.preferences ?? {};
  state.preferences.wishlistTargets = state.preferences.wishlistTargets ?? {};
  const target = Number(rawTarget);
  if (Number.isFinite(target) && target > 0) {
    state.preferences.wishlistTargets[listingKey] = Math.round(target);
  } else {
    delete state.preferences.wishlistTargets[listingKey];
  }
}

function normalizeCategoryKey(category) {
  return String(category ?? '').trim().toLowerCase();
}

function normalizeForSearch(str) {
  return String(str ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^ -\u007F\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesQuery(value, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const tokens = q.replace(/[^ -\u007F\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every(t => normalizeForSearch(value).includes(t));
}

function getFavoriteCategories(state) {
  return Array.isArray(state.preferences?.favoriteCategories)
    ? state.preferences.favoriteCategories.map(c => String(c).trim()).filter(Boolean)
    : [];
}

function getFavoriteCategorySet(state) {
  return new Set(getFavoriteCategories(state).map(normalizeCategoryKey));
}

function normalizeFavoriteCategories(categories) {
  const unique = new Map();
  for (const category of Array.isArray(categories) ? categories : []) {
    const label = String(category ?? '').trim();
    const key = normalizeCategoryKey(label);
    if (!key || unique.has(key)) continue;
    unique.set(key, label);
  }
  return [...unique.values()].sort((a, b) => a.localeCompare(b, 'sv-SE'));
}

function describeSourceStatus(source, sourceState = {}) {
  if (!source.enabled) return 'disabled';
  if (sourceState.disabledUntil) return 'cooling-down';
  if (sourceState.lastError) return 'error';
  if (sourceState.lastSuccessAt) return 'healthy';
  return 'idle';
}

function filterDeals(deals, query) {
  const search = String(query.search ?? '').trim().toLowerCase();
  const category = String(query.category ?? '').trim().toLowerCase();
  const condition = String(query.condition ?? '').trim().toLowerCase();
  const sourceId = String(query.sourceId ?? '').trim().toLowerCase();

  return deals.filter(deal =>
    (!category || normalizeCategoryKey(deal.category) === category) &&
    (!condition || deal.condition.toLowerCase() === condition) &&
    (!sourceId || deal.sourceId.toLowerCase() === sourceId) &&
    (matchesQuery(deal.title, search) || matchesQuery(deal.sourceLabel, search))
  );
}

function filterProducts(products, query) {
  const search = String(query.search ?? '').trim().toLowerCase();
  const category = String(query.category ?? '').trim().toLowerCase();
  const condition = String(query.condition ?? '').trim().toLowerCase();

  return products.filter(product =>
    (!category || normalizeCategoryKey(product.category) === category) &&
    (!condition || product.offers.some(o => o.condition.toLowerCase() === condition)) &&
    matchesQuery(product.title, search)
  );
}

// ── Scheduler validation ───────────────────────────────────────

function normalizeSchedulerUpdate(payload) {
  const normalized = {};

  if (payload?.enabled !== undefined) {
    normalized.enabled = Boolean(payload.enabled);
  }

  if (payload?.intervalMinutes !== undefined) {
    const val = Number.parseInt(String(payload.intervalMinutes), 10);
    if (!Number.isFinite(val) || val <= 0) throw new Error('intervalMinutes must be a positive integer.');
    normalized.intervalMinutes = val;
  }

  if (payload?.activeWindow !== undefined) {
    if (!payload.activeWindow || typeof payload.activeWindow !== 'object' || Array.isArray(payload.activeWindow)) {
      throw new Error('activeWindow must be an object.');
    }

    const aw = {};
    if (payload.activeWindow.enabled !== undefined) aw.enabled = Boolean(payload.activeWindow.enabled);
    if (payload.activeWindow.startTime !== undefined) {
      const s = String(payload.activeWindow.startTime).trim();
      if (!TIME_OF_DAY_PATTERN.test(s)) throw new Error('activeWindow.startTime must use HH:MM format.');
      aw.startTime = s;
    }
    if (payload.activeWindow.endTime !== undefined) {
      const e = String(payload.activeWindow.endTime).trim();
      if (!TIME_OF_DAY_PATTERN.test(e)) throw new Error('activeWindow.endTime must use HH:MM format.');
      aw.endTime = e;
    }
    if (payload.activeWindow.timeZone !== undefined) {
      const tz = String(payload.activeWindow.timeZone).trim();
      if (!tz) throw new Error('activeWindow.timeZone cannot be empty.');
      aw.timeZone = tz;
    }
    if (!Object.keys(aw).length) throw new Error('activeWindow must include enabled, startTime, endTime, or timeZone.');
    normalized.activeWindow = aw;
  }

  return normalized;
}

/**
 * Cheap liveness probe used by the Elgiganten retry endpoint, so the user gets
 * an immediate verdict on whether an IP change worked.
 *
 * 403 + `x-vercel-mitigated: deny` means this IP is firewall-blocked. A 429
 * challenge is NOT a block — it is the normal bot check that the browser-based
 * scraper solves, so it counts as healthy here.
 */
async function probeElgigantenReachability(timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://www.elgiganten.se/', {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' }
    });
    const mitigated = res.headers.get('x-vercel-mitigated');
    if (res.status === 403 && String(mitigated ?? '').toLowerCase() === 'deny') {
      return { status: 'denied', httpStatus: res.status };
    }
    if (res.status === 429) return { status: 'challenge', httpStatus: res.status };
    return { status: 'reachable', httpStatus: res.status };
  } catch (err) {
    return { status: 'unknown', error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function buildSchedulerStatus(schedulerState, lastRunStartedAt) {
  if (!schedulerState) return null;
  if (schedulerState.nextRunAt || !schedulerState.enabled) return schedulerState;

  const intervalMinutes = Number.parseInt(String(schedulerState.intervalMinutes ?? ''), 10);
  const lastRunTs = Date.parse(lastRunStartedAt ?? '');
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0 || Number.isNaN(lastRunTs)) return schedulerState;

  return { ...schedulerState, nextRunAt: new Date(lastRunTs + intervalMinutes * 60 * 1000).toISOString() };
}

// ── Route builder ──────────────────────────────────────────────

export async function buildApp({ config, store, productCache, scanState, triggerScan, cancelScan, scheduler, hotlist, fetcher, notifier, nvidia }) {
  const app = Fastify({ logger: false });
  const sourceById = new Map((config.sources ?? []).map((source) => [source.id, source]));
  let preferencesSaveQueue = Promise.resolve();

  async function persistPreferences() {
    if (typeof store.savePreferences === 'function') await store.savePreferences();
    else await store.save();
  }

  function savePreferences() {
    const pending = preferencesSaveQueue.then(persistPreferences, persistPreferences);
    preferencesSaveQueue = pending.catch(() => {});
    return pending;
  }

  function findListingProduct(listingKey) {
    const product = productCache.products?.find((entry) => entry.listingKey === listingKey);
    if (product) return product;
    const item = store.getState().items?.[listingKey];
    return item ? {
      ...item,
      currentPriceSek: item.latestPriceSek,
      sourceLabel: item.sourceLabel ?? item.sourceId
    } : null;
  }

  function isAdmin(request) {
    const configured = config.access?.adminToken;
    return Boolean(configured && extractBearerToken(request.headers) === configured);
  }

  // Gzip/brotli for JSON + static responses — product payloads run to hundreds
  // of KB and the app is typically served from a Pi over a Cloudflare tunnel.
  await app.register(fastifyCompress, { global: true, threshold: 1024 });

  try {
    await app.register(fastifyStatic, { root: config.publicDir, index: false });

    // Served ahead of the static wildcard so the markup always references the
    // current build of the assets, never a cached one from a previous deploy.
    const buildIndexHtml = createIndexHtmlBuilder(config.publicDir);
    const sendIndex = async (_, reply) => {
      try {
        const html = await buildIndexHtml();
        return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(html);
      } catch (error) {
        return reply.code(500).send({ error: `dashboard unavailable: ${error.message}` });
      }
    };
    app.get('/', sendIndex);
    app.get('/index.html', sendIndex);
  } catch (error) {
    console.error('[static]', error.message);
  }

  // ── Health ─────────────────────────────────────────────────────
  app.get('/health', async () => ({ ok: true }));

  // ── Version / deployment info ──────────────────────────────────
  app.get('/api/version', async (_, reply) => {
    try {
      const raw = await fs.readFile(path.join(ROOT_DIR, 'version.json'), 'utf8');
      return JSON.parse(raw);
    } catch {
      // version.json is generated at deploy time; fall back to package.json version
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(ROOT_DIR, 'package.json'), 'utf8'));
        return { version: pkg.version ?? '0.0.0', sha: null, shortSha: null, deployedAt: null };
      } catch {
        return reply.code(500).send({ error: 'Version info unavailable' });
      }
    }
  });

  // ── Status ─────────────────────────────────────────────────────
  app.get('/api/status', async () => {
    const state = store.getState();
    const sourceStatuses = config.sources.map(s => describeSourceStatus(s, state.sourceStates[s.id]));
    const schedulerState = buildSchedulerStatus(scheduler?.getState?.() ?? null, state.stats.lastScheduledRunStartedAt);

    return {
      isRunning: scanState.running,
      isCancelling: scanState.cancelling,
      lastError: scanState.lastError,
      lastRunStartedAt: state.stats.lastRunStartedAt,
      lastRunCompletedAt: state.stats.lastRunCompletedAt,
      lastRunSummary: state.stats.lastRunSummary,
      scanProgress: {
        startedAt: scanState.startedAt,
        completedSources: scanState.completedSources,
        totalSources: scanState.totalSources,
        sourceProgress: scanState.sourceProgress ?? {}
      },
      counts: {
        trackedItems: Object.keys(state.items).length,
        deals: state.deals.length,
        enabledSources: config.sources.filter(s => isSourceEnabled(s, state)).length,
        healthySources: sourceStatuses.filter(s => s === 'healthy').length,
        blockedSources: sourceStatuses.filter(s => s === 'error' || s === 'cooling-down').length,
        outletItems: state.deals.filter(d => d.condition === 'outlet').length,
        referencedItems: state.deals.filter(d => d.comparisonPriceSek > d.currentPriceSek).length,
        favoriteCategories: getFavoriteCategories(state).length
      },
      scheduler: schedulerState,
      hotlist: hotlist ? hotlist.getStatus() : null,
      elgigantenBlock: getElgigantenBlockStatus()
    };
  });

  /**
   * A hard block is tied to the egress IP, so the usual recovery is to change
   * it (VPN, proxy, new ISP lease). Once that is done the remaining cooldown is
   * stale — this clears it so the next scan retries immediately instead of
   * waiting out hours of an obsolete block.
   */
  app.post('/api/elgiganten/retry', async () => {
    const before = getElgigantenBlockStatus();
    clearElgigantenBlock();

    const state = store.getState();
    const cleared = [];
    for (const source of config.sources) {
      if (!source.id.startsWith('elgiganten')) continue;
      const sourceState = state.sourceStates[source.id];
      if (sourceState?.disabledUntil) {
        delete sourceState.disabledUntil;
        cleared.push(source.id);
      }
    }
    if (cleared.length) await store.save();

    // Clearing the cooldown alone gives no feedback on whether the IP change
    // actually worked. Probe the site so the answer is immediate rather than
    // "wait for the next scan and see".
    const probe = await probeElgigantenReachability();

    let message;
    if (probe.status === 'denied') {
      message = 'Cooldown cleared, but this IP is still blocked by Elgiganten. Change the egress IP (VPN, proxy or a new ISP lease) and try again.';
    } else if (probe.status === 'reachable') {
      message = 'Elgiganten is reachable again — the next scan will pick it up.';
    } else if (probe.status === 'challenge') {
      // 429 is the normal, solvable bot challenge; the browser path handles it.
      message = 'Cooldown cleared. Elgiganten is responding normally again — the next scan will pick it up.';
    } else {
      message = 'Cooldown cleared — the next scan will retry immediately.';
    }

    return {
      ok: true,
      wasBlocked: before.blocked,
      clearedSources: cleared,
      probe,
      stillBlocked: probe.status === 'denied',
      message
    };
  });

  // ── Categories ─────────────────────────────────────────────────
  app.get('/api/categories', async () => {
    const categories = new Set();
    for (const item of Object.values(store.getState().items)) {
      categories.add(item.category);
    }
    return [...categories].filter(Boolean).sort((a, b) => a.localeCompare(b, 'sv-SE'));
  });

  // ── Deals & Products (legacy) ──────────────────────────────────
  app.get('/api/deals', async (request) => decorateAffiliatePayload(filterDeals(store.getState().deals, request.query), sourceById));
  app.get('/api/products', async (request) => decorateAffiliatePayload(filterProducts(buildProductSummaries(store.getState()), request.query), sourceById));

  // ── Outlet Products (main endpoint — uses ProductCache) ────────
  app.get('/api/outlet-products', async (request) => {
    const state = store.getState();
    const favSet = getFavoriteCategorySet(state);
    const wishlistSet = new Set(state.preferences?.wishlist ?? []);
    const q = request.query;

    const result = productCache.query({
      search: q.search,
      category: q.category,
      store: q.store,
      campaign: q.campaign,
      favoritesOnly: q.favoritesOnly === 'true',
      discountedOnly: q.discountedOnly === 'true',
      referenceOnly: q.referenceOnly === 'true',
      newOnly: q.newOnly === 'true',
      hotOnly: q.hotOnly === 'true',
      wishlistOnly: q.wishlistOnly === 'true',
      minDiscountPercent: Number.parseInt(q.minDiscountPercent ?? '', 10),
      minPriceSek: Number.parseInt(q.minPriceSek ?? q.minPrice ?? '', 10),
      maxPriceSek: Number.parseInt(q.maxPriceSek ?? q.maxPrice ?? '', 10),
      sortBy: q.sortBy,
      sortDir: q.sortDir,
      page: Number.parseInt(q.page ?? '1', 10),
      pageSize: Number.parseInt(q.pageSize ?? '50', 10),
    }, favSet, state.stats.lastRunStartedAt, wishlistSet);
    return decorateAffiliatePayload(result, sourceById);
  });

  // ── Purchase / checkout ────────────────────────────────────────
  // Every route here is gated on ADMIN_API_TOKEN: these controls automate a
  // real basket on a real account, so they are never anonymously reachable.
  function findPurchasableItem(listingKey) {
    return store.getState().items?.[listingKey] ?? findListingProduct(listingKey) ?? null;
  }

  const purchaseService = createPurchaseService({
    config,
    getPreferences: () => store.getState().preferences,
    findItem: findPurchasableItem,
    save: savePreferences
  });
  const { purchaseState, stageListing, itemPrice } = purchaseService;

  app.get('/api/purchase', async (request, reply) => {
    if (!config.access?.adminToken) { reply.code(501); return { message: 'ADMIN_API_TOKEN is not configured.' }; }
    if (!isAdmin(request)) { reply.code(401); return { message: 'Unauthorized.' }; }
    const purchase = purchaseState();
    if (pruneExpiredArms(purchase)) await savePreferences();
    return {
      ...summarizePurchaseState(purchase),
      discordConfigured: Boolean(config.purchase?.discordPublicKey && config.purchase?.discordOwnerIds?.length),
      credentialsConfigured: Boolean(config.purchase?.elgigantenEmail && config.purchase?.elgigantenPassword)
    };
  });

  app.put('/api/purchase/settings', async (request, reply) => {
    if (!config.access?.adminToken) { reply.code(501); return { message: 'ADMIN_API_TOKEN is not configured.' }; }
    if (!isAdmin(request)) { reply.code(401); return { message: 'Unauthorized.' }; }
    const purchase = purchaseState();
    try {
      Object.assign(purchase, normalizePurchaseSettings(request.body ?? {}, purchase));
    } catch (error) {
      reply.code(400);
      return { message: error.message };
    }
    await savePreferences();
    return summarizePurchaseState(purchase);
  });

  app.post('/api/purchase/arm/:listingKey', async (request, reply) => {
    if (!config.access?.adminToken) { reply.code(501); return { message: 'ADMIN_API_TOKEN is not configured.' }; }
    if (!isAdmin(request)) { reply.code(401); return { message: 'Unauthorized.' }; }
    const { listingKey } = request.params;
    const item = findPurchasableItem(listingKey);
    if (!item) { reply.code(404); return { message: 'Listing not found.' }; }
    const purchase = purchaseState();
    try {
      const arm = armListing(purchase, {
        ...(request.body ?? {}),
        listingKey,
        label: request.body?.label ?? item.title
      });
      await savePreferences();
      const { token: _token, ...safe } = arm;
      return safe;
    } catch (error) {
      reply.code(400);
      return { message: error.message };
    }
  });

  app.delete('/api/purchase/arm/:listingKey', async (request, reply) => {
    if (!config.access?.adminToken) { reply.code(501); return { message: 'ADMIN_API_TOKEN is not configured.' }; }
    if (!isAdmin(request)) { reply.code(401); return { message: 'Unauthorized.' }; }
    const removed = disarmListing(purchaseState(), request.params.listingKey);
    if (!removed) { reply.code(404); return { message: 'Listing was not armed.' }; }
    await savePreferences();
    return { ok: true };
  });

  app.post('/api/purchase/stage/:listingKey', async (request, reply) => {
    if (!config.access?.adminToken) { reply.code(501); return { message: 'ADMIN_API_TOKEN is not configured.' }; }
    if (!isAdmin(request)) { reply.code(401); return { message: 'Unauthorized.' }; }
    const result = await stageListing({ listingKey: request.params.listingKey, via: 'dashboard' });
    await savePreferences();
    if (!result.ok) { reply.code(result.reason === 'unknown-listing' ? 404 : 400); return result; }
    return result;
  });

  // Discord button clicks. Needs the raw body for Ed25519 verification, so it
  // gets its own encapsulated scope with a string content-type parser.
  await app.register(async function discordInteractionRoutes(scope) {
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 65_536 }, (request, body, done) => {
      try {
        request.rawBody = body;
        done(null, JSON.parse(body));
      } catch (error) {
        error.statusCode = 400;
        done(error);
      }
    });

    scope.post('/api/discord/interactions', async (request, reply) => {
      const publicKey = config.purchase?.discordPublicKey;
      if (!publicKey) { reply.code(501); return { message: 'DISCORD_PUBLIC_KEY is not configured.' }; }

      // Discord requires a 401 on a bad signature before it will register the
      // endpoint, and this is the outer security boundary for the whole feature.
      const valid = verifyDiscordRequest({
        publicKey,
        signature: request.headers['x-signature-ed25519'],
        timestamp: request.headers['x-signature-timestamp'],
        rawBody: request.rawBody
      });
      if (!valid) { reply.code(401); return { message: 'Invalid request signature.' }; }

      const { response, followUp } = handleInteraction({
        interaction: request.body,
        ownerIds: config.purchase?.discordOwnerIds ?? [],
        onBuy: async ({ token, interaction }) => {
          const purchase = purchaseState();
          const arm = findArmByToken(purchase, token);
          if (!arm) return '❌ This button is no longer valid.';

          const item = findPurchasableItem(arm.listingKey);
          const usable = checkArmUsable(arm, { priceSek: itemPrice(item) });
          if (!usable.ok) {
            recordAttempt(purchase, { action: 'stage', listingKey: arm.listingKey, title: arm.label, status: 'refused', reason: usable.reason, via: 'discord' });
            await savePreferences();
            return `❌ Refused: ${usable.reason}${usable.cap ? ` (cap ${usable.cap} kr)` : ''}.`;
          }

          const result = await stageListing({ listingKey: arm.listingKey, arm, via: 'discord' });
          await savePreferences();
          if (!result.ok) return `❌ ${result.message}`;

          console.log(`[purchase] Staged ${arm.listingKey} for Discord user ${extractDiscordUserId(interaction)}`);
          return [
            `🛒 **Cart staged** — ${result.item.title}`,
            `Price: **${result.price} kr**${result.signedIn ? ' · signed in' : ' · anonymous cart'}`,
            '',
            `Complete payment here: ${result.checkoutUrl}`,
            '_Payment is never automated — confirm it yourself (BankID/3‑D Secure)._'
          ].join('\n');
        }
      });

      // Acknowledge inside Discord's 3s budget, then finish the slow work.
      if (followUp) setImmediate(() => followUp().catch((error) => console.error('[discord]', error.message)));
      return response;
    });
  });

  // Aggregate outbound tracking only; no visitor identifiers are stored.
  app.get('/api/out/:listingKey', async (request, reply) => {
    const product = findListingProduct(request.params.listingKey);
    if (!product?.url) { reply.code(404); return { message: 'Product not found.' }; }
    const source = sourceById.get(product.sourceId);
    const { buyUrl } = buildAffiliateUrl(product.url, source);
    return reply.redirect(buyUrl);
  });

  // ── CSV Export (same filters as /api/outlet-products) ──────────
  app.get('/api/export.csv', async (request, reply) => {
    const state = store.getState();
    const q = request.query;
    const rows = productCache.exportRows({
      search: q.search,
      category: q.category,
      store: q.store,
      campaign: q.campaign,
      favoritesOnly: q.favoritesOnly === 'true',
      discountedOnly: q.discountedOnly === 'true',
      referenceOnly: q.referenceOnly === 'true',
      newOnly: q.newOnly === 'true',
      hotOnly: q.hotOnly === 'true',
      wishlistOnly: q.wishlistOnly === 'true',
      minDiscountPercent: Number.parseInt(q.minDiscountPercent ?? '', 10),
      minPriceSek: Number.parseInt(q.minPriceSek ?? q.minPrice ?? '', 10),
      maxPriceSek: Number.parseInt(q.maxPriceSek ?? q.maxPrice ?? '', 10),
      sortBy: q.sortBy,
      sortDir: q.sortDir,
    }, getFavoriteCategorySet(state), state.stats.lastRunStartedAt, new Set(state.preferences?.wishlist ?? []));

    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['title', 'store', 'category', 'condition', 'price_sek', 'reference_price_sek', 'discount_sek', 'discount_percent', 'availability', 'first_seen', 'last_seen', 'url'];
    const lines = [header.join(',')];
    for (const p of rows) {
      lines.push([
        esc(p.title), esc(p.sourceLabel), esc(p.category), esc(p.conditionLabel ?? p.condition),
        p.currentPriceSek ?? '', p.initialPriceSek ?? '', p.discountSek ?? '', p.discountPercent ?? '',
        esc(p.availability), p.firstSeenAt ?? '', p.lastSeenAt ?? '', esc(p.url)
      ].join(','));
    }

    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="pricewatch-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    // BOM so Excel opens Swedish characters correctly
    return `﻿${lines.join('\n')}\n`;
  });

  // ── Outlet Categories (from cache) ─────────────────────────────
  app.get('/api/outlet-categories', async () => {
    const state = store.getState();
    return productCache.getCategoriesWithFavorites(getFavoriteCategorySet(state));
  });

  // ── Outlet Sources (from cache) ────────────────────────────────
  app.get('/api/outlet-sources', async () => productCache.sources);

  // ── Outlet Campaigns (from cache) ──────────────────────────────
  app.get('/api/outlet-campaigns', async () => productCache.campaigns);

  // ── Preferences ────────────────────────────────────────────────
  app.get('/api/preferences', async () => ({
    favoriteCategories: getFavoriteCategories(store.getState())
  }));

  app.put('/api/preferences/favorite-categories', async (request) => {
    const state = store.getState();
    const categories = normalizeFavoriteCategories(request.body?.categories);
    state.preferences = { ...(state.preferences ?? {}), favoriteCategories: categories };

    if (typeof store.savePreferences === 'function') {
      await store.savePreferences();
    } else {
      await store.save();
    }

    return { favoriteCategories: categories };
  });

  // ── Notification Settings ──────────────────────────────────────
  app.get('/api/notification-settings', async () => {
    const settings = store.getState().preferences?.notificationSettings ?? {};
    const wishlistAlerts = normalizeWishlistAlertsConfig(settings.wishlistAlerts);

    // Migrate legacy data to alertRules on first read
    if (!Array.isArray(settings.alertRules)) {
      const rules = [];
      const legacyWebhook = settings.keywordWebhook ?? '';
      for (const kw of (Array.isArray(settings.keywords) ? settings.keywords : [])) {
        if (!kw?.keyword) continue;
        const cats = Array.isArray(kw.categories) ? kw.categories : (kw.category ? [kw.category] : []);
        if (legacyWebhook) {
          rules.push({ id: kw.id ?? `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, label: kw.keyword, enabled: kw.enabled !== false, keywords: [kw.keyword], categories: cats, webhooks: [legacyWebhook] });
        }
      }
      for (const cw of (Array.isArray(settings.categoryWebhooks) ? settings.categoryWebhooks : [])) {
        if (!cw?.pattern || !cw?.webhook) continue;
        rules.push({ id: cw.id ?? `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, label: cw.label || cw.pattern, enabled: true, keywords: [], categories: [cw.pattern], webhooks: [cw.webhook] });
      }
      return { notificationsEnabled: settings.notificationsEnabled !== false, alertRules: rules, digest: settings.digest ?? null, wishlistAlerts };
    }

    return { notificationsEnabled: settings.notificationsEnabled !== false, alertRules: settings.alertRules, digest: settings.digest ?? null, wishlistAlerts };
  });

  app.put('/api/notification-settings', async (request, reply) => {
    const body = request.body ?? {};
    const state = store.getState();
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
    const existing = state.preferences?.notificationSettings ?? {};

    // Merge-by-default: only fields explicitly present in the body are replaced;
    // omitted fields preserve their existing persisted value. This prevents a
    // partial PUT (e.g. one that omits alertRules) from wiping other settings.
    const notificationsEnabled = has('notificationsEnabled')
      ? body.notificationsEnabled !== false
      : existing.notificationsEnabled !== false;

    const alertRules = has('alertRules')
      ? (Array.isArray(body.alertRules)
        ? body.alertRules.map(r => {
            const keywords = (Array.isArray(r.keywords) ? r.keywords : []).filter(k => typeof k === 'string' && k.trim()).map(k => k.trim());
            const categories = (Array.isArray(r.categories) ? r.categories : []).filter(c => typeof c === 'string' && c.trim()).map(c => c.trim());
            const webhooks = (Array.isArray(r.webhooks) ? r.webhooks : []).filter(w => typeof w === 'string' && w.trim()).map(w => w.trim());
            // Migrate old excludedSources → filteredSources with mode='exclude'
            const rawFiltered = Array.isArray(r.filteredSources) ? r.filteredSources : (Array.isArray(r.excludedSources) ? r.excludedSources : []);
            const filteredSources = rawFiltered.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
            const sourceFilterMode = r.sourceFilterMode === 'include' ? 'include' : 'exclude';
            return {
              id: typeof r.id === 'string' && r.id ? r.id : `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              label: typeof r.label === 'string' ? r.label.trim() : '',
              enabled: r.enabled !== false,
              keywords, categories, webhooks, filteredSources, sourceFilterMode,
              notifyPriceDrops: r.notifyPriceDrops !== false,
              ...(typeof r.minDiscountPercent === 'number' && Number.isFinite(r.minDiscountPercent) && r.minDiscountPercent > 0 ? { minDiscountPercent: r.minDiscountPercent } : {}),
              ...(typeof r.minPriceDropPercent === 'number' && Number.isFinite(r.minPriceDropPercent) && r.minPriceDropPercent >= 0 ? { minPriceDropPercent: r.minPriceDropPercent } : {})
            };
          })
        : [])
      : (Array.isArray(existing.alertRules) ? existing.alertRules : []);

    let digest;
    if (has('digest')) {
      const rawDigest = body.digest;
      digest = rawDigest && typeof rawDigest === 'object' && !Array.isArray(rawDigest)
        ? {
            enabled: rawDigest.enabled === true,
            time: TIME_OF_DAY_PATTERN.test(String(rawDigest.time ?? '').trim()) ? String(rawDigest.time).trim() : '08:00',
            webhook: typeof rawDigest.webhook === 'string' ? rawDigest.webhook.trim() : '',
            ...(Number.isFinite(Number(rawDigest.minScore)) && Number(rawDigest.minScore) > 0 ? { minScore: Number(rawDigest.minScore) } : {}),
            ...(Number.isFinite(Number(rawDigest.maxItems)) && Number(rawDigest.maxItems) > 0 ? { maxItems: Math.min(25, Number(rawDigest.maxItems)) } : {})
          }
        : null;
    } else {
      digest = existing.digest ?? null;
    }

    const wishlistAlerts = has('wishlistAlerts') ? normalizeWishlistAlertsConfig(body.wishlistAlerts) : normalizeWishlistAlertsConfig(existing.wishlistAlerts);

    state.preferences = { ...(state.preferences ?? {}), notificationSettings: { notificationsEnabled, alertRules, ...(digest ? { digest } : {}), wishlistAlerts } };

    if (typeof store.savePreferences === 'function') {
      await store.savePreferences();
    } else {
      await store.save();
    }

    return { notificationsEnabled, alertRules, digest, wishlistAlerts };
  });

  // ── Scheduler ──────────────────────────────────────────────────
  app.get('/api/scheduler', async (_, reply) => {
    if (!scheduler?.getState) { reply.code(404); return { message: 'Scheduler is unavailable.' }; }
    return scheduler.getState();
  });

  app.put('/api/scheduler', async (request, reply) => {
    if (!scheduler?.update) { reply.code(404); return { message: 'Scheduler is unavailable.' }; }

    let update;
    try { update = normalizeSchedulerUpdate(request.body ?? {}); }
    catch (error) { reply.code(400); return { message: error.message }; }

    if (!Object.keys(update).length) { reply.code(400); return { message: 'Provide enabled, intervalMinutes, or activeWindow.' }; }

    try { return await scheduler.update(update); }
    catch (error) { reply.code(400); return { message: error.message }; }
  });

  // ── Elgiganten hotlist ─────────────────────────────────────────
  // The hotlist is a continuous poller rather than a scheduled source, so it
  // has its own settings surface: what to watch, how often, and live status.
  function requireHotlist(reply) {
    if (!hotlist) {
      reply.code(404);
      return { message: 'Hotlist source is not configured.' };
    }
    return null;
  }

  app.get('/api/hotlist', async (_, reply) => {
    const missing = requireHotlist(reply);
    if (missing) return missing;
    const hotlistConfig = normalizeHotlistConfig(hotlist.getConfig());
    return {
      config: hotlistConfig,
      status: hotlist.getStatus(),
      subqueriesPerPoll: countSubqueries(hotlistConfig),
      limits: {
        minIntervalSeconds: MIN_INTERVAL_SECONDS,
        maxIntervalSeconds: MAX_INTERVAL_SECONDS,
        maxGroups: MAX_GROUPS,
        maxKeywordsPerGroup: MAX_KEYWORDS_PER_GROUP,
        maxSubqueries: MAX_SUBQUERIES
      }
    };
  });

  app.put('/api/hotlist', async (request, reply) => {
    const missing = requireHotlist(reply);
    if (missing) return missing;
    const body = request.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      reply.code(400);
      return { message: 'Expected a hotlist configuration object.' };
    }
    // Merge over the current config so a partial update (e.g. just the
    // interval) never silently wipes the watch groups.
    const merged = { ...normalizeHotlistConfig(hotlist.getConfig()), ...body };

    // Normalising an unrecognised webhook to '' would silently switch hotlist
    // notifications off, with the UI showing an empty field and no clue why.
    // A typo in a pasted URL should be an error, not a quiet disabling.
    if (Object.hasOwn(body, 'webhookUrl')) {
      const raw = String(body.webhookUrl ?? '').trim();
      if (raw && !normalizeWebhookUrl(raw)) {
        reply.code(400);
        return { message: 'Expected a Discord webhook URL (https://discord.com/api/webhooks/…).' };
      }
    }

    const updated = await hotlist.update(merged);
    return { config: updated, subqueriesPerPoll: countSubqueries(updated), status: hotlist.getStatus() };
  });

  app.post('/api/hotlist/poll', async (_, reply) => {
    const missing = requireHotlist(reply);
    if (missing) return missing;
    try {
      const result = await hotlist.pollNow();
      return { ok: true, result, status: hotlist.getStatus() };
    } catch (error) {
      reply.code(502);
      return { ok: false, message: error.message, status: hotlist.getStatus() };
    }
  });

  // Powers the category/brand pickers. The full taxonomy (~700 categories,
  // ~1000 brands) is one cached Algolia facet request, filtered server-side.
  app.get('/api/hotlist/catalog', async (request, reply) => {
    const missing = requireHotlist(reply);
    if (missing) return missing;
    if (!fetcher) { reply.code(503); return { message: 'Catalog lookup is unavailable.' }; }
    try {
      const catalog = await getTaxonomyCatalog(fetcher, { force: request.query?.refresh === 'true' });
      const limit = Math.min(Math.max(Number.parseInt(String(request.query?.limit ?? '1000'), 10) || 1000, 1), 2000);
      return searchCatalog(catalog, { query: request.query?.q ?? '', limit });
    } catch (error) {
      reply.code(502);
      return { message: `Could not load Elgiganten's category list: ${error.message}` };
    }
  });

  app.get('/api/hotlist/amazon-suggestions', async (request, reply) => {
    const prefix = request.query?.q ?? '';
    if (!prefix || !prefix.trim()) return [];
    try {
      const suggestions = await fetchAmazonSuggestions(prefix);
      return suggestions;
    } catch {
      return [];
    }
  });

  app.post('/api/bandit/reset-users', async (request, reply) => {
    try {
      const fs = await import('fs');
      const dbPath = process.env.BANDIT_DB_PATH || '/home/zpeedx/discount-bandit/database/database.sqlite';
      if (!fs.existsSync(dbPath)) {
        return { ok: false, message: 'Discount Bandit database not found at ' + dbPath };
      }
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath);
      const uCount = db.prepare('SELECT count(*) as count FROM users').get().count;
      db.prepare('DELETE FROM users').run();
      db.prepare('DELETE FROM sessions').run();
      db.prepare('DELETE FROM password_reset_tokens').run();
      db.prepare('DELETE FROM authentication_log').run();
      db.prepare('DELETE FROM breezy_sessions').run();
      db.prepare('DELETE FROM personal_access_tokens').run();
      db.close();
      return { ok: true, message: `Successfully cleared ${uCount} user(s). Discount Bandit is ready for fresh registration.` };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  app.get('/api/bandit/diagnostics', async (request, reply) => {
    try {
      const { execSync } = await import('child_process');
      const fs = await import('fs');
      let enumCode = '';
      let notificationClasses = '';
      let envNotifs = '';
      let linkPricesBlade = '';
      let productResourceFiles = '';
      try {
        notificationClasses = execSync('docker exec discount-bandit cat app/Filament/Resources/Users/Schemas/UserForm.php', { encoding: 'utf8', timeout: 5000 });
        envNotifs = execSync('docker exec discount-bandit cat app/Filament/Resources/Users/Pages/EditUser.php', { encoding: 'utf8', timeout: 5000 });
        linkPricesBlade = execSync('docker exec discount-bandit cat resources/views/filament/tables/columns/link-prices.blade.php', { encoding: 'utf8', timeout: 5000 });
        productResourceFiles = execSync('docker exec discount-bandit find app/Filament -name "*Product*"', { encoding: 'utf8', timeout: 5000 });
      } catch (e) {
        notificationClasses = 'exec error: ' + (e.stdout || e.stderr || e.message);
      }
      
      let storeStatuses = [];
      let usersList = [];
      let categorySchema = null;
      let categoriesList = [];
      let notificationSchema = null;
      let notificationSettings = [];
      let productSchema = null;
      let tableSchemas = [];
      let productsList = [];
      let linksList = [];
      const dbPath = process.env.BANDIT_DB_PATH || '/home/zpeedx/discount-bandit/database/database.sqlite';
      if (fs.existsSync(dbPath)) {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(dbPath);
        tableSchemas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        storeStatuses = db.prepare('SELECT DISTINCT status FROM stores').all();
        usersList = db.prepare('SELECT * FROM users').all();
        categorySchema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'categories'").get()?.sql;
        categoriesList = db.prepare('SELECT * FROM categories').all();
        notificationSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'notification_settings'").get()?.sql;
        notificationSettings = db.prepare('SELECT * FROM notification_settings').all();
        productSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'products'").get()?.sql;
        try { productsList = db.prepare('SELECT * FROM products').all(); } catch {}
        try { linksList = db.prepare('SELECT * FROM links').all(); } catch {}
        db.close();
      }

      let laravelLogs = '';
      const logDirs = ['/home/zpeedx/discount-bandit/logs', '/home/zpeedx/discount-bandit'];
      for (const d of logDirs) {
        try {
          if (fs.existsSync(d)) {
            const files = fs.readdirSync(d);
            for (const f of files) {
              if (f.endsWith('.log')) {
                const content = fs.readFileSync(`${d}/${f}`, 'utf8');
                const errorMatches = content.match(/\[\d{4}-\d{2}-\d{2}[^\]]+\]\s+production\.\w+:\s+[^\n]+/g) || [];
                laravelLogs += `\n=== ${f} Recent Error Messages (${errorMatches.length} total) ===\n` + errorMatches.slice(-10).join('\n') + '\n';
                laravelLogs += `\n--- ${f} Raw End (last 3000 chars) ---\n` + content.slice(-3000) + '\n';
              }
            }
          }
        } catch {}
      }
      return { ok: true, enumCode, notificationClasses, envNotifs, linkPricesBlade, productResourceFiles, storeStatuses, usersList, categorySchema, categoriesList, notificationSchema, notificationSettings, productSchema, tableSchemas, productsList, linksList, laravelLogs };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  app.get('/api/bandit/categories', async (request, reply) => {
    try {
      const fs = await import('fs');
      const dbPath = process.env.BANDIT_DB_PATH || '/home/zpeedx/discount-bandit/database/database.sqlite';
      if (!fs.existsSync(dbPath)) return { ok: false, message: 'DB not found' };
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath);
      const allCategories = db.prepare('SELECT * FROM categories').all();
      db.close();
      return { ok: true, categories: allCategories };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  app.post('/api/bandit/categories', async (request, reply) => {
    try {
      const fs = await import('fs');
      const dbPath = process.env.BANDIT_DB_PATH || '/home/zpeedx/discount-bandit/database/database.sqlite';
      if (!fs.existsSync(dbPath)) return { ok: false, message: 'DB not found' };
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath);
      
      const tableInfo = db.prepare('PRAGMA table_info(categories)').all();
      const colNames = tableInfo.map(c => c.name);
      
      let userId = 2; // Default to Evan if available
      const user = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
      if (user) userId = user.id;

      const defaultCategories = [
        { name: 'GPU (Graphics Cards)', color: '#8b5cf6' },
        { name: 'CPU (Processors)', color: '#3b82f6' },
        { name: 'RAM (Memory)', color: '#06b6d4' },
        { name: 'Motherboards (Moderkort)', color: '#10b981' },
        { name: 'Storage & SSD (Lagring)', color: '#14b8a6' },
        { name: 'Power Supplies (PSU)', color: '#f59e0b' },
        { name: 'PC Cases (Chassi)', color: '#64748b' },
        { name: 'Cooling & Fans (Kylning)', color: '#0ea5e9' },
        { name: 'Monitors (Skärmar)', color: '#a855f7' },
        { name: 'Laptops & Computers (Datorer)', color: '#6366f1' },
        { name: 'Peripherals (Mus & Tangentbord)', color: '#ec4899' },
        { name: 'Audio & Headsets (Ljud & Headset)', color: '#f43f5e' },
        { name: 'Price Drops & Big Deals (Prissänkningar)', color: '#ef4444' },
        { name: 'Full Set (Kompletta Datorer / Prebuilts)', color: '#10b981' },
        { name: 'Networking (Nätverk & Routers)', color: '#84cc16' }
      ];

      const categoriesToAdd = Array.isArray(request.body?.categories) && request.body.categories.length > 0
        ? request.body.categories
        : defaultCategories;

      const inserted = [];
      for (const cat of categoriesToAdd) {
        const existing = db.prepare('SELECT id FROM categories WHERE name = ?').get(cat.name);
        if (!existing) {
          const insertObj = {
            name: cat.name,
            color: cat.color || '#3b82f6',
            user_id: userId,
            created_at: new Date().toISOString().replace('T', ' ').substring(0, 19),
            updated_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
          };

          const cols = Object.keys(insertObj).join(', ');
          const placeholders = Object.keys(insertObj).map(k => '@' + k).join(', ');
          db.prepare(`INSERT INTO categories (${cols}) VALUES (${placeholders})`).run(insertObj);
          inserted.push(cat.name);
        }
      }

      const allCategories = db.prepare('SELECT * FROM categories').all();
      db.close();
      return { ok: true, insertedCount: inserted.length, inserted, allCategories };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  app.post('/api/bandit/fix-stores', async (request, reply) => {
    try {
      const fs = await import('fs');
      const dbPath = process.env.BANDIT_DB_PATH || '/home/zpeedx/discount-bandit/database/database.sqlite';
      if (!fs.existsSync(dbPath)) return { ok: false, message: 'DB not found' };
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath);
      // Check what valid enum values are from request body or default
      const activeValue = request.body?.active || 'active';
      const inactiveValue = request.body?.inactive || 'disabled';
      const res = db.prepare(`UPDATE stores SET status = ? WHERE status = 'enabled'`).run(activeValue);
      db.close();
      return { ok: true, changes: res.changes, updatedTo: activeValue };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  app.post('/api/bandit/patch-product-blade', async (request, reply) => {
    try {
      const { execSync } = await import('child_process');
      const bladePath = 'resources/views/filament/tables/columns/link-prices.blade.php';
      let content = '';
      try {
        content = execSync(`docker exec discount-bandit cat ${bladePath}`, { encoding: 'utf8', timeout: 5000 });
      } catch (e) {
        return { ok: false, error: 'Failed to read blade file: ' + (e.stderr || e.message) };
      }

      let patched = content;
      if (request.body?.content) {
        patched = request.body.content;
      } else {
        // Auto-fix: Ensure all foreach loops in link-prices.blade.php check that their argument is iterable and not null
        // Match @foreach($var as ...) and wrap with @if(!empty($var) && (is_array($var) || is_object($var)))
        patched = content.replace(/@foreach\s*\(\s*([^)]+?)\s+as\s+([^)]+?)\)/g, (match, expr, rest) => {
          const cleanExpr = expr.trim();
          return `@if(!empty(${cleanExpr}) && (is_array(${cleanExpr}) || is_object(${cleanExpr})))\n@foreach(${cleanExpr} as ${rest})\n`;
        });
        if (patched !== content) {
          patched = patched.replace(/@endforeach/g, '@endforeach\n@endif');
        }
      }

      const b64 = Buffer.from(patched, 'utf8').toString('base64');
      execSync(`docker exec discount-bandit sh -c "echo '${b64}' | base64 -d > ${bladePath}"`, { timeout: 5000 });
      try {
        execSync('docker exec discount-bandit php artisan view:clear', { timeout: 5000 });
      } catch {}

      return { ok: true, original: content, patched };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  app.post('/api/bandit/seed-products', async (request, reply) => {
    try {
      const fs = await import('fs');
      const dbPath = process.env.BANDIT_DB_PATH || '/home/zpeedx/discount-bandit/database/database.sqlite';
      if (!fs.existsSync(dbPath)) return { ok: false, message: 'DB not found' };
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath);

      const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const user = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
      const userId = user ? user.id : 2;

      const catGpu = db.prepare("SELECT id FROM categories WHERE name LIKE '%GPU%'").get();
      const catRam = db.prepare("SELECT id FROM categories WHERE name LIKE '%RAM%'").get();
      const catFull = db.prepare("SELECT id FROM categories WHERE name LIKE '%Full Set%'").get();

      const items = [
        { name: 'NVIDIA GeForce RTX 5080 FE', catId: catGpu?.id },
        { name: 'Corsair Vengeance DDR5 32GB (2x16GB) 6000MHz', catId: catRam?.id },
        { name: 'Gaming PC Full Build (Ryzen 7 7800X3D / RTX 4070 / 32GB)', catId: catFull?.id }
      ];

      const created = [];
      for (const item of items) {
        let existing = db.prepare('SELECT id FROM products WHERE name = ?').get(item.name);
        let productId;
        if (!existing) {
          const res = db.prepare(`
            INSERT INTO products (name, status, user_id, is_favourite, notifications_sent, created_at, updated_at)
            VALUES (?, 'active', ?, 0, 0, ?, ?)
          `).run(item.name, userId, now, now);
          productId = res.lastInsertRowid;
          created.push({ id: productId, name: item.name });
        } else {
          productId = existing.id;
        }

        if (item.catId && productId) {
          const hasPivot = db.prepare('SELECT * FROM category_product WHERE product_id = ? AND category_id = ?').get(productId, item.catId);
          if (!hasPivot) {
            try {
              db.prepare('INSERT INTO category_product (product_id, category_id) VALUES (?, ?)').run(productId, item.catId);
            } catch {}
          }
        }
      }

      const allProducts = db.prepare('SELECT * FROM products').all();
      db.close();
      return { ok: true, created, allProducts };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  app.post('/api/bandit/discord-webhook', async (request, reply) => {
    try {
      const body = request.body || {};
      const prefs = store?.getState?.()?.preferences || {};
      const targetWebhook = request.query?.webhook || prefs?.hotlist?.discordWebhookUrl || prefs?.discordWebhookUrl || config?.discordWebhookUrl || process.env.DISCORD_WEBHOOK_URL;
      
      if (!targetWebhook) {
        reply.code(400);
        return { ok: false, error: 'No Discord webhook configured on server or in query' };
      }

      const title = body.title || 'Discount Bandit Price Drop';
      let rawBody = body.body || '';
      
      let productUrl = null;
      const urlMatch = rawBody.match(/Product URL:\s*\.?\s*(https?:\/\/[^\s<]+)/i);
      if (urlMatch) {
        productUrl = urlMatch[1].trim();
      }

      let cleanText = rawBody
        .replace(/<br\s*[\/]?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/Product URL:\s*\.?\s*https?:\/\/[^\s]+/gi, '')
        .trim();

      const image = Array.isArray(body.attach) && body.attach[0] ? body.attach[0] : null;

      const embed = {
        title: title,
        url: productUrl || undefined,
        description: cleanText,
        color: 0x8b5cf6,
        timestamp: new Date().toISOString(),
        footer: { text: '🎯 Discount Bandit • Price Drop Alert' }
      };

      if (image && typeof image === 'string' && image.startsWith('http')) {
        embed.thumbnail = { url: image };
      }

      const discordPayload = {
        username: 'Discount Bandit',
        avatar_url: 'https://raw.githubusercontent.com/Cybrarist/Discount-Bandit/refs/heads/master/storage/app/public/bandit.png',
        embeds: [embed]
      };

      const discordRes = await fetch(targetWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordPayload)
      });

      return { ok: discordRes.ok, status: discordRes.status };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  app.post('/api/bandit/enable-discord', async (request, reply) => {
    try {
      const fs = await import('fs');
      const dbPath = process.env.BANDIT_DB_PATH || '/home/zpeedx/discount-bandit/database/database.sqlite';
      if (!fs.existsSync(dbPath)) return { ok: false, message: 'DB not found' };
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath);

      const forwarderUrl = request.body?.appriseUrl || 'https://deals.evansaboo.com/api/bandit/discord-webhook';
      
      const user = db.prepare('SELECT id, notification_settings FROM users ORDER BY id ASC LIMIT 1').get();
      if (!user) {
        db.close();
        return { ok: false, message: 'No user found' };
      }

      let settings = {};
      try {
        settings = JSON.parse(user.notification_settings || '{}');
      } catch {}

      settings.apprise_url = forwarderUrl;
      db.prepare('UPDATE users SET notification_settings = ? WHERE id = ?').run(JSON.stringify(settings), user.id);
      db.close();

      return { ok: true, userId: user.id, appriseUrl: forwarderUrl };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  // ── NVIDIA Founders Edition (Notify-FE integration & scheduler) ─
  app.get('/api/nvidia/config', async () => {
    const state = store.getState();
    const cfg = normalizeNvidiaConfig(state.preferences?.nvidiaFe ?? {});
    const pollerStatus = nvidia?.getStatus ? nvidia.getStatus() : { running: false };

    const availableCards = GPU_DISPLAY_ORDER.map((key) => ({
      key,
      name: CARD_METADATA[key]?.shortName || `RTX ${key} FE`,
      fullName: CARD_METADATA[key]?.name || `NVIDIA GeForce RTX ${key} Founders Edition`,
      msrpSek: CARD_METADATA[key]?.msrpSek || 0,
      imageUrl: CARD_METADATA[key]?.imageUrl || null
    }));

    return {
      ok: true,
      config: cfg,
      poller: pollerStatus,
      availableCards
    };
  });

  app.post('/api/nvidia/config', async (request, reply) => {
    try {
      const body = request.body || {};
      const state = store.getState();
      const current = state.preferences?.nvidiaFe ?? {};
      const updated = normalizeNvidiaConfig({ ...current, ...body });
      state.preferences = { ...(state.preferences ?? {}), nvidiaFe: updated };
      await (store.savePreferences ?? store.save).call(store);

      if (nvidia?.updateConfig) {
        await nvidia.updateConfig(updated);
      } else if (nvidia?.poller) {
        nvidia.poller.restart();
      }

      return { ok: true, config: updated };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  app.post('/api/nvidia/test-webhook', async (request, reply) => {
    try {
      const state = store.getState();
      const webhookUrl = request.body?.webhookUrl || state.preferences?.nvidiaFe?.discordWebhookUrl || config.discordWebhookUrl;
      if (!webhookUrl) {
        reply.code(400);
        return { ok: false, error: 'No Discord webhook URL provided or configured' };
      }

      if (notifier?.testNvidiaWebhook) {
        await notifier.testNvidiaWebhook({ webhookUrl });
      } else {
        const { DiscordNotifier } = await import('./services/notifier.js');
        const testNotifier = new DiscordNotifier({ webhookUrl });
        await testNotifier.testNvidiaWebhook({ webhookUrl });
      }

      return { ok: true, message: 'Test notification sent successfully to Discord' };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  app.get('/api/nvidia/status', async (request, reply) => {
    try {
      const state = store.getState();
      const cfg = normalizeNvidiaConfig(state.preferences?.nvidiaFe ?? {});
      const locale = String(request.query?.locale || cfg.locale || 'sv-se').toLowerCase();

      const pollerStatus = nvidia?.getStatus ? nvidia.getStatus() : null;
      if (pollerStatus?.cards?.length && pollerStatus.locale === locale && request.query?.refresh !== 'true') {
        return {
          ok: true,
          locale,
          poller: pollerStatus,
          checkedAt: pollerStatus.lastSuccessAt || new Date().toISOString(),
          cards: pollerStatus.cards
        };
      }

      const { fetchDynamicSkus, resolveCardSku, queryNvidiaFeInventory, GPU_DISPLAY_ORDER, CARD_METADATA } = await import('./sources/nvidia.js');
      const dynamicSkus = await fetchDynamicSkus();

      const cardSkus = GPU_DISPLAY_ORDER.map((cardKey) => ({
        cardKey,
        sku: resolveCardSku(cardKey, locale, dynamicSkus),
        meta: CARD_METADATA[cardKey]
      }));

      const uniqueSkus = Array.from(new Set(cardSkus.map((c) => c.sku)));
      const inventory = await queryNvidiaFeInventory(uniqueSkus, locale, { timeoutMs: 15000 });

      const cards = cardSkus.map(({ cardKey, sku, meta }) => {
        const raw = inventory.results?.[sku];
        const item = raw?.listMap?.[0] || null;
        const isActive = item?.is_active === 'true' || item?.is_active === true;
        const parsedPrice = item?.price ? Number(item.price) : NaN;
        const isRealPrice = Number.isFinite(parsedPrice) && parsedPrice > 0 && parsedPrice < 900000;
        const isMonitored = cfg.monitoredCards.includes(cardKey);

        return {
          cardKey,
          name: meta?.shortName || `RTX ${cardKey} FE`,
          fullName: meta?.name || `NVIDIA GeForce RTX ${cardKey} Founders Edition`,
          sku,
          available: isActive,
          api_reachable: Boolean(raw && !raw.error && raw.success !== false),
          api_error: raw?.error || (raw ? null : (inventory.error || 'timeout')),
          isMonitored,
          product_url: isActive && item?.product_url ? item.product_url : null,
          store_url: meta?.defaultUrl,
          priceSek: isActive && isRealPrice ? parsedPrice : meta?.msrpSek,
          msrpSek: meta?.msrpSek,
          imageUrl: meta?.imageUrl,
          last_checked: new Date().toISOString()
        };
      });

      return {
        ok: true,
        locale,
        poller: pollerStatus,
        checkedAt: new Date().toISOString(),
        cards
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  // ── Sources ────────────────────────────────────────────────────
  // Standard scan sources only. Hotlist sources (Elgiganten, Amazon, etc.) are continuous pollers
  // configured exclusively via /api/hotlist and have their own lifecycles.
  const isHotlist = (s) => s?.type?.endsWith('-hotlist') || s?.id?.endsWith('-hotlist');

  app.get('/api/sources', async () => {
    const state = store.getState();
    return (config.sources ?? [])
      .filter(source => !isHotlist(source))
      .map(source => {
        const schedulerEnabled = isSourceEnabled(source, state);
        return {
          id: source.id,
          label: source.label,
          type: source.type,
          enabled: source.enabled,
          schedulerEnabled,
          status: describeSourceStatus({ ...source, enabled: schedulerEnabled }, state.sourceStates[source.id]),
          lastSuccessAt: state.sourceStates[source.id]?.lastSuccessAt ?? null,
          lastCount: state.sourceStates[source.id]?.lastCount ?? null,
          lastError: state.sourceStates[source.id]?.lastError ?? null,
          disabledUntil: state.sourceStates[source.id]?.disabledUntil ?? null
        };
      });
  });

  app.patch('/api/sources/:id', async (request, reply) => {
    const sourceId = request.params.id;
    const source = (config.sources ?? []).find(s => s.id === sourceId && !isHotlist(s));
    if (!source) { reply.code(404); return { message: `Source not found: ${sourceId}` }; }
    if (typeof request.body?.enabled !== 'boolean') { reply.code(400); return { message: 'Provide { enabled: true|false }' }; }

    const state = store.getState();
    state.preferences = state.preferences ?? {};
    state.preferences.sourceOverrides = state.preferences.sourceOverrides ?? {};
    state.preferences.sourceOverrides[sourceId] = request.body.enabled;

    if (typeof store.savePreferences === 'function') {
      await store.savePreferences();
    } else {
      await store.save();
    }

    return { id: sourceId, label: source.label, enabled: request.body.enabled };
  });

  // ── Price History ───────────────────────────────────────────────
  app.get('/api/price-history/:listingKey', async (request, reply) => {
    const { listingKey } = request.params;
    const state = store.getState();
    const item = state.items[listingKey];
    if (!item) {
      // Check archived history
      const archived = state.itemHistory?.[listingKey];
      if (archived) return { listingKey, history: archived.history ?? [], archived: true };
      reply.code(404);
      return { message: 'Product not found.' };
    }
    // Use in-memory history if populated (built during scans); otherwise query DB directly.
    const history = item.history?.length > 0 ? item.history : store.getItemHistory(listingKey);
    return {
      listingKey,
      title: item.title,
      currentPriceSek: item.latestPriceSek,
      lowestPriceSek: item.lowestPriceSek,
      highestPriceSek: item.highestPriceSek,
      history
    };
  });

  // ── Wishlist ──────────────────────────────────────────────────
  app.get('/api/wishlist', async () => {
    const state = store.getState();
    return { items: state.preferences?.wishlist ?? [], targets: state.preferences?.wishlistTargets ?? {} };
  });

  app.post('/api/wishlist/:listingKey', async (request, reply) => {
    const { listingKey } = request.params;
    const state = store.getState();
    const item = state.items[listingKey];
    if (!item) { reply.code(404); return { message: 'Product not found.' }; }

    state.preferences = state.preferences ?? {};
    const wishlist = state.preferences.wishlist ?? [];
    if (!wishlist.includes(listingKey)) {
      wishlist.push(listingKey);
      state.preferences.wishlist = wishlist;
    }
    // Optional target price (Feature 3). A value of 0/null clears the target.
    if (request.body && Object.prototype.hasOwnProperty.call(request.body, 'targetPriceSek')) {
      applyWishlistTarget(state, listingKey, request.body.targetPriceSek);
    }
    if (typeof store.savePreferences === 'function') {
      await store.savePreferences();
    } else {
      await store.save();
    }
    return { ok: true, listingKey, wishlisted: true, targetPriceSek: state.preferences.wishlistTargets?.[listingKey] ?? null };
  });

  // Set/clear the target price for a wishlisted item (Feature 3).
  app.put('/api/wishlist/:listingKey/target', async (request, reply) => {
    const { listingKey } = request.params;
    const state = store.getState();
    state.preferences = state.preferences ?? {};
    const wishlist = state.preferences.wishlist ?? [];
    if (!wishlist.includes(listingKey)) { reply.code(404); return { message: 'Item is not on the wishlist.' }; }

    applyWishlistTarget(state, listingKey, request.body?.targetPriceSek);
    if (typeof store.savePreferences === 'function') {
      await store.savePreferences();
    } else {
      await store.save();
    }
    return { ok: true, listingKey, targetPriceSek: state.preferences.wishlistTargets?.[listingKey] ?? null };
  });

  app.delete('/api/wishlist/:listingKey', async (request, reply) => {
    const { listingKey } = request.params;
    const state = store.getState();
    state.preferences = state.preferences ?? {};
    const wishlist = state.preferences.wishlist ?? [];
    const idx = wishlist.indexOf(listingKey);
    if (idx !== -1) {
      wishlist.splice(idx, 1);
      state.preferences.wishlist = wishlist;
    }
    // Removing from the wishlist also clears any target.
    if (state.preferences.wishlistTargets && listingKey in state.preferences.wishlistTargets) {
      delete state.preferences.wishlistTargets[listingKey];
    }
    if (typeof store.savePreferences === 'function') {
      await store.savePreferences();
    } else {
      await store.save();
    }
    return { ok: true, listingKey, wishlisted: false };
  });

  // ── Scan Control ───────────────────────────────────────────────
  app.post('/api/run', async (request, reply) => {
    if (scanState.running) { reply.code(409); return { ok: false, message: 'A scan is already running.' }; }

    const rawSourceIds = request.body?.sourceIds;
    const sourceIds = Array.isArray(rawSourceIds) && rawSourceIds.length > 0
      ? rawSourceIds.map(id => String(id).trim()).filter(Boolean)
      : null;

    if (sourceIds) {
      const knownIds = new Set(config.sources.map(s => s.id));
      const unknown = sourceIds.filter(id => !knownIds.has(id));
      if (unknown.length) { reply.code(400); return { ok: false, message: `Unknown source IDs: ${unknown.join(', ')}` }; }
    }

    // The hotlist is not part of a scan — it has its own continuous poller —
    // so route a request for it to an immediate poll instead of failing.
    const hotlistRequested = Boolean(hotlist && sourceIds?.includes(hotlist.source.id));
    const scanSourceIds = hotlistRequested
      ? sourceIds.filter((id) => id !== hotlist.source.id)
      : sourceIds;

    if (hotlistRequested) {
      hotlist.pollNow().catch(() => {});
      if (!scanSourceIds.length) {
        reply.code(202);
        return { ok: true, started: true, message: 'Hotlist poll started.' };
      }
    }

    const canRun = scanSourceIds
      ? config.sources.some(s => scanSourceIds.includes(s.id) && s.enabled)
      : config.sources.some(s => isSourceEnabled(s, store.getState()));

    if (!canRun) {
      reply.code(400);
      return {
        ok: false,
        message: scanSourceIds
          ? `None of the requested sources are enabled: ${scanSourceIds.join(', ')}`
          : 'No sources are enabled. Add or enable a source in config/sources.json.'
      };
    }

    triggerScan('manual', { sourceIds: scanSourceIds }).catch(() => {});
    reply.code(202);
    return { ok: true, started: true, message: scanSourceIds ? `Scanning: ${scanSourceIds.join(', ')}` : 'Live scan started.' };
  });

  app.post('/api/cancel', async (request, reply) => {
    if (!scanState.running) { reply.code(409); return { ok: false, message: 'No scan is currently running.' }; }
    const wasCancelled = cancelScan();
    return { ok: wasCancelled, message: wasCancelled ? 'Scan cancellation requested.' : 'No scan is running.' };
  });

  // Remote deploy webhook — pull latest code from git and restart via systemd.
  // Requires DEPLOY_SECRET env var to be set; pass it as ?secret=<value> or Authorization: Bearer <value>.
  app.post('/api/deploy', async (request, reply) => {
    const secret = process.env.DEPLOY_SECRET?.trim();
    if (!secret) { reply.code(501); return { ok: false, message: 'DEPLOY_SECRET not configured.' }; }

    const provided = request.query?.secret
      || (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (provided !== secret) { reply.code(401); return { ok: false, message: 'Unauthorized.' }; }

    reply.send({ ok: true, message: 'Deploy triggered — pulling latest code and restarting.' });

    // Run asynchronously after response is sent
    setImmediate(async () => {
      const { execSync } = await import('child_process');
      const { writeFileSync } = await import('fs');
      const cwd = process.cwd();
      try {
        console.log('[deploy] git pull...');
        execSync('git pull origin main', { cwd, stdio: 'inherit' });

        console.log('[deploy] npm install...');
        execSync('npm install --silent --no-audit', { cwd, stdio: 'inherit' });

        console.log('[deploy] writing version.json...');
        const sha = execSync('git rev-parse HEAD', { cwd }).toString().trim();
        const shortSha = execSync('git rev-parse --short HEAD', { cwd }).toString().trim();
        const message = execSync('git log -1 --pretty=%s', { cwd }).toString().trim();
        const author = execSync('git log -1 --pretty=%an', { cwd }).toString().trim();
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd }).toString().trim();
        writeFileSync(`${cwd}/version.json`, JSON.stringify(
          { sha, shortSha, message, author, branch, deployedAt: new Date().toISOString() }, null, 2));

        console.log(`[deploy] restarting service (${shortSha})...`);
        // NOTE: must match the Pi's passwordless-sudo rule EXACTLY
        // ("sudo systemctl restart swedish-price-watcher"); any extra flag
        // (e.g. --no-block) triggers a password prompt and the restart fails.
        // systemd SIGTERMs this process mid-call so execSync throws, but the
        // restart still proceeds — the catch below logs it harmlessly.
        execSync('sudo systemctl restart swedish-price-watcher', { stdio: 'inherit' });
      } catch (err) {
        console.error('[deploy] Failed:', err.message);
      }
    });
  });

  return app;
}
