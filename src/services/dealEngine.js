import { buildListingKey, clamp, firstFinite, formatSek, median } from '../lib/utils.js';
import { validateReferencePrice } from '../lib/referencePrice.js';

function isGenericCategoryLabel(category) {
  const normalized = String(category ?? '').trim().toLowerCase();
  return !normalized || normalized === 'outlet' || /^kategori \d+$/i.test(normalized);
}

function pickPreferredCategory(previousCategory, nextCategory) {
  if (!nextCategory) {
    return previousCategory ?? null;
  }

  if (!previousCategory) {
    return nextCategory;
    
  }

  const previousGeneric = isGenericCategoryLabel(previousCategory);
  const nextGeneric = isGenericCategoryLabel(nextCategory);

  if (previousGeneric && !nextGeneric) {
    return nextCategory;
  }

  if (!previousGeneric && nextGeneric) {
    return previousCategory;
  }

  return nextCategory;
}

function resaleFactorForCondition(condition) {
  switch (condition) {
    case 'new':
      return 0.9;
    case 'outlet':
      return 0.82;
    case 'used':
      return 0.72;
    default:
      return 0.8;
  }
}

function currentPrices(items) {
  return items
    .map((item) => item.latestPriceSek)
    .filter((value) => Number.isFinite(value));
}

// ── Cross-store identity grouping ──────────────────────────────
// Items are linked when they share any hard identifier (GTIN/EAN,
// manufacturer part number) or the normalized-title productKey.
// Union-find keeps it transitive: A(gtin+mpn) links B(mpn only).

function normalizeGtin(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

function normalizeMpn(value) {
  const token = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Too-short or all-letter/all-digit tokens collide across unrelated products.
  if (token.length < 4 || !/[A-Z]/.test(token) || !/\d/.test(token)) return null;
  return token;
}

function identityTokens(item) {
  const tokens = [];
  const gtin = normalizeGtin(item.gtin);
  if (gtin) tokens.push(`gtin:${gtin}`);
  for (const mpnField of [item.manufacturerArticleNumber, item.altArticleNumber]) {
    const mpn = normalizeMpn(mpnField);
    if (mpn) tokens.push(`mpn:${mpn}`);
  }
  if (item.productKey) tokens.push(`key:${item.productKey}`);
  return tokens;
}

/**
 * Group items by shared identity. Returns Map<groupRoot, item[]>.
 * Equivalent to the old productKey grouping when no hard identifiers exist.
 */
export function buildIdentityGroups(items) {
  const parent = new Map();
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    // Path compression
    while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next; }
    return root;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const item of items) {
    const node = `item:${item.listingKey}`;
    if (!parent.has(node)) parent.set(node, node);
    for (const token of identityTokens(item)) union(node, token);
  }

  const groups = new Map();
  for (const item of items) {
    const root = find(`item:${item.listingKey}`);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  }
  return groups;
}

// ── Retail arbitrage ───────────────────────────────────────────
// Same product offered by 2+ different stores at different prices. Buying the
// cheapest offer and reselling (privately or simply spotting the underpriced
// listing) is a low-risk arbitrage. We reuse the identity grouping above, so a
// match requires a shared GTIN/MPN or the normalized-title productKey.

/**
 * Compute cross-store retail arbitrage opportunities.
 *
 * @param {Array} items raw buyable items (already filtered to the product grid)
 * @param {Map}   productByListingKey listingKey → materialized product (price/label/url/img)
 * @param {object} options { minSpreadSek = 1 }
 * @returns {Array} arbitrage records sorted by absolute spread desc
 */
