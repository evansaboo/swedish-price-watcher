import test from 'node:test';
import assert from 'node:assert/strict';

import { collectSource } from '../src/sources/index.js';

const sitemapXml = `
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
      <loc>https://www.komplett.se/product/1334755/demovaror/datorutrustning/demo-ovrigt/asus-nuc-15-pro-slim-u7-255h-b-grade</loc>
      <lastmod>2026-04-15</lastmod>
    </url>
    <url>
      <loc>https://www.komplett.se/product/1334700/dator-tillbehor/stationar-dator/asus-nuc-15-pro-slim-u7-255h</loc>
      <lastmod>2026-04-14</lastmod>
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
      <p>1 st i lager (1-3 dagar leveranstid)</p>
    </body>
  </html>
`;

const regularHtml = `
  <html>
    <head>
      <title>ASUS NUC 15 PRO Slim U7 255H | Komplett.se</title>
      <meta name="title" content="ASUS NUC 15 PRO Slim U7 255H" />
      <meta name="description" content="Regular unit" />
    </head>
    <body>
      <h1>ASUS NUC 15 PRO Slim U7 255H</h1>
      <strong>9 390:-</strong>
      <p>5 st i lager (1-3 dagar leveranstid)</p>
    </body>
  </html>
`;

test('collects Komplett outlet items and matches regular references', async () => {
  const responses = new Map([
    ['https://www.komplett.se/sitemap.products.xml', sitemapXml],
    ['https://www.komplett.se/product/1334755/demovaror/datorutrustning/demo-ovrigt/asus-nuc-15-pro-slim-u7-255h-b-grade', outletHtml],
    ['https://www.komplett.se/product/1334700/dator-tillbehor/stationar-dator/asus-nuc-15-pro-slim-u7-255h', regularHtml]
  ]);
  const fetcher = {
    async fetchText(_source, _sourceState, url) {
      return {
        notModified: false,
        body: responses.get(url)
      };
    }
  };

  const observations = await collectSource({
    source: {
      id: 'komplett-outlet-electronics',
      type: 'komplett-sitemap',
      label: 'Komplett outlet electronics',
      condition: 'outlet',
      sitemapUrl: 'https://www.komplett.se/sitemap.products.xml',
      includePaths: ['/demovaror/'],
      matchReferenceIncludePaths: ['/datorutrustning/', '/dator-tillbehor/', '/gaming/', '/tv-ljud-bild/', '/mobil-tablets-klockor/'],
      matchReferenceExcludePaths: ['/demovaror/'],
      categoryRoots: ['datorutrustning', 'dator-tillbehor', 'gaming', 'tv-ljud-bild', 'mobil-tablets-klockor'],
      maxItems: 10,
      updatedSinceDays: 180,
      referenceLookup: true,
      shippingEstimateSek: 0,
      feesEstimateSek: 0
    },
    fetcher,
    sourceState: {},
    now: '2026-04-16T18:10:00.000Z'
  });

  assert.equal(observations.length, 1);
  assert.equal(observations[0].priceSek, 6383);
  assert.equal(observations[0].marketValueSek, 9390);
  assert.equal(observations[0].referencePriceSek, 9390);
  assert.equal(
    observations[0].referenceUrl,
    'https://www.komplett.se/product/1334700/dator-tillbehor/stationar-dator/asus-nuc-15-pro-slim-u7-255h'
  );
  assert.equal(observations[0].productKey, 'asus-nuc-15-pro-slim-u7-255h');
});
