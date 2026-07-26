import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRevenueSummary,
  calculateProjectedProfit,
  createInventoryRecord,
  findBestPromotion,
  materializeInventoryRecord,
  normalizePromotion,
  updateInventoryRecord
} from '../src/services/revenueEngine.js';

const PRODUCT = {
  listingKey: 'komplett:gpu-1',
  sourceId: 'komplett-outlet-electronics',
  sourceLabel: 'Komplett B-grade',
  title: 'ASUS RTX 4070 Ti',
  category: 'Grafikkort',
  latestPriceSek: 5000,
  expectedResaleSek: 7500,
  netProfitSek: 1500,
  roiPercent: 30
};

test('verified active promotions reduce effective acquisition cost', () => {
  const promotion = normalizePromotion({
    sourceId: PRODUCT.sourceId,
    label: 'GPU weekend',
    code: 'GPU10',
    discountType: 'percent',
    value: 10,
    maxDiscountSek: 400,
    verified: true,
    enabled: true
  });
  const best = findBestPromotion(PRODUCT, [promotion]);
  assert.equal(best.discountSek, 400);

  const result = calculateProjectedProfit({
    item: PRODUCT,
    expectedResaleSek: 7500,
    promotions: [promotion],
    costDefaults: {
      inboundShippingSek: 100,
      outboundShippingSek: 80,
      packagingSek: 20,
      sellingFeeFixedSek: 50
    }
  });

  assert.equal(result.effectiveBuyPriceSek, 4700);
  assert.equal(result.projectedCostsSek, 150);
  assert.equal(result.netProfitSek, 2650);
});

test('unverified and expired promotions never affect projected profit', () => {
  const unverified = normalizePromotion({
    sourceId: PRODUCT.sourceId,
    discountType: 'fixed',
    value: 1000,
    verified: false
  });
  const expired = normalizePromotion({
    sourceId: PRODUCT.sourceId,
    discountType: 'fixed',
    value: 1000,
    verified: true,
    expiresAt: '2020-01-01T00:00:00.000Z'
  });
  assert.equal(findBestPromotion(PRODUCT, [unverified, expired]), null);
});

test('promotion patches preserve omitted fields and clear nullable fields', () => {
  const existing = normalizePromotion({
    sourceId: PRODUCT.sourceId,
    discountType: 'percent',
    value: 10,
    verified: true,
    expiresAt: '2026-08-01T00:00:00.000Z',
    verificationUrl: 'https://example.com/promotion'
  });
  const patched = normalizePromotion({
    label: 'Extended offer',
    expiresAt: null,
    verificationUrl: null
  }, existing);
  assert.equal(patched.discountType, 'percent');
  assert.equal(patched.value, 10);
  assert.equal(patched.verified, true);
  assert.equal(patched.label, 'Extended offer');
  assert.equal(patched.expiresAt, null);
  assert.equal(patched.verificationUrl, null);
});

test('inventory lifecycle calculates auditable realized profit', () => {
  const created = createInventoryRecord(PRODUCT, { status: 'bought', purchasePriceSek: 5000 });
  const sold = updateInventoryRecord(created, {
    status: 'sold',
    promotionDiscountSek: 400,
    inboundShippingSek: 100,
    salePriceSek: 7000,
    sellingFeeSek: 200,
    outboundShippingSek: 80,
    packagingSek: 20,
    repairCostSek: 100,
    salesChannel: 'Tradera'
  });
  const materialized = materializeInventoryRecord(sold);
  assert.equal(materialized.acquisitionCostSek, 4700);
  assert.equal(materialized.saleCostsSek, 400);
  assert.equal(materialized.realizedProfitSek, 1900);
  assert.equal(materialized.realizedRoiPercent, 40);
  assert.equal(materialized.events.at(-1).to, 'sold');

  const summary = buildRevenueSummary([materialized]);
  assert.equal(summary.sold, 1);
  assert.equal(summary.realizedProfitSek, 1900);
});

test('inventory rejects unsupported statuses', () => {
  assert.throws(
    () => createInventoryRecord(PRODUCT, { status: 'auto-purchased' }),
    /Unsupported inventory status/
  );
});

test('inventory fields can be explicitly cleared', () => {
  const created = createInventoryRecord(PRODUCT, {
    status: 'sold',
    purchasePriceSek: 5000,
    salePriceSek: 7000,
    purchaseDate: '2026-07-01',
    soldDate: '2026-07-10'
  });
  const cleared = updateInventoryRecord(created, {
    purchasePriceSek: null,
    salePriceSek: null,
    purchaseDate: null,
    soldDate: null
  });
  assert.equal(cleared.purchasePriceSek, null);
  assert.equal(cleared.salePriceSek, null);
  assert.equal(cleared.purchaseDate, null);
  assert.equal(cleared.soldDate, null);
  assert.equal(cleared.realizedProfitSek, null);
});