export function computeArbitrage(items, productByListingKey, options = {}) {
  const minSpreadSek = Number.isFinite(options.minSpreadSek) ? options.minSpreadSek : 1;
  const results = [];

  // Identity grouping is the same union-find the caller (productCache.rebuild)
  // already computed for cross-store annotation — accept it to avoid grouping
  // ~26k items twice per rebuild.
  const groups = options.identityGroups ?? [...buildIdentityGroups(items).values()];
  for (const group of groups) {
    if (group.length < 2) continue;

    // Keep the cheapest offer per RETAILER (not per source feed). Several feeds
    // belong to the same retailer (e.g. elgiganten-outlet + elgiganten-campaigns);
    // collapsing them prevents same-retailer pairs masquerading as arbitrage.
    const bestPerRetailer = new Map();
    for (const item of group) {
      const product = productByListingKey.get(item.listingKey);
      if (!product || !Number.isFinite(product.currentPriceSek)) continue;
      // Retail arbitrage compares like-for-like retail stock. Used-marketplace
      // listings (Blocket) are cheaper *because* they're used — that's a Flip
      // signal, not arbitrage — so keep them out of this view.
      if (product.condition === 'used') continue;
      const retailer = retailerKey(product.sourceId);
      const existing = bestPerRetailer.get(retailer);
      if (!existing || product.currentPriceSek < existing.currentPriceSek) {
        bestPerRetailer.set(retailer, product);
      }
    }
    if (bestPerRetailer.size < 2) continue; // need ≥2 genuinely different retailers

    const offers = [...bestPerRetailer.values()].sort((a, b) => a.currentPriceSek - b.currentPriceSek);
    const best = offers[0];
    const high = offers[offers.length - 1];
    const spreadSek = high.currentPriceSek - best.currentPriceSek;
    if (spreadSek < minSpreadSek) continue;

    const spreadPercent = high.currentPriceSek > 0
      ? Math.round((spreadSek / high.currentPriceSek) * 100)
      : 0;

    // Prefer a non-generic category and the most descriptive (longest) title.
    const category = offers.map((o) => o.category).find((c) => !isGenericCategoryLabel(c)) ?? best.category ?? null;
    const title = offers.reduce((longest, o) => (String(o.title ?? '').length > String(longest ?? '').length ? o.title : longest), best.title);
    const imageUrl = offers.map((o) => o.imageUrl).find(Boolean) ?? null;

    results.push({
      groupKey: best.listingKey,
      title,
      category,
      imageUrl,
      bestPriceSek: best.currentPriceSek,
      bestSourceId: best.sourceId,
      bestSourceLabel: best.sourceLabel,
      bestUrl: best.url,
      bestListingKey: best.listingKey,
      bestCondition: best.condition,
      bestConditionLabel: best.conditionLabel ?? null,
      highPriceSek: high.currentPriceSek,
      highSourceLabel: high.sourceLabel,
      spreadSek,
      spreadPercent,
      storeCount: offers.length,
      offerCount: offers.length,
      offers: offers.map((o) => ({
        sourceId: o.sourceId,
        sourceLabel: o.sourceLabel,
        priceSek: o.currentPriceSek,
        url: o.url,
        listingKey: o.listingKey,
        condition: o.condition,
        conditionLabel: o.conditionLabel ?? null
      }))
    });
  }

  results.sort((a, b) => b.spreadSek - a.spreadSek);
  return results;
}

// Retailer identity from a sourceId: the segment before the first hyphen.
// elgiganten-outlet / elgiganten-campaigns → 'elgiganten'; power-deals / power-campaigns → 'power'.
function retailerKey(sourceId) {
  const id = String(sourceId ?? '').trim().toLowerCase();
  const dash = id.indexOf('-');
  return dash === -1 ? id : id.slice(0, dash);
}

function historyPrices(items) {
  return items.flatMap((item) => item.history.map((entry) => entry.priceSek).filter((value) => Number.isFinite(value)));
}

