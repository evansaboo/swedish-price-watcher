import test from 'node:test';
import assert from 'node:assert/strict';

// --- komplett-category tests ---
// The category scraper accepts _ApifyClient for injection in tests.

import { collectFromKomplettCategory } from '../src/sources/komplett.js';

// Raw product data as returned by the cheerio-scraper actor.
const actorProduct = {
  storeId: '312',
  materialNumber: '1334755',
  manufacturerPartNumber: 'test',
  name: 'ASUS NUC 15 PRO Slim U7 255H -B-Grade',
  description: 'Mini-PC',
  sticker: {},
  url: '/product/1334755/demovaror/datorutrustning/demo-ovrigt/asus-nuc-15-pro-slim-u7-255h-b-grade',
  stock: { availabilityStatus: 'Stocked', availabilityQuantity: '1', stockIconColor: 'green', availabilityText: '1 st i lager' },
  price: { listPrice: '6 383:-', listPriceNumber: 6383, discountNumber: 0 },
  variantGroups: [],
  reviewRating: {},
  energyLogo: {},
  images: [],
  productImages: [{ url: 'product-media/b2c/en-us', altText: '', fileName: '1334755.jpg', width: 1200, height: 1200 }],
  productBoxVisibility: {},
};

const categoryProductHtml = `
  <html><body>
    <h1>ASUS NUC 15 PRO Slim U7 255H -B-Grade</h1>
    <komplett-demo-condition-info data='{"isDemo":true,"originalMaterialNumber":"1334700","demoType":"01 - As new","demoPrice":0.0,"originalProductPrice":9390.0,"relatedDemos":[]}'></komplett-demo-condition-info>
  </body></html>
`;

/** Build a minimal ApifyClient stub that returns `items` from the actor run. */
function makeApifyStub(items) {
  return class StubApifyClient {
    constructor() {}
    actor() {
      return { call: async () => ({ defaultDatasetId: 'stub-dataset' }) };
    }
    dataset() {
      return { listItems: async () => ({ items }) };
    }
  };
}

function makeSourceOpts({ sourceState, fetcher, now = '2026-04-18T12:00:00.000Z', _ApifyClient }) {
  return {
    source: {
      id: 'komplett-outlet-electronics',
      type: 'komplett-category',
      label: 'Komplett B-grade',
      condition: 'outlet',
      categoryUrl: 'https://www.komplett.se/category/10066/demovaror',
      maxPages: 1,
      refPriceLookupPerScan: 5,
      shippingEstimateSek: 0,
      feesEstimateSek: 0,
    },
    fetcher,
    sourceState,
    now,
    _ApifyClient,
  };
}

test('komplett-category: collects products from actor results and fetches reference price', async () => {
  const productUrl = 'https://www.komplett.se/product/1334755/demovaror/datorutrustning/demo-ovrigt/asus-nuc-15-pro-slim-u7-255h-b-grade';

  const fetcher = {
    async fetchText(_source, _state, url) {
      if (url === productUrl) return { notModified: false, body: categoryProductHtml };
      return { notModified: false, body: '' };
    }
  };

  const observations = await collectFromKomplettCategory(makeSourceOpts({
    sourceState: {},
    fetcher,
    _ApifyClient: makeApifyStub([actorProduct]),
  }));

  assert.equal(observations.length, 1);
  assert.equal(observations[0].priceSek, 6383);
  assert.equal(observations[0].title, 'ASUS NUC 15 PRO Slim U7 255H -B-Grade');
  assert.equal(observations[0].externalId, '1334755');
  assert.equal(observations[0].availability, '1 st i lager');
  assert.equal(observations[0].marketValueSek, 9390);
  assert.equal(observations[0].referencePriceSek, 9390);
  assert.equal(observations[0].referenceUrl, 'https://www.komplett.se/product/1334700/');
  assert.equal(observations[0].productKey, 'asus-nuc-15-pro-slim-u7-255h');
});

test('komplett-category: uses cached reference price on second scan', async () => {
  const productUrl = 'https://www.komplett.se/product/1334755/demovaror/datorutrustning/demo-ovrigt/asus-nuc-15-pro-slim-u7-255h-b-grade';
  let productPageFetchCount = 0;

  const fetcher = {
    async fetchText(_source, _state, url) {
      if (url === productUrl) {
        productPageFetchCount++;
        return { notModified: false, body: categoryProductHtml };
      }
      return { notModified: false, body: '' };
    }
  };

  const sourceState = {};
  const stub = makeApifyStub([actorProduct]);

  await collectFromKomplettCategory(makeSourceOpts({ sourceState, fetcher, _ApifyClient: stub }));
  const fetchesAfterFirstScan = productPageFetchCount;

  await collectFromKomplettCategory(makeSourceOpts({ sourceState, fetcher, now: '2026-04-18T15:00:00.000Z', _ApifyClient: stub }));

  assert.equal(fetchesAfterFirstScan, 1, 'product page fetched exactly once on first scan');
  assert.equal(productPageFetchCount, 1, 'product page not re-fetched on second scan');
});


