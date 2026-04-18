import test from 'node:test';
import assert from 'node:assert/strict';

import { collectSource } from '../src/sources/index.js';

// Helper: build a minimal fetch mock that streams the sitemap and falls back to 404.
function makeFetchMock(sitemapXml, sitemapUrl) {
  return async (url) => {
    if (url === sitemapUrl) {
      return new Response(sitemapXml, { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    return new Response('', { status: 404 });
  };
}

const sitemapXml = `
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
      <loc>https://www.komplett.se/product/1334755/demovaror/datorutrustning/demo-ovrigt/asus-nuc-15-pro-slim-u7-255h-b-grade</loc>
      <lastmod>2026-04-15</lastmod>
    </url>
  </urlset>
`;

const outletHtml = `
  <html>
    <head>
      <title>ASUS NUC 15 PRO Slim U7 255H -B-Grade | Komplett.se</title>
      <meta name="title" content="ASUS NUC 15 PRO Slim U7 255H -B-Grade" />
      <meta name="description" content="Outlet unit" />
    </head>
    <body>
      <h1>ASUS NUC 15 PRO Slim U7 255H -B-Grade</h1>
      <p>B-grade pris</p>
      <strong>6 383:-</strong>
      <komplett-demo-condition-info data='{"isDemo":true,"originalMaterialNumber":"1334700","demoType":"01 - As new","demoPrice":0.0,"originalProductPrice":9390.0,"relatedDemos":[]}'></komplett-demo-condition-info>
      <p>1 st i lager (1-3 dagar leveranstid)</p>
    </body>
  </html>
`;

test('collects Komplett outlet items with reference price from embedded JSON', async () => {
  const sitemapUrl = 'https://www.komplett.se/sitemap.products.xml';
  const productResponses = new Map([
    ['https://www.komplett.se/product/1334755/demovaror/datorutrustning/demo-ovrigt/asus-nuc-15-pro-slim-u7-255h-b-grade', outletHtml],
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock(sitemapXml, sitemapUrl);

  try {
    const fetcher = {
      async fetchText(_source, _sourceState, url) {
        return { notModified: false, body: productResponses.get(url) };
      }
    };

    const observations = await collectSource({
      source: {
        id: 'komplett-outlet-electronics',
        type: 'komplett-sitemap',
        label: 'Komplett B-grade',
        condition: 'outlet',
        sitemapUrl,
        includePaths: ['/demovaror/'],
        maxItems: 10,
        updatedSinceDays: 180,
        shippingEstimateSek: 0,
        feesEstimateSek: 0
      },
      fetcher,
      sourceState: {},
      now: '2026-04-16T18:10:00.000Z'
    });

    assert.equal(observations.length, 1);
    assert.equal(observations[0].priceSek, 6383);
    // Reference price now comes from the embedded komplett-demo-condition-info JSON
    assert.equal(observations[0].marketValueSek, 9390);
    assert.equal(observations[0].referencePriceSek, 9390);
    assert.equal(observations[0].referenceUrl, 'https://www.komplett.se/product/1334700/');
    assert.equal(observations[0].productKey, 'asus-nuc-15-pro-slim-u7-255h');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- komplett-category tests ---

const categoryHtml = `<!DOCTYPE html><html><head></head><body>
<script>
window.__catalog__ = {"products":[{"storeId":"312","materialNumber":"1334755","manufacturerPartNumber":"test","name":"ASUS NUC 15 PRO Slim U7 255H -B-Grade","description":"Mini-PC","sticker":{},"url":"/product/1334755/demovaror/datorutrustning/demo-ovrigt/asus-nuc-15-pro-slim-u7-255h-b-grade","stock":{"availabilityStatus":"Stocked","availabilityQuantity":"1","stockIconColor":"green","availabilityText":"1 st i lager"},"price":{"listPrice":"6 383:-","listPriceNumber":6383,"discountNumber":0},"variantGroups":[],"reviewRating":{},"energyLogo":{},"images":[],"productImages":[{"url":"product-media/b2c/en-us","altText":"","fileName":"1334755.jpg","width":1200,"height":1200}],"productBoxVisibility":{}}]};
</script>
</body></html>`;

const categoryProductHtml = `
  <html><body>
    <h1>ASUS NUC 15 PRO Slim U7 255H -B-Grade</h1>
    <komplett-demo-condition-info data='{"isDemo":true,"originalMaterialNumber":"1334700","demoType":"01 - As new","demoPrice":0.0,"originalProductPrice":9390.0,"relatedDemos":[]}'></komplett-demo-condition-info>
  </body></html>
`;

test('komplett-category: collects products from category HTML and fetches reference price', async () => {
  const categoryPageUrl = 'https://www.komplett.se/category/10066/demovaror';
  const productUrl = 'https://www.komplett.se/product/1334755/demovaror/datorutrustning/demo-ovrigt/asus-nuc-15-pro-slim-u7-255h-b-grade';

  const fetcher = {
    async fetchText(_source, _state, url) {
      if (url === categoryPageUrl) return { notModified: false, body: categoryHtml };
      if (url === productUrl) return { notModified: false, body: categoryProductHtml };
      return { notModified: false, body: '' };
    }
  };

  const observations = await collectSource({
    source: {
      id: 'komplett-outlet-electronics',
      type: 'komplett-category',
      label: 'Komplett B-grade',
      condition: 'outlet',
      categoryUrl: categoryPageUrl,
      maxPages: 1,
      refPriceLookupPerScan: 5,
      shippingEstimateSek: 0,
      feesEstimateSek: 0,
    },
    fetcher,
    sourceState: {},
    now: '2026-04-18T12:00:00.000Z',
  });

  assert.equal(observations.length, 1);
  assert.equal(observations[0].priceSek, 6383);
  assert.equal(observations[0].title, 'ASUS NUC 15 PRO Slim U7 255H -B-Grade');
  assert.equal(observations[0].externalId, '1334755');
  assert.equal(observations[0].availability, '1 st i lager');
  // Reference price comes from the product page
  assert.equal(observations[0].marketValueSek, 9390);
  assert.equal(observations[0].referencePriceSek, 9390);
  assert.equal(observations[0].referenceUrl, 'https://www.komplett.se/product/1334700/');
  assert.equal(observations[0].productKey, 'asus-nuc-15-pro-slim-u7-255h');
});

test('komplett-category: uses cached reference price on second scan', async () => {
  const categoryPageUrl = 'https://www.komplett.se/category/10066/demovaror';
  let productPageFetchCount = 0;

  const fetcher = {
    async fetchText(_source, _state, url) {
      if (url === categoryPageUrl) return { notModified: false, body: categoryHtml };
      if (url.includes('/product/1334755/')) {
        productPageFetchCount++;
        return { notModified: false, body: categoryProductHtml };
      }
      return { notModified: false, body: '' };
    }
  };

  const sourceState = {};

  // First scan — should fetch the product page
  await collectSource({
    source: {
      id: 'komplett-outlet-electronics',
      type: 'komplett-category',
      label: 'Komplett B-grade',
      condition: 'outlet',
      categoryUrl: categoryPageUrl,
      maxPages: 1,
      refPriceLookupPerScan: 5,
      shippingEstimateSek: 0,
      feesEstimateSek: 0,
    },
    fetcher,
    sourceState,
    now: '2026-04-18T12:00:00.000Z',
  });

  const fetchesAfterFirstScan = productPageFetchCount;

  // Second scan — reference price already cached, should NOT re-fetch product page
  await collectSource({
    source: {
      id: 'komplett-outlet-electronics',
      type: 'komplett-category',
      label: 'Komplett B-grade',
      condition: 'outlet',
      categoryUrl: categoryPageUrl,
      maxPages: 1,
      refPriceLookupPerScan: 5,
      shippingEstimateSek: 0,
      feesEstimateSek: 0,
    },
    fetcher,
    sourceState, // same state — cache is preserved
    now: '2026-04-18T15:00:00.000Z',
  });

  assert.equal(fetchesAfterFirstScan, 1, 'product page fetched exactly once on first scan');
  assert.equal(productPageFetchCount, 1, 'product page not re-fetched on second scan');
});

