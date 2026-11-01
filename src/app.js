// ═══════════════════════════════════════════════════════════════
// App — Fastify routes (thin handlers delegating to services)
// ═══════════════════════════════════════════════════════════════

import Fastify from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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
import { getElgigantenBlockStatus, clearElgigantenBlock } from './sources/elgigantenAuth.js';
import {
  normalizePurchaseSettings,
  armListing,
  disarmListing,
  pruneExpiredArms,
  summarizePurchaseState
} from './services/purchaseEngine.js';
import { createPurchaseService } from './services/purchaseService.js';
import { normalizeNvidiaConfig } from './services/nvidiaConfig.js';
import { GPU_DISPLAY_ORDER, CARD_METADATA } from './sources/nvidia.js';
import {
  DEFAULT_KOMPLETT_DEMO_CONFIG,
  KOMPLETT_DEMO_CATALOG,
  MAX_INTERVAL_MINUTES as KOMPLETT_DEMO_MAX_INTERVAL_MINUTES,
  MAX_JITTER_PCT as KOMPLETT_DEMO_MAX_JITTER_PCT,
  MAX_MONTHLY_USD_LIMIT as KOMPLETT_DEMO_MAX_MONTHLY_USD,
  MIN_INTERVAL_MINUTES as KOMPLETT_DEMO_MIN_INTERVAL_MINUTES,
  MIN_MONTHLY_USD as KOMPLETT_DEMO_MIN_MONTHLY_USD,
  findUnknownCategoryIds,
  isMaskedWebhookUrl,
  normalizeKomplettDemoConfig,
  publicKomplettDemoConfig
} from './services/komplettDemoConfig.js';
import { buildKomplettDemoUrl } from './sources/komplett.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Commit this process was started from. /health reports it so the deploy
// workflow can tell the restarted instance apart from the old one.
const RUNNING_SHA = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
})();

// ── Shared helpers ─────────────────────────────────────────────

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
    (matchesQuery(product.title, search)
      || product.offers.some((offer) => matchesQuery(offer.description, search)))
  );
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

// ── Route builder ──────────────────────────────────────────────

