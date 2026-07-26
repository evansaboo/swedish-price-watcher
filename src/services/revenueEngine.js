import crypto from 'node:crypto';

export const INVENTORY_STATUSES = new Set([
  'watching',
  'bought',
  'listed',
  'sold',
  'returned',
  'skipped'
]);

export const DEFAULT_COST_DEFAULTS = Object.freeze({
  inboundShippingSek: 0,
  outboundShippingSek: 0,
  packagingSek: 0,
  repairAllowanceSek: 0,
  returnRiskPercent: 0,
  sellingFeePercent: 0,
  sellingFeeFixedSek: 60
});

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nullableAmount(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function cleanString(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function uniqueStrings(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => cleanString(entry, 120))
      .filter(Boolean)
  )];
}

export function normalizeCostDefaults(raw = {}, legacyFlatFeeSek = 60) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    inboundShippingSek: finiteNonNegative(source.inboundShippingSek),
    outboundShippingSek: finiteNonNegative(source.outboundShippingSek),
    packagingSek: finiteNonNegative(source.packagingSek),
    repairAllowanceSek: finiteNonNegative(source.repairAllowanceSek),
    returnRiskPercent: Math.min(100, finiteNonNegative(source.returnRiskPercent)),
    sellingFeePercent: Math.min(100, finiteNonNegative(source.sellingFeePercent)),
    sellingFeeFixedSek: finiteNonNegative(source.sellingFeeFixedSek, finiteNonNegative(legacyFlatFeeSek, 60))
  };
}

export function ensureRevenueState(preferences = {}) {
  const raw = preferences.revenue && typeof preferences.revenue === 'object'
    ? preferences.revenue
    : {};
  const revenue = {
    promotions: Array.isArray(raw.promotions) ? raw.promotions : [],
    inventory: raw.inventory && typeof raw.inventory === 'object' && !Array.isArray(raw.inventory)
      ? raw.inventory
      : {},
    costDefaults: normalizeCostDefaults(raw.costDefaults),
    clicks: {
      total: finiteNonNegative(raw.clicks?.total),
      bySource: raw.clicks?.bySource && typeof raw.clicks.bySource === 'object' ? raw.clicks.bySource : {},
      byDay: raw.clicks?.byDay && typeof raw.clicks.byDay === 'object' ? raw.clicks.byDay : {}
    },
    subscribers: Array.isArray(raw.subscribers) ? raw.subscribers : []
  };
  preferences.revenue = revenue;
  return revenue;
}