export function mergeObservations(state, observations, maxHistoryEntries = 60) {
  const newItems = [];
  const priceDrops = [];

  for (const observation of observations) {
    const listingKey = buildListingKey(observation.sourceId, observation.externalId);
    const isNewItem = !state.items[listingKey];

    // Restore archived history if this item was previously pruned
    const archived = isNewItem ? (state.itemHistory?.[listingKey] ?? null) : null;
    if (archived) delete state.itemHistory[listingKey];

    const currentItem = state.items[listingKey] ?? {
      listingKey,
      firstSeenAt: archived?.firstSeenAt ?? observation.seenAt,
      history: archived?.history ?? [],
      lowestPriceSek: archived?.lowestPriceSek ?? observation.priceSek,
      highestPriceSek: archived?.highestPriceSek ?? observation.priceSek
    };
    const previousPriceSek = Number.isFinite(currentItem.latestPriceSek) ? currentItem.latestPriceSek : null;

    const lastEntry = currentItem.history.at(-1);
    const shouldAppendHistory =
      !lastEntry ||
      lastEntry.priceSek !== observation.priceSek ||
      lastEntry.availability !== observation.availability;

    if (shouldAppendHistory) {
      currentItem.history.push({
        seenAt: observation.seenAt,
        priceSek: observation.priceSek,
        availability: observation.availability ?? null
      });
    }

    currentItem.history = currentItem.history.slice(-maxHistoryEntries);
    currentItem.lowestPriceSek = Math.min(currentItem.lowestPriceSek ?? observation.priceSek, observation.priceSek);
    currentItem.highestPriceSek = Math.max(currentItem.highestPriceSek ?? observation.priceSek, observation.priceSek);
    currentItem.lastSeenAt = observation.seenAt;
    currentItem.latestPriceSek = observation.priceSek;
    currentItem.externalId = observation.externalId;
    currentItem.sourceId = observation.sourceId;
    currentItem.sourceLabel = observation.sourceLabel;
    currentItem.sourceType = observation.sourceType;
    currentItem.productKey = observation.productKey;
    currentItem.title = observation.title;
    currentItem.url = observation.url;
    currentItem.category = pickPreferredCategory(currentItem.category, observation.category);
    currentItem.categoryGroupId = observation.categoryGroupId ?? currentItem.categoryGroupId ?? null;
    currentItem.condition = observation.condition;
    currentItem.marketValueSek = firstFinite(observation.marketValueSek, currentItem.marketValueSek);
    currentItem.referencePriceSek = firstFinite(observation.referencePriceSek, currentItem.referencePriceSek);
    currentItem.referenceUrl = observation.referenceUrl ?? currentItem.referenceUrl ?? null;
    currentItem.referenceTitle = observation.referenceTitle ?? currentItem.referenceTitle ?? null;
    currentItem.referenceSourceLabel = observation.referenceSourceLabel ?? currentItem.referenceSourceLabel ?? null;
    currentItem.referenceMatchType = observation.referenceMatchType ?? currentItem.referenceMatchType ?? null;
    currentItem.articleNumber = observation.articleNumber ?? currentItem.articleNumber ?? null;
    currentItem.altArticleNumber = observation.altArticleNumber ?? currentItem.altArticleNumber ?? null;
    currentItem.manufacturerArticleNumber =
      observation.manufacturerArticleNumber ?? currentItem.manufacturerArticleNumber ?? null;
    currentItem.gtin = observation.gtin ?? currentItem.gtin ?? null;
    currentItem.resaleEstimateSek = observation.resaleEstimateSek;
    currentItem.shippingEstimateSek = observation.shippingEstimateSek ?? 0;
    currentItem.feesEstimateSek = observation.feesEstimateSek ?? 0;
    currentItem.availability = observation.availability ?? 'unknown';
    currentItem.description = observation.description ?? null;
    currentItem.imageUrl = observation.imageUrl || currentItem.imageUrl || null;
    currentItem.notes = observation.notes ?? null;
    currentItem.conditionLabel = observation.conditionLabel ?? currentItem.conditionLabel ?? null;
    // GG.deals-specific fields (stored for all sources; null for non-GG.deals items).
    currentItem.keyshopPriceSek = observation.keyshopPriceSek != null ? Number(observation.keyshopPriceSek) : (currentItem.keyshopPriceSek ?? null);
    currentItem.historicalKeyshopPriceSek = observation.historicalKeyshopPriceSek != null ? Number(observation.historicalKeyshopPriceSek) : (currentItem.historicalKeyshopPriceSek ?? null);
    currentItem.currency = observation.currency ?? currentItem.currency ?? null;
    currentItem.steamAppId = observation.steamAppId ?? currentItem.steamAppId ?? null;

    state.items[listingKey] = currentItem;

    if (isNewItem) {
      newItems.push(currentItem);
    }

    if (
      !isNewItem &&
      Number.isFinite(previousPriceSek) &&
      Number.isFinite(observation.priceSek) &&
      observation.priceSek < previousPriceSek
    ) {
      const dropSek = previousPriceSek - observation.priceSek;
      const dropPercent = previousPriceSek > 0 ? Math.round((dropSek / previousPriceSek) * 100) : 0;

      priceDrops.push({
        listingKey: currentItem.listingKey,
        sourceId: currentItem.sourceId,
        sourceLabel: currentItem.sourceLabel,
        title: currentItem.title,
        url: currentItem.url,
        category: currentItem.category,
        condition: currentItem.condition,
        previousPriceSek,
        newPriceSek: observation.priceSek,
        dropSek,
        dropPercent,
        seenAt: observation.seenAt
      });
    }
  }

  return {
    state,
    newItems,
    priceDrops
  };
}

