import { buildListingKey, clamp, firstFinite, formatSek, median } from '../lib/utils.js';

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
    currentItem.imageUrl = observation.imageUrl ?? null;
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
  const groupedItems = new Map();

  for (const item of items) {
    if (!groupedItems.has(item.productKey)) {
      groupedItems.set(item.productKey, []);
    }

    groupedItems.get(item.productKey).push(item);
  }

  return items
    .map((item) => {
      const peers = groupedItems.get(item.productKey) ?? [item];
      const peerCurrentPrices = currentPrices(peers);
      const peerHistoryPrices = historyPrices(peers);
      const comparisonPriceSek = firstFinite(
        item.marketValueSek,
        item.referencePriceSek,
        median(peerCurrentPrices),
        median(peerHistoryPrices),
        item.latestPriceSek
      );
      const bestCurrentSek = peerCurrentPrices.length ? Math.min(...peerCurrentPrices) : item.latestPriceSek;
      const estimatedPrivateSaleSek =
        item.resaleEstimateSek ?? Math.round(comparisonPriceSek * resaleFactorForCondition(item.condition));
      const totalCostSek = item.latestPriceSek + (item.shippingEstimateSek ?? 0) + (item.feesEstimateSek ?? 0);
      const profitSek = estimatedPrivateSaleSek - totalCostSek;
      const discountPercent =
        comparisonPriceSek > 0 ? Math.round(((comparisonPriceSek - item.latestPriceSek) / comparisonPriceSek) * 100) : 0;
      const atHistoricalLow =
        Number.isFinite(item.lowestPriceSek) && item.latestPriceSek <= Math.round(item.lowestPriceSek * 1.02);
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
