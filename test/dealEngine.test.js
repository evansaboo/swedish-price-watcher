import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultState } from '../src/lib/store.js';
import { computeDeals, mergeObservations } from '../src/services/dealEngine.js';

const thresholds = {
  minimumScore: 65,
  minimumDiscountPercent: 18,
  minimumProfitSek: 400
};

test('flags a strong outlet deal as amazing', () => {
  const state = createDefaultState();

  mergeObservations(
    state,
    [
      {
        sourceId: 'store-a',
        sourceLabel: 'Store A',
        sourceType: 'html-page',
        externalId: 'listing-a',
        productKey: 'sony-wh1000xm5',
        title: 'Sony WH-1000XM5 outlet',
        url: 'https://example.com/a',
        category: 'headphones',
        condition: 'outlet',
        priceSek: 3490,
        marketValueSek: 4990,
        resaleEstimateSek: 4400,
        shippingEstimateSek: 0,
        feesEstimateSek: 0,
        availability: 'in stock',
        seenAt: '2026-04-16T00:00:00.000Z'
      },
      {
        sourceId: 'store-b',
        sourceLabel: 'Store B',
        sourceType: 'html-page',
        externalId: 'listing-b',
        productKey: 'sony-wh1000xm5',
        title: 'Sony WH-1000XM5 new',
        url: 'https://example.com/b',
        category: 'headphones',
        condition: 'new',
        priceSek: 4890,
        marketValueSek: 4990,
        resaleEstimateSek: 4500,
        shippingEstimateSek: 0,
        feesEstimateSek: 0,
        availability: 'in stock',
        seenAt: '2026-04-16T00:00:00.000Z'
      }
    ],
    60
  );

  const deals = computeDeals(state, thresholds);
  const outletDeal = deals.find((deal) => deal.listingKey === 'store-a:listing-a');

  assert.equal(outletDeal.amazingDeal, true);
  assert.ok(outletDeal.score >= thresholds.minimumScore);
  assert.ok(outletDeal.profitSek >= thresholds.minimumProfitSek);
});

test('does not flag a weak deal', () => {
  const state = createDefaultState();

  mergeObservations(
    state,
    [
      {
        sourceId: 'store-c',
        sourceLabel: 'Store C',
        sourceType: 'html-page',
        externalId: 'listing-c',
        productKey: 'cheap-mouse',
        title: 'Cheap mouse',
        url: 'https://example.com/c',
        category: 'accessories',
        condition: 'used',
        priceSek: 540,
        marketValueSek: 590,
        resaleEstimateSek: 560,
        shippingEstimateSek: 79,
        feesEstimateSek: 0,
        availability: 'in stock',
        seenAt: '2026-04-16T00:00:00.000Z'
      }
    ],
    60
  );

  const deals = computeDeals(state, thresholds);
  const weakDeal = deals.find((deal) => deal.listingKey === 'store-c:listing-c');

  assert.equal(weakDeal.amazingDeal, false);
  assert.ok(weakDeal.score < thresholds.minimumScore);
});

test('tracks price drop events when an outlet listing gets cheaper', () => {
  const state = createDefaultState();

  mergeObservations(
    state,
    [
      {
        sourceId: 'store-d',
        sourceLabel: 'Store D',
        sourceType: 'apify-elgiganten',
        externalId: 'listing-d',
        productKey: 'sony-wh1000xm5',
        title: 'Sony WH-1000XM5 outlet',
        url: 'https://example.com/d',
        category: 'Horlurar',
        condition: 'outlet',
        priceSek: 3190,
        marketValueSek: 4490,
        referencePriceSek: 4490,
        shippingEstimateSek: 0,
        feesEstimateSek: 0,
        availability: 'in stock',
        seenAt: '2026-04-17T00:00:00.000Z'
      }
    ],
    60
  );

  const secondMerge = mergeObservations(
    state,
    [
      {
        sourceId: 'store-d',
        sourceLabel: 'Store D',
        sourceType: 'apify-elgiganten',
        externalId: 'listing-d',
        productKey: 'sony-wh1000xm5',
        title: 'Sony WH-1000XM5 outlet',
        url: 'https://example.com/d',
        category: 'Horlurar',
        condition: 'outlet',
        priceSek: 2790,
        marketValueSek: 4490,
        referencePriceSek: 4490,
        shippingEstimateSek: 0,
        feesEstimateSek: 0,
        availability: 'in stock',
        seenAt: '2026-04-17T01:00:00.000Z'
      }
    ],
    60
  );

  assert.equal(secondMerge.newItems.length, 0);
  assert.equal(secondMerge.priceDrops.length, 1);
  assert.equal(secondMerge.priceDrops[0].previousPriceSek, 3190);
  assert.equal(secondMerge.priceDrops[0].newPriceSek, 2790);
  assert.equal(secondMerge.priceDrops[0].dropSek, 400);
});