export function computeDeals(state, thresholds) {
  const items = Object.values(state.items).filter((item) => Number.isFinite(item.latestPriceSek));
  // Identity-based grouping: GTIN / manufacturer part number link the same
  // product across stores; falls back to productKey when neither exists.
  const groupedItems = buildIdentityGroups(items);

  // Precompute per-group price stats once — recomputing medians per item makes
  // large groups quadratic, and computeDeals runs after every source in a scan.
  const statsByListingKey = new Map();
  for (const peers of groupedItems.values()) {
    const peerCurrentPrices = currentPrices(peers);
    const stats = {
      currentMedian: median(peerCurrentPrices),
      historyMedian: median(historyPrices(peers)),
      bestCurrentSek: peerCurrentPrices.length ? Math.min(...peerCurrentPrices) : null,
      count: peerCurrentPrices.length
    };
    for (const peer of peers) statsByListingKey.set(peer.listingKey, stats);
  }

  return items
    .map((item) => {
      const stats = statsByListingKey.get(item.listingKey) ?? { currentMedian: null, historyMedian: null, bestCurrentSek: null, count: 0 };
      const atHistoricalLow =
        Number.isFinite(item.lowestPriceSek) && item.latestPriceSek <= Math.round(item.lowestPriceSek * 1.02);
      // Validate the source-provided reference before trusting it for discount
      // math — rejects scaling errors and inflated campaign "before" prices.
      const sourceReference = firstFinite(item.marketValueSek, item.referencePriceSek);
      const { trustedReference, confidence } = validateReferencePrice({
        sourceReference,
        currentPriceSek: item.latestPriceSek,
        peerMedian: firstFinite(stats.currentMedian, stats.historyMedian),
        peerCount: stats.count,
        hasCatalogMatch: Boolean(item.referenceMatchType || item.referenceTitle),
        atHistoricalLow
      });
      const comparisonPriceSek = firstFinite(
        trustedReference,
        stats.currentMedian,
        stats.historyMedian,
        item.latestPriceSek
      );
      // When no source reference survived but a cross-store median sits above the
      // buy price, the discount is an estimate rather than a verified/claimed one.
      let referenceConfidence = confidence;
      if (referenceConfidence === 'none' && comparisonPriceSek > item.latestPriceSek) {
        referenceConfidence = 'estimated';
      }
      const bestCurrentSek = stats.bestCurrentSek ?? item.latestPriceSek;
      const estimatedPrivateSaleSek =
        item.resaleEstimateSek ?? Math.round(comparisonPriceSek * resaleFactorForCondition(item.condition));
      const totalCostSek = item.latestPriceSek + (item.shippingEstimateSek ?? 0) + (item.feesEstimateSek ?? 0);
      const profitSek = estimatedPrivateSaleSek - totalCostSek;
      const discountPercent =
        comparisonPriceSek > 0 ? Math.round(((comparisonPriceSek - item.latestPriceSek) / comparisonPriceSek) * 100) : 0;
      const bestCurrent = item.latestPriceSek <= bestCurrentSek;

      let score = 0;
      score += clamp(discountPercent * 2.2, 0, 55);
      score += atHistoricalLow ? 10 : 0;
      score += bestCurrent ? 8 : 0;
      score += clamp(profitSek / 70, -10, 25);
      score += item.condition === 'outlet' ? 6 : item.condition === 'new' ? 4 : item.condition === 'used' ? 2 : 0;
      score = Math.round(clamp(score, 0, 100));

      const reasons = [];

      if (discountPercent > 0) {
        reasons.push(`${discountPercent}% under comparison price`);
      }

      if (item.referenceTitle) {
        reasons.push('matched against regular catalog price');
      }

      if (profitSek > 0) {
        reasons.push(`estimated resale spread ${formatSek(profitSek)}`);
      }

      if (atHistoricalLow) {
        reasons.push('near historical low');
      }

      if (bestCurrent) {
        reasons.push('best current price in tracked set');
      }

      const amazingDeal =
        comparisonPriceSek > item.latestPriceSek &&
        discountPercent >= thresholds.minimumDiscountPercent &&
        profitSek >= thresholds.minimumProfitSek &&
        score >= thresholds.minimumScore;

      return {
        dealId: `${item.listingKey}:${item.latestPriceSek}`,
        listingKey: item.listingKey,
        productKey: item.productKey,
        title: item.title,
        url: item.url,
        sourceId: item.sourceId,
        sourceLabel: item.sourceLabel,
        sourceType: item.sourceType,
        category: item.category,
        condition: item.condition,
        availability: item.availability,
        currentPriceSek: item.latestPriceSek,
        shippingEstimateSek: item.shippingEstimateSek ?? 0,
        feesEstimateSek: item.feesEstimateSek ?? 0,
        totalCostSek,
        comparisonPriceSek,
        referenceConfidence,
        referenceUrl: item.referenceUrl ?? null,
        referenceTitle: item.referenceTitle ?? null,
        referenceSourceLabel: item.referenceSourceLabel ?? null,
        estimatedPrivateSaleSek,
        profitSek,
        lowestSeenSek: item.lowestPriceSek,
        discountPercent,
        score,
        amazingDeal,
        reasons,
        bestCurrent,
        atHistoricalLow,
        description: item.description ?? null,
        imageUrl: item.imageUrl ?? null,
        conditionLabel: item.conditionLabel ?? null,
        keyshopPriceSek: item.keyshopPriceSek ?? null,
        historicalKeyshopPriceSek: item.historicalKeyshopPriceSek ?? null,
        steamAppId: item.steamAppId ?? null,
        lastSeenAt: item.lastSeenAt
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.currentPriceSek - right.currentPriceSek;
    });
}

export function buildProductSummaries(state) {
  const products = new Map();

  for (const deal of state.deals) {
    if (!products.has(deal.productKey)) {
      products.set(deal.productKey, {
        productKey: deal.productKey,
        title: deal.title,
        category: deal.category,
        bestPriceSek: deal.currentPriceSek,
        bestScore: deal.score,
        amazingOfferCount: 0,
        offerCount: 0,
        offers: []
      });
    }

    const summary = products.get(deal.productKey);
    summary.bestPriceSek = Math.min(summary.bestPriceSek, deal.currentPriceSek);
    summary.bestScore = Math.max(summary.bestScore, deal.score);
    summary.offerCount += 1;
    summary.amazingOfferCount += deal.amazingDeal ? 1 : 0;
    summary.offers.push(deal);
  }

  return [...products.values()]
    .map((summary) => ({
      ...summary,
      offers: summary.offers.sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.currentPriceSek - right.currentPriceSek;
      })
    }))
    .sort((left, right) => {
      if (right.bestScore !== left.bestScore) {
        return right.bestScore - left.bestScore;
      }

      return left.bestPriceSek - right.bestPriceSek;
    });
}
