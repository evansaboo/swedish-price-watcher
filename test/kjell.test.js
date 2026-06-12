import test from 'node:test';
import assert from 'node:assert/strict';

import { extractKjellProducts, mapKjellProduct, resolveKjellCategory } from '../src/sources/kjell.js';

const SOURCE = { id: 'kjell-outlet', type: 'kjell-outlet', label: 'Kjell & Company Outlet' };
const NOW = '2026-06-12T08:00:00.000Z';

// Shape captured from live kjell.com /se/outlet JSON (June 2026)
function makeProduct(overrides = {}) {
  return {
    title: 'Cube 2 Pro smart projektor med Full HD och Android TV 11',
    brandName: 'Wanbo',
    productCode: 'P924128',
    code: '29994-A',
    url: '/se/outlet/ljud-bild/tv-tillbehor/projektorer/wanbo-cube-2-pro-p29994?outlet=a',
    imageUrls: [{ width: 3200, height: 3200, url: '/globalassets/productimages/937596_29994_01.webp?ref=6F921CB0D9' }],
    price: { priceType: 'ordinary', currentInclVat: 2125, originalInclVat: 2125, discountPercentage: 0 },
    anyVariantBuyableOnline: true,
    trackingProduct: {
      item_category: 'Ljud & bild',
      item_category2: 'TV & tillbehör',
      item_category3: 'Projektorer'
    },
    ...overrides
  };
}

test('mapKjellProduct maps core fields', () => {
  const obs = mapKjellProduct(makeProduct(), SOURCE, NOW);
  assert.ok(obs);
  assert.equal(obs.externalId, 'P924128-A');
  assert.equal(obs.title, 'Wanbo Cube 2 Pro smart projektor med Full HD och Android TV 11');
  assert.equal(obs.priceSek, 2125);
  assert.equal(obs.condition, 'outlet');
  assert.equal(obs.conditionLabel, 'Outlet A');
  assert.equal(obs.category, 'Projektorer');
  assert.equal(obs.url, 'https://www.kjell.com/se/outlet/ljud-bild/tv-tillbehor/projektorer/wanbo-cube-2-pro-p29994?outlet=a');
  assert.equal(obs.imageUrl, 'https://www.kjell.com/globalassets/productimages/937596_29994_01.webp?ref=6F921CB0D9');
  assert.equal(obs.availability, 'in_stock');
});

test('mapKjellProduct keeps A and B grades as separate listings', () => {
  const a = mapKjellProduct(makeProduct(), SOURCE, NOW);
  const b = mapKjellProduct(makeProduct({ url: '/se/outlet/ljud-bild/tv-tillbehor/projektorer/wanbo-cube-2-pro-p29994?outlet=b' }), SOURCE, NOW);
  assert.notEqual(a.externalId, b.externalId);
  assert.equal(b.conditionLabel, 'Outlet B');
});

test('mapKjellProduct uses originalInclVat as reference only when above current price', () => {
  const same = mapKjellProduct(makeProduct(), SOURCE, NOW);
  assert.equal(same.referencePriceSek, null, 'equal original/current must not produce a fake discount');

  const discounted = mapKjellProduct(
    makeProduct({ price: { priceType: 'campaign', currentInclVat: 1611, originalInclVat: 1790 } }),
    SOURCE, NOW
  );
  assert.equal(discounted.referencePriceSek, 1790);
  assert.equal(discounted.priceSek, 1611);
});

test('mapKjellProduct rejects items without price, title, or outlet URL', () => {
  assert.equal(mapKjellProduct(makeProduct({ price: { currentInclVat: 0 } }), SOURCE, NOW), null);
  assert.equal(mapKjellProduct(makeProduct({ title: '' }), SOURCE, NOW), null);
  assert.equal(mapKjellProduct(makeProduct({ url: '/se/produkter/something-p1' }), SOURCE, NOW), null);
});

test('mapKjellProduct does not duplicate brand already in title', () => {
  const obs = mapKjellProduct(makeProduct({ title: 'Wanbo Cube 2 Pro', brandName: 'Wanbo' }), SOURCE, NOW);
  assert.equal(obs.title, 'Wanbo Cube 2 Pro');
});

test('mapKjellProduct falls back to URL slug category when tracking data missing', () => {
  const obs = mapKjellProduct(makeProduct({ trackingProduct: null }), SOURCE, NOW);
  assert.equal(obs.category, 'Tv tillbehor');
});

test('extractKjellProducts handles both page-1 and page-N response shapes', () => {
  const nested = { products: { products: [makeProduct()], totalProductCount: 3306 } };
  assert.equal(extractKjellProducts(nested).length, 1);

  const flat = [makeProduct(), makeProduct()];
  assert.equal(extractKjellProducts(flat).length, 2);

  assert.equal(extractKjellProducts({}).length, 0);
  assert.equal(extractKjellProducts(null).length, 0);
});

test('resolveKjellCategory prefers subcategory slug', () => {
  assert.equal(resolveKjellCategory('/se/outlet/ljud-bild/tv-tillbehor/projektorer/x-p1?outlet=a'), 'Tv tillbehor');
  assert.equal(resolveKjellCategory('/se/outlet/gaming/y-p2'), 'Gaming');
  assert.equal(resolveKjellCategory('/se/outlet'), 'Outlet');
});