test('keeps matched reference and readable category when later observations are incomplete', () => {
  const state = createDefaultState();

  mergeObservations(
    state,
    [
      {
        sourceId: 'store-e',
        sourceLabel: 'Store E',
        sourceType: 'apify-elgiganten',
        externalId: 'listing-e',
        productKey: 'sony-wh1000xm5',
        title: 'Sony WH-1000XM5 outlet',
        url: 'https://example.com/e',
        category: 'Horlurar',
        categoryGroupId: '55520',
        condition: 'outlet',
        priceSek: 2990,
        referencePriceSek: 3990,
        referenceTitle: 'Sony WH-1000XM5',
        referenceUrl: 'https://example.com/new-e',
        referenceSourceLabel: 'Elgiganten',
        referenceMatchType: 'catalog-match',
        shippingEstimateSek: 0,
        feesEstimateSek: 0,
        availability: 'in stock',
        seenAt: '2026-04-17T00:00:00.000Z'
      }
    ],
    60
  );

  mergeObservations(
    state,
    [
      {
        sourceId: 'store-e',
        sourceLabel: 'Store E',
        sourceType: 'apify-elgiganten',
        externalId: 'listing-e',
        productKey: 'sony-wh1000xm5',
        title: 'Sony WH-1000XM5 outlet',
        url: 'https://example.com/e',
        category: 'Kategori 55520',
        categoryGroupId: '55520',
        condition: 'outlet',
        priceSek: 2890,
        referencePriceSek: null,
        referenceTitle: null,
        referenceUrl: null,
        referenceSourceLabel: null,
        referenceMatchType: null,
        shippingEstimateSek: 0,
        feesEstimateSek: 0,
        availability: 'in stock',
        seenAt: '2026-04-17T01:00:00.000Z'
      }
    ],
    60
  );

  const item = state.items['store-e:listing-e'];
  assert.equal(item.category, 'Horlurar');
  assert.equal(item.referencePriceSek, 3990);
  assert.equal(item.referenceTitle, 'Sony WH-1000XM5');
  assert.equal(item.referenceMatchType, 'catalog-match');
});

test('buildIdentityGroups links items across stores via GTIN and manufacturer part number', async () => {
  const { buildIdentityGroups } = await import('../src/services/dealEngine.js');
  const items = [
    // Same GPU at three stores: A↔B share a GTIN, B↔C share a part number — transitive link
    { listingKey: 'a:1', productKey: 'asus-rtx-4070-dual-oc', gtin: '4711081898019', latestPriceSek: 7000 },
    { listingKey: 'b:1', productKey: 'rtx-4070-dual', gtin: '4711081898019', manufacturerArticleNumber: 'DUAL-RTX4070-O12G', latestPriceSek: 6500 },
    { listingKey: 'c:1', productKey: 'asus-dual-geforce-rtx-4070', manufacturerArticleNumber: 'DUAL-RTX4070-O12G', latestPriceSek: 6800 },
    // Unrelated item
    { listingKey: 'd:1', productKey: 'sony-wh-1000xm5', latestPriceSek: 2500 },
    // Same productKey as d:1 → grouped by title fallback
    { listingKey: 'e:1', productKey: 'sony-wh-1000xm5', latestPriceSek: 2400 }
  ];

  const groups = buildIdentityGroups(items);
  const sizes = [...groups.values()].map(g => g.length).sort();
  assert.deepEqual(sizes, [2, 3], 'one GPU group of 3, one headphone group of 2');

  const gpuGroup = [...groups.values()].find(g => g.length === 3);
  assert.deepEqual(gpuGroup.map(i => i.listingKey).sort(), ['a:1', 'b:1', 'c:1']);
});

test('buildIdentityGroups ignores short or letter-only part numbers', async () => {
  const { buildIdentityGroups } = await import('../src/services/dealEngine.js');
  const items = [
    { listingKey: 'a:1', productKey: 'item-one', manufacturerArticleNumber: 'ABC', latestPriceSek: 100 },
    { listingKey: 'b:1', productKey: 'item-two', manufacturerArticleNumber: 'ABC', latestPriceSek: 200 },
    { listingKey: 'c:1', productKey: 'item-three', manufacturerArticleNumber: 'PRO', latestPriceSek: 300 }
  ];
  const groups = buildIdentityGroups(items);
  assert.equal(groups.size, 3, 'generic 3-letter tokens must not link unrelated items');
});
