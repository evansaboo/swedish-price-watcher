import test from 'node:test';
import assert from 'node:assert/strict';

import { collectFromPower } from '../src/sources/power.js';

const SOURCE = { id: 'power-deals', type: 'power-deals', label: 'Power Outlet' };
const NOW = '2026-06-12T12:00:00.000Z';

// Shape from the live power.se productlists API (June 2026)
function makeApiItem(overrides = {}) {
  return {
    productId: 3479990,
    title: 'Apple iPhone 16 128GB Svart',
    price: 7990,
    previousPrice: 9990,
    outletProductNormalPrice: null,
    url: '/mobil/iphone-16/p-3479990/',
    categoryName: 'Mobiltelefoner',
    outletReason: 'Returvara',
    eanGtin12: '195949688485',
    barcode: '195949688485',
    productManufactorIdentity: 'MXP63DN/A',
    productImage: null,
    ...overrides
  };
}

function makeFetcher(pages) {
  let call = 0;
  return {
    async fetchText() {
      const body = JSON.stringify(pages[Math.min(call++, pages.length - 1)]);
      return { body };
    }
  };
}

test('power collector maps gtin and manufacturer part number', async () => {
  const fetcher = makeFetcher([{ products: [makeApiItem()], isLastPage: true }]);
  const sourceState = {};
  const obs = await collectFromPower({ source: SOURCE, sourceState, fetcher, now: NOW });

  assert.equal(obs.length, 1);
  assert.equal(obs[0].gtin, '195949688485');
  assert.equal(obs[0].manufacturerArticleNumber, 'MXP63DN/A');
  assert.equal(obs[0].priceSek, 7990);
  assert.equal(obs[0].referencePriceSek, 9990);
  assert.equal(sourceState.lastScanPartial, false);
});

test('power collector handles items without identifiers', async () => {
  const fetcher = makeFetcher([{ products: [makeApiItem({ eanGtin12: null, barcode: null, productManufactorIdentity: null })], isLastPage: true }]);
  const obs = await collectFromPower({ source: SOURCE, sourceState: {}, fetcher, now: NOW });

  assert.equal(obs.length, 1);
  assert.equal(obs[0].gtin, null);
  assert.equal(obs[0].manufacturerArticleNumber, null);
});

test('power campaign mode keeps only real markdowns', async () => {
  const campaignSource = { ...SOURCE, id: 'power-campaigns', outletOnly: false, minDiscountPct: 15 };
  const fetcher = makeFetcher([{
    products: [
      makeApiItem({ productId: 1, previousPrice: 10000, price: 7000 }),  // 30% off → kept
      makeApiItem({ productId: 2, previousPrice: 10000, price: 9500 }),  // 5% off → dropped
      makeApiItem({ productId: 3, previousPrice: null, price: 5000 })    // no reference → dropped
    ],
    isLastPage: true
  }]);
  const obs = await collectFromPower({ source: campaignSource, sourceState: {}, fetcher, now: NOW });

  assert.equal(obs.length, 1);
  assert.equal(obs[0].externalId, '1');
  assert.equal(obs[0].condition, 'deal');
});
