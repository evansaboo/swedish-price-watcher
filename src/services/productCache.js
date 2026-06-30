// ═══════════════════════════════════════════════════════════════
// ProductCache — Materialized view with pre-built indexes
// Rebuilt only on state mutation (after scan/save), not per-request.
// ═══════════════════════════════════════════════════════════════

import { firstFinite } from '../lib/utils.js';
import { buildIdentityGroups } from './dealEngine.js';
import { buildResaleIndex, computeFlips, DEFAULT_RESALE_OPTIONS } from './resaleEngine.js';

// Conditions whose items can be bought and re-sold privately (flip candidates).
const FLIP_CANDIDATE_CONDITIONS = new Set(['outlet', 'deal', 'new']);

const NEW_PRODUCT_FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

function normalizeForSearch(str) {
  return String(str ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^ -\u007F\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCategoryKey(category) {
  return String(category ?? '').trim().toLowerCase();
}

function toTimestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

function isNewProduct(product, latestRunStartedAt) {
  const firstSeenTs = toTimestamp(product.firstSeenAt);
  if (firstSeenTs == null) return false;
  const runTs = toTimestamp(latestRunStartedAt);
  if (runTs != null) return firstSeenTs >= runTs;
  return Date.now() - firstSeenTs <= NEW_PRODUCT_FALLBACK_WINDOW_MS;
}

// Tokenize a search query into lowercase tokens
function tokenize(query) {
  return String(query ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^ -\u007F\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export class ProductCache {
  constructor(resaleOptions = {}) {
    this._products = [];          // Materialized outlet products
    this._searchIndex = [];       // Pre-tokenized search text per product (parallel array)
    this._byCategory = new Map(); // category key → product indices
    this._byStore = new Map();    // sourceId → product indices
    this._byCampaign = new Map(); // conditionLabel lower → product indices
    this._categories = [];        // Pre-computed category stats (no favorites applied)
    this._sources = [];           // Unique sources [{id, label}]
    this._campaigns = [];         // Unique campaigns [{label, value}]
    this._flips = [];             // Materialized flip/resale opportunities
    this._flipDemandCategories = []; // Unique demand categories among flips
    this._resaleOptions = { ...DEFAULT_RESALE_OPTIONS, ...resaleOptions };
    this._resolveModel = null;    // optional LLM-backed resolver (set via setModelResolver)
    this._version = 0;            // Incremented on rebuild
  }

  // Inject a model resolver (e.g. deterministic + LLM gap-fill). When unset the
  // resale engine falls back to the deterministic extractResaleModel.
  setModelResolver(fn) {
    this._resolveModel = typeof fn === 'function' ? fn : null;
  }

  get version() { return this._version; }
  get products() { return this._products; }
  get categories() { return this._categories; }
  get sources() { return this._sources; }
  get campaigns() { return this._campaigns; }
  get flips() { return this._flips; }
  get flipDemandCategories() { return this._flipDemandCategories; }

  // Rebuild the entire cache from raw state. Call after scan completes or state loads.
  // sourceLabelMap: optional Map(sourceId → label) from config for label overrides
  rebuild(state, sourceLabelMap) {
    const items = state.items;
    const deals = state.deals ?? [];
    const labelOverrides = sourceLabelMap instanceof Map ? sourceLabelMap : null;
    const scoreByKey = new Map(deals.map(d => [d.listingKey, d.score ?? 0]));

    // Build products
    const products = [];
    const includedItems = []; // raw items parallel to products — for identity grouping
    const searchIndex = [];
    const byCategory = new Map();
    const byStore = new Map();
    const byCampaign = new Map();
    const categoryMap = new Map();
    const sourceMap = new Map();
    const campaignSet = new Set();

    for (const item of Object.values(items)) {
      if (!['outlet', 'digital', 'deal', 'used'].includes(item.condition)) continue;
      // Sold comps (e.g. Tradera ended auctions) feed the resale index but are not
      // buyable, so keep them out of the product grid.
      if (item.soldComp || item.availability === 'sold') continue;
      if (!Number.isFinite(item.latestPriceSek)) continue;

      const initialPriceSek = firstFinite(item.referencePriceSek, item.marketValueSek);
      const discountSek = Number.isFinite(initialPriceSek)
        ? Math.max(0, initialPriceSek - item.latestPriceSek)
        : null;
      const discountPercent = Number.isFinite(initialPriceSek) && initialPriceSek > 0
        ? Math.max(0, Math.round((discountSek / initialPriceSek) * 100))
        : null;
      const score = scoreByKey.get(item.listingKey) ?? 0;

      const product = {
        listingKey: item.listingKey,
        title: item.title,
        url: item.url,
        category: item.category,
        condition: item.condition,
        conditionLabel: item.conditionLabel ?? null,
        sourceId: item.sourceId,
        sourceLabel: (labelOverrides && labelOverrides.get(item.sourceId)) || item.sourceLabel || item.sourceId,
        currentPriceSek: item.latestPriceSek,
        initialPriceSek,
        discountSek,
        discountPercent,
        referenceMatched: Number.isFinite(initialPriceSek),
        referenceMatchType: item.referenceMatchType ?? null,
        referenceTitle: item.referenceTitle ?? null,
        referenceUrl: item.referenceUrl ?? null,
        availability: item.availability ?? 'unknown',
        firstSeenAt: item.firstSeenAt ?? null,
        lastSeenAt: item.lastSeenAt ?? null,
        imageUrl: item.imageUrl ?? null,
        score,
        keyshopPriceSek: item.keyshopPriceSek ?? null,
        historicalKeyshopPriceSek: item.historicalKeyshopPriceSek ?? null,
        steamAppId: item.steamAppId ?? null,
        // Last 10 history entries for sparkline
        historyPreview: Array.isArray(item.history) && item.history.length >= 2
          ? item.history.slice(-10).map(h => ({ priceSek: h.priceSek, seenAt: h.seenAt }))
          : [],
      };

      const idx = products.length;
      products.push(product);
      includedItems.push(item);

      // Pre-compute search text
      const searchText = normalizeForSearch(
        [item.title, item.category, item.sourceLabel].filter(Boolean).join(' ')
      );
      searchIndex.push(searchText);

      // Index by category
      const catKey = normalizeCategoryKey(item.category);
      if (catKey) {
        if (!byCategory.has(catKey)) byCategory.set(catKey, []);
        byCategory.get(catKey).push(idx);

        if (!categoryMap.has(catKey)) {
          categoryMap.set(catKey, { name: item.category, key: catKey, count: 0, discountedCount: 0 });
        }
        const catStats = categoryMap.get(catKey);
        catStats.count++;
        if (Number.isFinite(discountSek) && discountSek > 0) catStats.discountedCount++;
      }

      // Index by store
      if (item.sourceId) {
        if (!byStore.has(item.sourceId)) byStore.set(item.sourceId, []);
        byStore.get(item.sourceId).push(idx);
        if (!sourceMap.has(item.sourceId)) {
          sourceMap.set(item.sourceId, (labelOverrides && labelOverrides.get(item.sourceId)) || item.sourceLabel || item.sourceId);
        }
      }

      // Index by campaign
      if (item.conditionLabel) {
        const campKey = item.conditionLabel.toLowerCase();
        if (!byCampaign.has(campKey)) byCampaign.set(campKey, []);
        byCampaign.get(campKey).push(idx);
        campaignSet.add(item.conditionLabel);
      }
    }

    // ── Cross-store annotation ───────────────────────────────────
    // Products sharing a GTIN / manufacturer part number / productKey across
    // at least two stores get cheapest-store info for the card UI.
    const productByListingKey = new Map(products.map((p) => [p.listingKey, p]));
    for (const group of buildIdentityGroups(includedItems).values()) {
      if (group.length < 2) continue;
      const groupProducts = group.map((item) => productByListingKey.get(item.listingKey)).filter(Boolean);
      const distinctSources = new Set(groupProducts.map((p) => p.sourceId));
      if (distinctSources.size < 2) continue;

      let best = groupProducts[0];
      for (const p of groupProducts) {
        if (p.currentPriceSek < best.currentPriceSek) best = p;
      }
      for (const p of groupProducts) {
        p.crossStore = {
          offers: groupProducts.length,
          stores: distinctSources.size,
          bestPriceSek: best.currentPriceSek,
          bestSourceLabel: best.sourceLabel,
          isCheapest: p.currentPriceSek <= best.currentPriceSek
        };
      }
    }

    // Pre-compute fast sort keys on each product (avoids per-comparison work in the hot sort loop)
    for (let i = 0; i < products.length; i++) {
      products[i]._titleKey = searchIndex[i]; // already normalized, reuse for tiebreaker
      products[i]._lastSeenAtTs = products[i].lastSeenAt ? (Date.parse(products[i].lastSeenAt) || 0) : 0;
    }

    // Pre-sort the array once by the default order (discountPercent desc, then title asc).
    // Queries using the default sort can skip the sort entirely — filtered results come out
    // pre-ordered because we iterate the already-sorted array in order.
    const sortedOrder = Array.from({ length: products.length }, (_, i) => i).sort((a, b) => {
      const va = Number.isFinite(products[a].discountPercent) ? products[a].discountPercent : -Infinity;
      const vb = Number.isFinite(products[b].discountPercent) ? products[b].discountPercent : -Infinity;
      if (va !== vb) return vb - va;
      const ka = products[a]._titleKey, kb = products[b]._titleKey;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    // Build old-index → new-position map so the index maps can be remapped cheaply
    const newPosOf = new Int32Array(products.length);
    for (let newPos = 0; newPos < sortedOrder.length; newPos++) {
      newPosOf[sortedOrder[newPos]] = newPos;
    }

    const remapIndexArray = (arr) => arr.map(i => newPosOf[i]).sort((a, b) => a - b);

    this._products = sortedOrder.map(i => products[i]);
    this._searchIndex = sortedOrder.map(i => searchIndex[i]);
    this._byCategory = new Map([...byCategory].map(([k, v]) => [k, remapIndexArray(v)]));
    this._byStore = new Map([...byStore].map(([k, v]) => [k, remapIndexArray(v)]));
    this._byCampaign = new Map([...byCampaign].map(([k, v]) => [k, remapIndexArray(v)]));
    this._categories = [...categoryMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv-SE'));
    this._sources = [...sourceMap.entries()].map(([id, label]) => ({ id, label }));
    this._campaigns = [...campaignSet].sort().map(label => ({ label, value: label.toLowerCase() }));

    // ── Resale / flip opportunities ──────────────────────────────
    // Build a Blocket second-hand price index from 'used' items, then value
    // buyable (outlet/deal/new) items against the matching model's median.
    const allItems = Object.values(items);
    const usedItems = allItems.filter((item) => item.condition === 'used');
    const flipCandidates = allItems
      .filter((item) => FLIP_CANDIDATE_CONDITIONS.has(item.condition) && Number.isFinite(item.latestPriceSek))
      .map((item) => ({
        ...item,
        sourceLabel: (labelOverrides && labelOverrides.get(item.sourceId)) || item.sourceLabel || item.sourceId
      }));

    const resaleIndex = buildResaleIndex(usedItems, { resolveModel: this._resolveModel ?? undefined });
    this._flips = computeFlips(flipCandidates, resaleIndex, { ...this._resaleOptions, resolveModel: this._resolveModel ?? undefined });
    this._flipDemandCategories = [...new Set(this._flips.map((f) => f.demandCategory))]
      .sort((a, b) => a.localeCompare(b, 'sv-SE'));

    this._version++;
  }

  // Fast filtered + sorted + paginated query over flip/resale opportunities
  queryFlips(params = {}) {
    const {
      search = '',
      demandCategory = '',
      store = '',
      minNetProfitSek = NaN,
      minRoiPercent = NaN,
      maxBuyPriceSek = NaN,
      sortBy = 'netProfitSek',
      sortDir = 'desc',
      page = 1,
      pageSize = 50
    } = params;

    const searchTokens = tokenize(search);
    const demand = String(demandCategory ?? '').trim().toLowerCase();
    const storeKey = String(store ?? '').trim();

    let filtered = this._flips.filter((flip) => {
      if (demand && String(flip.demandCategory).toLowerCase() !== demand) return false;
      if (storeKey && flip.sourceId !== storeKey) return false;
      if (Number.isFinite(minNetProfitSek) && flip.netProfitSek < minNetProfitSek) return false;
      if (Number.isFinite(minRoiPercent) && flip.roiPercent < minRoiPercent) return false;
      if (Number.isFinite(maxBuyPriceSek) && maxBuyPriceSek > 0 && flip.buyPriceSek > maxBuyPriceSek) return false;
      if (searchTokens.length) {
        const hay = normalizeForSearch([flip.title, flip.modelLabel, flip.demandCategory, flip.sourceLabel].filter(Boolean).join(' '));
        for (const t of searchTokens) if (!hay.includes(t)) return false;
      }
      return true;
    });

    // Sort — default (netProfitSek desc) is already the materialized order
    const validSortColumns = new Set(['netProfitSek', 'roiPercent', 'buyPriceSek', 'resaleMedianSek', 'sampleCount']);
    const col = validSortColumns.has(sortBy) ? sortBy : 'netProfitSek';
    const dir = sortDir === 'asc' ? 1 : -1;
    if (!(col === 'netProfitSek' && dir === -1)) {
      filtered = filtered.slice().sort((a, b) => {
        const cmp = (Number(a[col]) || 0) - (Number(b[col]) || 0);
        return cmp !== 0 ? cmp * dir : b.netProfitSek - a.netProfitSek;
      });
    }

    // Aggregates over the full filtered set
    const totalFiltered = filtered.length;
    let profitSum = 0;
    let bestProfit = 0;
    for (const f of filtered) {
      profitSum += f.netProfitSek;
      if (f.netProfitSek > bestProfit) bestProfit = f.netProfitSek;
    }

    const safePageSize = Number.isFinite(pageSize) ? pageSize : 50;
    const safePage = Number.isFinite(page) ? page : 1;
    const clampedPageSize = Math.min(200, Math.max(1, safePageSize));
    const totalPages = Math.ceil(totalFiltered / clampedPageSize) || 1;
    const clampedPage = Math.min(Math.max(1, safePage), totalPages);
    const offset = (clampedPage - 1) * clampedPageSize;

    return {
      items: filtered.slice(offset, offset + clampedPageSize),
      total: totalFiltered,
      page: clampedPage,
      pageSize: clampedPageSize,
      totalPages,
      demandCategories: this._flipDemandCategories,
      aggregates: {
        totalProfitSek: Math.round(profitSum),
        bestProfitSek: Math.round(bestProfit),
        avgProfitSek: totalFiltered ? Math.round(profitSum / totalFiltered) : 0
      }
    };
  }

  // Get categories with favorites applied
  getCategoriesWithFavorites(favoriteCategorySet) {
    return this._categories.map(c => ({
      ...c,
      favorite: favoriteCategorySet.has(c.key)
    }));
  }

  /** Full filtered + sorted result set (no pagination) — used for CSV export. */
  exportRows(params, favoriteCategorySet, latestRunStartedAt, wishlistSet) {
    return this.#filteredSorted(params, favoriteCategorySet, latestRunStartedAt, wishlistSet);
  }

  // Fast filtered + sorted + paginated query
  query(params, favoriteCategorySet, latestRunStartedAt, wishlistSet) {
    const filtered = this.#filteredSorted(params, favoriteCategorySet, latestRunStartedAt, wishlistSet);
    const { page = 1, pageSize = 50 } = params;

    // Aggregates
    let discounted = 0, matched = 0, discountSum = 0, discountCount = 0;
    for (const p of filtered) {
      if (Number.isFinite(p.discountSek) && p.discountSek > 0) discounted++;
      if (Number.isFinite(p.initialPriceSek)) matched++;
      if (Number.isFinite(p.discountPercent)) { discountSum += p.discountPercent; discountCount++; }
    }
    const avgDiscountPercent = discountCount ? Math.round(discountSum / discountCount) : null;

    // Paginate — guard against NaN from unparseable query params
    const safePageSize = Number.isFinite(pageSize) ? pageSize : 50;
    const safePage = Number.isFinite(page) ? page : 1;
    const clampedPageSize = Math.min(200, Math.max(1, safePageSize));
    const totalFiltered = filtered.length;
    const totalPages = Math.ceil(totalFiltered / clampedPageSize) || 1;
    const clampedPage = Math.min(Math.max(1, safePage), totalPages);
    const offset = (clampedPage - 1) * clampedPageSize;

    const items = filtered.slice(offset, offset + clampedPageSize);
    // Annotate with wishlist status
    if (wishlistSet && wishlistSet.size > 0) {
      for (const item of items) {
        item.wishlisted = wishlistSet.has(item.listingKey);
      }
    }

    return {
      items,
      total: totalFiltered,
      page: clampedPage,
      pageSize: clampedPageSize,
      totalPages,
      aggregates: { discounted, matched, avgDiscountPercent }
    };
  }

  // Shared filter + sort pipeline behind query() and exportRows()
  #filteredSorted(params, favoriteCategorySet, latestRunStartedAt, wishlistSet) {
    const {
      search = '',
      category = '',
      store = '',
      campaign = '',
      favoritesOnly = false,
      discountedOnly = false,
      referenceOnly = false,
      newOnly = false,
      hotOnly = false,
      wishlistOnly = false,
      minDiscountPercent = NaN,
      minPriceSek = NaN,
      maxPriceSek = NaN,
      sortBy = 'discountPercent',
      sortDir = 'desc',
    } = params;

    // Determine candidate set — use indexes to narrow down before linear filter
    let candidates = null; // null means "all products"

    // Store filter is highly selective — use index
    if (store && this._byStore.has(store)) {
      candidates = new Set(this._byStore.get(store));
    }

    // Campaign filter — intersect with candidates
    if (campaign && this._byCampaign.has(campaign)) {
      const campIndices = this._byCampaign.get(campaign);
      if (candidates) {
        const campSet = new Set(campIndices);
        candidates = new Set([...candidates].filter(i => campSet.has(i)));
      } else {
        candidates = new Set(campIndices);
      }
    }

    // Category filter — intersect
    if (category) {
      const catKey = normalizeCategoryKey(category);
      if (this._byCategory.has(catKey)) {
        const catIndices = this._byCategory.get(catKey);
        if (candidates) {
          const catSet = new Set(catIndices);
          candidates = new Set([...candidates].filter(i => catSet.has(i)));
        } else {
          candidates = new Set(catIndices);
        }
      } else {
        // Category doesn't exist — no results
        return [];
      }
    }

    // Tokenize search once
    const searchTokens = tokenize(search);

    // Linear filter over candidates (or all products if no index narrowing)
    const filtered = [];
    const total = this._products.length;

    for (let i = 0; i < total; i++) {
      if (candidates && !candidates.has(i)) continue;

      const product = this._products[i];

      // Favorites filter
      if (favoritesOnly && !favoriteCategorySet.has(normalizeCategoryKey(product.category))) continue;

      // Discounted filter
      if (discountedOnly && !(Number.isFinite(product.discountSek) && product.discountSek > 0)) continue;

      // Reference filter
      if (referenceOnly && !Number.isFinite(product.initialPriceSek)) continue;

      // New filter
      if (newOnly && !isNewProduct(product, latestRunStartedAt)) continue;

      // Hot filter
      if (hotOnly && !((product.score ?? 0) >= 50 || (Number.isFinite(product.discountPercent) && product.discountPercent >= 20))) continue;

      // Wishlist filter
      if (wishlistOnly && !(wishlistSet && wishlistSet.has(product.listingKey))) continue;

      // Min discount
      if (Number.isFinite(minDiscountPercent) && minDiscountPercent > 0) {
        if (!(Number.isFinite(product.discountPercent) && product.discountPercent >= minDiscountPercent)) continue;
      }

      // Price range
      if (Number.isFinite(minPriceSek) && minPriceSek > 0 && product.currentPriceSek < minPriceSek) continue;
      if (Number.isFinite(maxPriceSek) && maxPriceSek > 0 && product.currentPriceSek > maxPriceSek) continue;

      // Search — token matching against pre-built search text
      if (searchTokens.length) {
        const hay = this._searchIndex[i];
        let match = true;
        for (const t of searchTokens) {
          if (!hay.includes(t)) { match = false; break; }
        }
        if (!match) continue;
      }

      filtered.push(product);
    }

    // Sort — skip entirely for default order (array is pre-sorted at rebuild time)
    const validSortColumns = new Set([
      'title', 'category', 'currentPriceSek', 'initialPriceSek',
      'discountSek', 'discountPercent', 'score', 'lastSeenAt'
    ]);
    const col = validSortColumns.has(sortBy) ? sortBy : 'discountPercent';
    const dir = sortDir === 'asc' ? 1 : -1;
    const isDefaultSort = col === 'discountPercent' && dir === -1;

    if (!isDefaultSort) {
      filtered.sort((a, b) => {
        let cmp;
        if (col === 'title' || col === 'category') {
          // Use pre-computed normalized key for title; fall back to raw for category
          const ka = col === 'title' ? (a._titleKey ?? '') : String(a.category ?? '').toLowerCase();
          const kb = col === 'title' ? (b._titleKey ?? '') : String(b.category ?? '').toLowerCase();
          cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
        } else if (col === 'lastSeenAt') {
          cmp = (a._lastSeenAtTs ?? 0) - (b._lastSeenAtTs ?? 0);
        } else {
          const va = Number.isFinite(a[col]) ? a[col] : -Infinity;
          const vb = Number.isFinite(b[col]) ? b[col] : -Infinity;
          cmp = va - vb;
        }
        if (cmp !== 0) return cmp * dir;
        // Tiebreaker: use pre-computed key (no localeCompare overhead)
        const ka = a._titleKey ?? '', kb = b._titleKey ?? '';
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
    }

    return filtered;
  }

}