export async function buildApp({ config, store, productCache, hotlist, fetcher, notifier, nvidia, komplettDemo }) {
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

    // Shoelace web components, vendored from node_modules so the dashboard
    // needs no CDN at runtime. The version is pinned in package.json: entry
    // files here are not content-hashed, so upgrade it deliberately.
    await app.register(fastifyStatic, {
      root: path.join(ROOT_DIR, 'node_modules/@shoelace-style/shoelace/cdn'),
      prefix: '/vendor/shoelace/',
      decorateReply: false,
      index: false
    });

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
  app.get('/health', async () => ({ ok: true, sha: RUNNING_SHA }));

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
  // The scan machinery is gone; this reports what the dashboard header needs.
  app.get('/api/status', async () => {
    const state = store.getState();
    return {
      counts: {
        trackedItems: Object.keys(state.items).length,
        listedProducts: productCache.products?.length ?? 0,
        deals: state.deals.length
      },
      hotlist: hotlist ? hotlist.getStatus() : null,
      elgigantenBlock: getElgigantenBlockStatus()
    };
  });

  /**
   * A hard block is tied to the egress IP, so the usual recovery is to change
   * it (VPN, proxy, new ISP lease). Once that is done the remaining cooldown is
   * stale — this clears it so the next hotlist poll retries immediately instead of
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
    // "wait for the next poll and see".
    const probe = await probeElgigantenReachability();

    let message;
    if (probe.status === 'denied') {
      message = 'Cooldown cleared, but this IP is still blocked by Elgiganten. Change the egress IP (VPN, proxy or a new ISP lease) and try again.';
    } else if (probe.status === 'reachable') {
      message = 'Elgiganten is reachable again — the next hotlist poll will pick it up.';
    } else if (probe.status === 'challenge') {
      // 429 is the normal, solvable bot challenge; the browser path handles it.
      message = 'Cooldown cleared. Elgiganten is responding normally again — the next hotlist poll will pick it up.';
    } else {
      message = 'Cooldown cleared — the next hotlist poll will retry immediately.';
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
  // Elgiganten hotlist finds and Komplett demo products.
  function listingParams(q) {
    return {
      search: q.search,
      category: q.category,
      store: q.store,
      campaign: q.campaign,
      discountedOnly: q.discountedOnly === 'true',
      referenceOnly: q.referenceOnly === 'true',
      newOnly: q.newOnly === 'true',
      hotOnly: q.hotOnly === 'true',
      wishlistOnly: q.wishlistOnly === 'true',
      minDiscountPercent: Number.parseInt(q.minDiscountPercent ?? '', 10),
      minPriceSek: Number.parseInt(q.minPriceSek ?? q.minPrice ?? '', 10),
      maxPriceSek: Number.parseInt(q.maxPriceSek ?? q.maxPrice ?? '', 10),
      sortBy: q.sortBy,
      sortDir: q.sortDir
    };
  }

  app.get('/api/outlet-products', async (request) => {
    const state = store.getState();
    const wishlistSet = new Set(state.preferences?.wishlist ?? []);
    const q = request.query;

    const result = productCache.query({
      ...listingParams(q),
      page: Number.parseInt(q.page ?? '1', 10),
      pageSize: Number.parseInt(q.pageSize ?? '50', 10),
    }, { wishlistSet });
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
  const { purchaseState, stageListing } = purchaseService;

  app.get('/api/purchase', async (request, reply) => {
    if (!config.access?.adminToken) { reply.code(501); return { message: 'ADMIN_API_TOKEN is not configured.' }; }
    if (!isAdmin(request)) { reply.code(401); return { message: 'Unauthorized.' }; }
    const purchase = purchaseState();
    if (pruneExpiredArms(purchase)) await savePreferences();
    return {
      ...summarizePurchaseState(purchase),
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
      return arm;
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
    const rows = productCache.exportRows(listingParams(request.query), {
      wishlistSet: new Set(state.preferences?.wishlist ?? [])
    });

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
  app.get('/api/outlet-categories', async () => productCache.categories);

  // ── Outlet Sources (from cache) ────────────────────────────────
  app.get('/api/outlet-sources', async () => productCache.sources);

  // ── Outlet Campaigns (from cache) ──────────────────────────────
  app.get('/api/outlet-campaigns', async () => productCache.campaigns);

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

  // ── Komplett demo-products watcher ─────────────────────────────
  // Same auth level as /api/hotlist (dashboard, behind Cloudflare Access).
  // The webhook token is never echoed back; see publicKomplettDemoConfig.
  function requireKomplettDemo(reply) {
    if (!komplettDemo) {
      reply.code(404);
      return { message: 'The Komplett demo watcher is not configured.' };
    }
    return null;
  }

  const komplettDemoCatalog = KOMPLETT_DEMO_CATALOG.map((group) => ({
    group: group.group,
    groupId: group.groupId,
    label: group.label,
    categories: group.categories.map((category) => ({
      id: category.id,
      slug: category.slug,
      label: category.label,
      url: buildKomplettDemoUrl({ ...category, group: group.group })
    }))
  }));

  const komplettDemoLimits = {
    minIntervalMinutes: KOMPLETT_DEMO_MIN_INTERVAL_MINUTES,
    maxIntervalMinutes: KOMPLETT_DEMO_MAX_INTERVAL_MINUTES,
    maxJitterPct: KOMPLETT_DEMO_MAX_JITTER_PCT,
    minMonthlyUsd: KOMPLETT_DEMO_MIN_MONTHLY_USD,
    maxMonthlyUsd: KOMPLETT_DEMO_MAX_MONTHLY_USD,
    defaults: DEFAULT_KOMPLETT_DEMO_CONFIG
  };

  app.get('/api/komplett-demo', async (_, reply) => {
    const missing = requireKomplettDemo(reply);
    if (missing) return missing;
    return {
      config: publicKomplettDemoConfig(komplettDemo.getConfig()),
      status: komplettDemo.getStatus(),
      catalog: komplettDemoCatalog,
      limits: komplettDemoLimits
    };
  });

  app.get('/api/komplett-demo/config', async (_, reply) => {
    const missing = requireKomplettDemo(reply);
    if (missing) return missing;
    return { config: publicKomplettDemoConfig(komplettDemo.getConfig()), limits: komplettDemoLimits };
  });

  async function updateKomplettDemo(request, reply) {
    const missing = requireKomplettDemo(reply);
    if (missing) return missing;
    const body = request.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      reply.code(400);
      return { message: 'Expected a Komplett demo configuration object.' };
    }
    const patch = { ...body };

    if (Object.hasOwn(patch, 'categories')) {
      if (!Array.isArray(patch.categories)) {
        reply.code(400);
        return { message: 'categories must be an array of Komplett demo category ids.' };
      }
      const unknown = findUnknownCategoryIds(patch.categories);
      if (unknown.length) {
        reply.code(400);
        return { message: `Unknown Komplett demo categor${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}` };
      }
    }

    if (Object.hasOwn(patch, 'discordWebhookUrl')) {
      const raw = String(patch.discordWebhookUrl ?? '').trim();
      if (isMaskedWebhookUrl(raw)) {
        // The dashboard posted back the masked value: keep the stored webhook.
        delete patch.discordWebhookUrl;
      } else if (raw && !normalizeWebhookUrl(raw)) {
        // A typo must be an error, not a silent switch to the global webhook.
        reply.code(400);
        return { message: 'Expected a Discord webhook URL (https://discord.com/api/webhooks/…).' };
      }
    }

    const current = normalizeKomplettDemoConfig(komplettDemo.getConfig());
    const updated = await komplettDemo.update(normalizeKomplettDemoConfig(patch, current));
    return { config: publicKomplettDemoConfig(updated), status: komplettDemo.getStatus() };
  }

  app.post('/api/komplett-demo/config', updateKomplettDemo);
  app.put('/api/komplett-demo', updateKomplettDemo);

  app.get('/api/komplett-demo/status', async (_, reply) => {
    const missing = requireKomplettDemo(reply);
    if (missing) return missing;
    return komplettDemo.getStatus();
  });

  app.get('/api/komplett-demo/catalog', async (_, reply) => {
    const missing = requireKomplettDemo(reply);
    if (missing) return missing;
    return komplettDemoCatalog;
  });

  app.post('/api/komplett-demo/poll', async (_, reply) => {
    const missing = requireKomplettDemo(reply);
    if (missing) return missing;
    try {
      const result = await komplettDemo.pollNow();
      return { ok: true, result, status: komplettDemo.getStatus() };
    } catch (error) {
      reply.code(502);
      return { ok: false, message: error.message, status: komplettDemo.getStatus() };
    }
  });

  // ── NVIDIA Founders Edition (Notify-FE live feed) ─
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
      // Served from the live-feed poller's state; there is no direct NVIDIA query.
      // `refresh=true` (the "Check Now" button) only forces a reconnect when the feed is down.
      const pollerStatus = request.query?.refresh === 'true' && nvidia?.poller?.triggerNow
        ? await nvidia.poller.triggerNow()
        : (nvidia?.getStatus ? nvidia.getStatus() : null);
      if (!pollerStatus) {
        reply.code(503);
        return { ok: false, error: 'NVIDIA tracker is not available' };
      }
      return {
        ok: true,
        locale: pollerStatus.locale,
        poller: pollerStatus,
        checkedAt: pollerStatus.feed?.lastPacketAt || pollerStatus.lastSuccessAt || null,
        cards: pollerStatus.cards
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
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
  // A per-item bookmark ("♡") with a dashboard filter. Its target-price
  // Discord alerts were removed on 2026-10-31; stored targets are ignored.
  app.get('/api/wishlist', async () => {
    const state = store.getState();
    return { items: state.preferences?.wishlist ?? [] };
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
    if (typeof store.savePreferences === 'function') {
      await store.savePreferences();
    } else {
      await store.save();
    }
    return { ok: true, listingKey, wishlisted: true };
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
    if (typeof store.savePreferences === 'function') {
      await store.savePreferences();
    } else {
      await store.save();
    }
    return { ok: true, listingKey, wishlisted: false };
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
