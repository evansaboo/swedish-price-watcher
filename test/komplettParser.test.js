import test from 'node:test';
import assert from 'node:assert/strict';

import { parseKomplettProductPage } from '../src/sources/komplett.js';

test('parses Komplett B-grade outlet pages', () => {
  const observation = parseKomplettProductPage({
    html: `
      <html>
        <head>
          <title>ASUS NUC 15 PRO Slim U7 255H -B-Grade - Demo ovrigt | Komplett.se</title>
          <meta name="title" content="ASUS NUC 15 PRO Slim U7 255H -B-Grade - Demo ovrigt" />
          <meta name="description" content="ASUS NUC 15 PRO Slim U7 255H -B-Grade - Intel Core Ultra 7 240H" />
          <meta property="og:image" content="/product-media/b2c/en-us/200/1334755.jpg" />
        </head>
        <body>
          <h1>ASUS NUC 15 PRO Slim U7 255H -B-Grade</h1>
          <p>B-grade pris</p>
          <strong>6 383:-</strong>
          <p>1 st i lager (1-3 dagar leveranstid)</p>
        </body>
      </html>
    `,
    url: 'https://www.komplett.se/product/1334755/demovaror/datorutrustning/demo-ovrigt/asus-nuc-15-pro-slim-u7-255h-b-grade',
    source: {
      id: 'komplett-outlet-electronics',
      type: 'komplett-sitemap',
      label: 'Komplett outlet electronics',
      condition: 'outlet',
      shippingEstimateSek: 0,
      feesEstimateSek: 0
    },
    now: '2026-04-16T18:10:00.000Z'
  });

  assert.equal(observation.title, 'ASUS NUC 15 PRO Slim U7 255H -B-Grade');
  assert.equal(observation.priceSek, 6383);
  assert.equal(observation.condition, 'outlet');
  assert.match(observation.availability, /1 st i lager/i);
  assert.equal(observation.productKey, 'asus-nuc-15-pro-slim-u7-255h');
  assert.equal(observation.category, 'electronics');
});