export function normalizePromotion(raw, existing = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const valueFor = (key) => Object.prototype.hasOwnProperty.call(input, key) ? input[key] : existing[key];
  const discountType = valueFor('discountType') === 'percent' ? 'percent' : 'fixed';
  const value = finiteNonNegative(valueFor('value'), NaN);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Promotion value must be greater than zero.');
  }
  if (discountType === 'percent' && value > 100) {
    throw new Error('Percentage promotions cannot exceed 100%.');
  }

  const sourceId = cleanString(valueFor('sourceId'), 120);
  if (!sourceId) throw new Error('Promotion sourceId is required.');

  const id = cleanString(existing.id || valueFor('id'), 120) || `promo-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  return {
    id,
    sourceId,
    label: cleanString(valueFor('label'), 160) || 'Promotion',
    code: cleanString(valueFor('code'), 100),
    discountType,
    value,
    minSpendSek: finiteNonNegative(valueFor('minSpendSek')),
    maxDiscountSek: nullableAmount(valueFor('maxDiscountSek')),
    categories: uniqueStrings(valueFor('categories')),
    titleIncludes: uniqueStrings(valueFor('titleIncludes')),
    startsAt: cleanString(valueFor('startsAt'), 40) || null,
    expiresAt: cleanString(valueFor('expiresAt'), 40) || null,
    stackable: valueFor('stackable') === true,
    enabled: valueFor('enabled') !== false,
    verified: valueFor('verified') === true,
    verificationUrl: cleanString(valueFor('verificationUrl'), 1000) || null,
    notes: cleanString(valueFor('notes'), 1000),
    createdAt: existing.createdAt ?? now,
    updatedAt: now
  };
}

function isPromotionActive(promotion, nowMs) {
  if (!promotion?.enabled || !promotion.verified) return false;
  const startsAt = Date.parse(promotion.startsAt ?? '');
  if (!Number.isNaN(startsAt) && startsAt > nowMs) return false;
  const expiresAt = Date.parse(promotion.expiresAt ?? '');
  if (!Number.isNaN(expiresAt) && expiresAt <= nowMs) return false;
  return true;
}

export function calculatePromotionDiscount(item, promotion, now = new Date()) {
  const priceSek = Number(item?.latestPriceSek ?? item?.currentPriceSek ?? item?.buyPriceSek);
  if (!Number.isFinite(priceSek) || priceSek <= 0) return 0;
  if (!isPromotionActive(promotion, now.getTime())) return 0;
  if (promotion.sourceId !== item.sourceId) return 0;
  if (priceSek < finiteNonNegative(promotion.minSpendSek)) return 0;

  const category = cleanString(item.category, 200).toLowerCase();
  const categories = uniqueStrings(promotion.categories).map((entry) => entry.toLowerCase());
  if (categories.length && !categories.some((entry) => category.includes(entry))) return 0;

  const title = cleanString(item.title, 500).toLowerCase();
  const titleIncludes = uniqueStrings(promotion.titleIncludes).map((entry) => entry.toLowerCase());
  if (titleIncludes.length && !titleIncludes.every((entry) => title.includes(entry))) return 0;

  let discount = promotion.discountType === 'percent'
    ? priceSek * (finiteNonNegative(promotion.value) / 100)
    : finiteNonNegative(promotion.value);
  if (Number.isFinite(promotion.maxDiscountSek)) {
    discount = Math.min(discount, promotion.maxDiscountSek);
  }
  return Math.max(0, Math.min(priceSek, Math.round(discount)));
}

export function findBestPromotion(item, promotions = [], now = new Date()) {
  let best = null;
  for (const promotion of promotions) {
    const discountSek = calculatePromotionDiscount(item, promotion, now);
    if (discountSek <= 0 || (best && discountSek <= best.discountSek)) continue;
    best = {
      id: promotion.id,
      label: promotion.label,
      code: promotion.code || null,
      discountSek,
      expiresAt: promotion.expiresAt ?? null,
      verified: true,
      stackable: promotion.stackable === true
    };
  }
  return best;
}

export function calculateProjectedProfit({
  item,
  expectedResaleSek,
  promotions = [],
  costDefaults = {},
  legacyFlatFeeSek = 60,
  now = new Date()
}) {
  const buyPriceSek = Math.round(finiteNonNegative(
    item?.latestPriceSek ?? item?.currentPriceSek ?? item?.buyPriceSek
  ));
  const resaleSek = Math.round(finiteNonNegative(expectedResaleSek));
  const defaults = normalizeCostDefaults(costDefaults, legacyFlatFeeSek);
  const promotion = findBestPromotion(item, promotions, now);
  const promotionDiscountSek = promotion?.discountSek ?? 0;
  const inboundShippingSek = finiteNonNegative(item?.shippingEstimateSek, defaults.inboundShippingSek);
  const effectiveBuyPriceSek = Math.max(0, buyPriceSek + inboundShippingSek - promotionDiscountSek);
  const sellingFeeSek = Math.round(
    defaults.sellingFeeFixedSek + resaleSek * (defaults.sellingFeePercent / 100)
  );
  const returnRiskSek = Math.round(resaleSek * (defaults.returnRiskPercent / 100));
  const projectedCostsSek = Math.round(
    defaults.outboundShippingSek +
    defaults.packagingSek +
    defaults.repairAllowanceSek +
    sellingFeeSek +
    returnRiskSek
  );
  const netProfitSek = Math.round(resaleSek - effectiveBuyPriceSek - projectedCostsSek);
  const roiPercent = effectiveBuyPriceSek > 0
    ? Math.round((netProfitSek / effectiveBuyPriceSek) * 100)
    : 0;

  return {
    buyPriceSek,
    effectiveBuyPriceSek,
    promotion,
    promotionDiscountSek,
    inboundShippingSek,
    outboundShippingSek: defaults.outboundShippingSek,
    packagingSek: defaults.packagingSek,
    repairAllowanceSek: defaults.repairAllowanceSek,
    sellingFeeSek,
    returnRiskSek,
    projectedCostsSek,
    netProfitSek,
    roiPercent
  };
}

function snapshotProduct(product = {}) {
  return {
    listingKey: cleanString(product.listingKey, 300),
    title: cleanString(product.title, 500),
    url: cleanString(product.url, 2000) || null,
    imageUrl: cleanString(product.imageUrl, 2000) || null,
    sourceId: cleanString(product.sourceId, 120),
    sourceLabel: cleanString(product.sourceLabel, 200),
    category: cleanString(product.category, 200),
    displayedPriceSek: nullableAmount(
      product.latestPriceSek ?? product.currentPriceSek ?? product.buyPriceSek
    ),
    projectedResaleSek: nullableAmount(product.expectedResaleSek ?? product.resaleMedianSek),
    projectedProfitSek: nullableAmount(product.netProfitSek),
    projectedRoiPercent: nullableAmount(product.roiPercent)
  };
}

export function createInventoryRecord(product, input = {}, now = new Date()) {
  const listingKey = cleanString(product?.listingKey, 300);
  if (!listingKey) throw new Error('A valid listingKey is required.');
  const timestamp = now.toISOString();
  return updateInventoryRecord({
    id: `inventory-${crypto.randomUUID()}`,
    listingKey,
    status: 'watching',
    product: snapshotProduct(product),
    createdAt: timestamp,
    updatedAt: timestamp,
    events: []
  }, input, now, true);
}

export function updateInventoryRecord(existing, input = {}, now = new Date(), creating = false) {
  const timestamp = now.toISOString();
  const nextStatus = cleanString(input.status ?? existing.status, 30) || 'watching';
  if (!INVENTORY_STATUSES.has(nextStatus)) {
    throw new Error(`Unsupported inventory status: ${nextStatus}`);
  }
  const valueFor = (key) => Object.prototype.hasOwnProperty.call(input, key) ? input[key] : existing[key];

  const record = {
    ...existing,
    status: nextStatus,
    purchasePriceSek: nullableAmount(valueFor('purchasePriceSek')),
    promotionDiscountSek: nullableAmount(valueFor('promotionDiscountSek')) ?? 0,
    cashbackSek: nullableAmount(valueFor('cashbackSek')) ?? 0,
    inboundShippingSek: nullableAmount(valueFor('inboundShippingSek')) ?? 0,
    outboundShippingSek: nullableAmount(valueFor('outboundShippingSek')) ?? 0,
    sellingFeeSek: nullableAmount(valueFor('sellingFeeSek')) ?? 0,
    packagingSek: nullableAmount(valueFor('packagingSek')) ?? 0,
    repairCostSek: nullableAmount(valueFor('repairCostSek')) ?? 0,
    salePriceSek: nullableAmount(valueFor('salePriceSek')),
    purchaseDate: cleanString(valueFor('purchaseDate'), 40) || null,
    listedDate: cleanString(valueFor('listedDate'), 40) || null,
    soldDate: cleanString(valueFor('soldDate'), 40) || null,
    salesChannel: cleanString(valueFor('salesChannel'), 120),
    notes: cleanString(valueFor('notes'), 2000),
    updatedAt: timestamp,
    events: Array.isArray(existing.events) ? [...existing.events] : []
  };

  if (creating || nextStatus !== existing.status) {
    record.events.push({
      at: timestamp,
      type: creating ? 'created' : 'status-changed',
      from: creating ? null : existing.status,
      to: nextStatus
    });
  }
  record.events = record.events.slice(-100);
  return materializeInventoryRecord(record);
}

export function materializeInventoryRecord(record) {
  const purchasePriceSek = nullableAmount(record.purchasePriceSek);
  const salePriceSek = nullableAmount(record.salePriceSek);
  const acquisitionCostSek = purchasePriceSek == null
    ? null
    : Math.max(
        0,
        purchasePriceSek +
          finiteNonNegative(record.inboundShippingSek) -
          finiteNonNegative(record.promotionDiscountSek) -
          finiteNonNegative(record.cashbackSek)
      );
  const saleCostsSek = Math.round(
    finiteNonNegative(record.outboundShippingSek) +
    finiteNonNegative(record.sellingFeeSek) +
    finiteNonNegative(record.packagingSek) +
    finiteNonNegative(record.repairCostSek)
  );
  const realizedProfitSek = acquisitionCostSek != null && salePriceSek != null
    ? Math.round(salePriceSek - acquisitionCostSek - saleCostsSek)
    : null;
  const realizedRoiPercent = acquisitionCostSek > 0 && realizedProfitSek != null
    ? Math.round((realizedProfitSek / acquisitionCostSek) * 100)
    : null;
  const purchaseTs = Date.parse(record.purchaseDate ?? record.createdAt ?? '');
  const endTs = Date.parse(record.soldDate ?? record.updatedAt ?? '');
  const capitalDays = !Number.isNaN(purchaseTs) && !Number.isNaN(endTs) && ['bought', 'listed', 'sold', 'returned'].includes(record.status)
    ? Math.max(0, Math.ceil((endTs - purchaseTs) / 86_400_000))
    : null;

  return {
    ...record,
    acquisitionCostSek,
    saleCostsSek,
    realizedProfitSek,
    realizedRoiPercent,
    capitalDays,
    forecastErrorSek: realizedProfitSek != null && Number.isFinite(record.product?.projectedProfitSek)
      ? Math.round(realizedProfitSek - record.product.projectedProfitSek)
      : null
  };
}

export function buildRevenueSummary(records = []) {
  const materialized = records.map(materializeInventoryRecord);
  const sold = materialized.filter((record) => record.status === 'sold' && Number.isFinite(record.realizedProfitSek));
  const active = materialized.filter((record) => ['bought', 'listed'].includes(record.status));
  const realizedProfitSek = sold.reduce((sum, record) => sum + record.realizedProfitSek, 0);
  const capitalTiedSek = active.reduce((sum, record) => sum + (record.acquisitionCostSek ?? 0), 0);
  const avgRoiPercent = sold.length
    ? Math.round(sold.reduce((sum, record) => sum + (record.realizedRoiPercent ?? 0), 0) / sold.length)
    : 0;
  const avgCapitalDays = sold.length
    ? Math.round(sold.reduce((sum, record) => sum + (record.capitalDays ?? 0), 0) / sold.length)
    : 0;
  const forecasted = sold.filter((record) => Number.isFinite(record.forecastErrorSek));
  const avgAbsoluteForecastErrorSek = forecasted.length
    ? Math.round(forecasted.reduce((sum, record) => sum + Math.abs(record.forecastErrorSek), 0) / forecasted.length)
    : 0;

  return {
    tracked: materialized.length,
    watching: materialized.filter((record) => record.status === 'watching').length,
    active: active.length,
    sold: sold.length,
    realizedProfitSek: Math.round(realizedProfitSek),
    capitalTiedSek: Math.round(capitalTiedSek),
    avgRoiPercent,
    avgCapitalDays,
    avgAbsoluteForecastErrorSek
  };
}
