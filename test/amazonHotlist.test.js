import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmazonPrice,
  extractAsin,
  buildAmazonSearchUrl,
  parseAmazonSearchResultsHtml,
  collectFromAmazonHotlist
} from '../src/sources/amazonHotlist.js';

test('parseAmazonPrice handles Swedish currency string formats', () => {
  assert.equal(parseAmazonPrice('1 499,00 kr'), 1499);
  assert.equal(parseAmazonPrice('1.499,00 kr'), 1499);
  assert.equal(parseAmazonPrice('1499 kr'), 1499);
  assert.equal(parseAmazonPrice('1499:-'), 1499);
  assert.equal(parseAmazonPrice('1,499.00 kr'), 1499);
  assert.equal(parseAmazonPrice('899,00 SEK'), 899);
  assert.equal(parseAmazonPrice('12 990,00 kr'), 12990);
  assert.equal(parseAmazonPrice(499), 499);
  assert.equal(parseAmazonPrice(''), null);
  assert.equal(parseAmazonPrice(null), null);
});

test('extractAsin extracts 10-char alphanumeric ASIN', () => {
  assert.equal(extractAsin('B0CY29272Y', null), 'B0CY29272Y');
  assert.equal(extractAsin(null, 'https://www.amazon.se/dp/B0CY29272Y?ref=xyz'), 'B0CY29272Y');
  assert.equal(extractAsin(null, 'https://www.amazon.se/gp/product/B08N5WRWNW'), 'B08N5WRWNW');
  assert.equal(extractAsin('invalid-asin', 'https://example.com/other'), null);
});

test('buildAmazonSearchUrl constructs targeted discount search URL', () => {
  const url = buildAmazonSearchUrl('RTX 5070', 20);
  assert.ok(url.includes('k=RTX+5070') || url.includes('k=RTX%205070'));
  assert.ok(url.includes('pct-off=20-'));
  assert.ok(url.includes('s=discount-rank'));
});

test('parseAmazonSearchResultsHtml extracts deals with reference price and discount', () => {
  const sampleHtml = `
    <div class="s-main-slot">
      <!-- Item 1: 25% off SSD -->
      <div data-component-type="s-search-result" data-asin="B0B9C315N1">
        <h2>
          <a class="a-link-normal" href="/dp/B0B9C315N1">
            <span class="a-size-medium a-color-base a-text-normal">Samsung 990 PRO NVMe M.2 SSD 1TB</span>
          </a>
        </h2>
        <div class="a-price" data-a-size="xl">
          <span class="a-offscreen">1 199,00 kr</span>
        </div>
        <div class="a-price a-text-price" data-a-size="b">
          <span class="a-offscreen">1 599,00 kr</span>
        </div>
        <span class="a-badge-text">-25%</span>
        <img class="s-image" src="https://m.media-amazon.com/images/I/71xyz.jpg" />
      </div>

      <!-- Item 2: Below minimum discount (only 5% off) -->
      <div data-component-type="s-search-result" data-asin="B0B9C315N2">
        <h2>
          <a class="a-link-normal" href="/dp/B0B9C315N2">
            <span>Kingston NV2 NVMe PCIe 4.0 SSD 1TB</span>
          </a>
        </h2>
        <div class="a-price">
          <span class="a-offscreen">950,00 kr</span>
        </div>
        <div class="a-price a-text-price">
          <span class="a-offscreen">1 000,00 kr</span>
        </div>
      </div>

      <!-- Item 3: Begagnad / Warehouse Deal (30% off) -->
      <div data-component-type="s-search-result" data-asin="B0B9C315N3">
        <h2>
          <a class="a-link-normal" href="/dp/B0B9C315N3">
            <span>Apple MacBook Air 13 M3 16GB 256GB</span>
          </a>
        </h2>
        <div class="a-price">
          <span class="a-offscreen">10 500,00 kr</span>
        </div>
        <div class="a-price a-text-price">
          <span class="a-offscreen">15 000,00 kr</span>
        </div>
        <span class="a-size-small">Begagnad - Som ny (Amazon Warehouse)</span>
      </div>
    </div>
  `;

  const items = parseAmazonSearchResultsHtml(sampleHtml, {
    source: { id: 'amazon-hotlist', label: 'Amazon.se Hotlist', type: 'amazon-hotlist' },
    group: { label: 'Intern SSD', minDiscountPct: 15 },
    query: 'SSD',
    minDiscountPct: 15
  });

  assert.equal(items.length, 1, 'Only Samsung SSD matches discount and query');
  const [samsung] = items;
  assert.equal(samsung.externalId, 'B0B9C315N1');
  assert.equal(samsung.title, 'Samsung 990 PRO NVMe M.2 SSD 1TB');
  assert.equal(samsung.priceSek, 1199);
  assert.equal(samsung.referencePriceSek, 1599);
  assert.equal(samsung.discountPct, 25);
  assert.equal(samsung.condition, 'deal');
  assert.equal(samsung.url, 'https://www.amazon.se/dp/B0B9C315N1');
  assert.equal(samsung.imageUrl, 'https://m.media-amazon.com/images/I/71xyz.jpg');
});

test('collectFromAmazonHotlist fetches and parses watch group items', async () => {
  const sampleHtml = `
    <div data-component-type="s-search-result" data-asin="B0GPU50700">
      <h2><a href="/dp/B0GPU50700"><span>ASUS TUF Gaming GeForce RTX 5070 12GB GDDR7</span></a></h2>
      <div class="a-price"><span class="a-offscreen">7 490,00 kr</span></div>
      <div class="a-price a-text-price"><span class="a-offscreen">9 990,00 kr</span></div>
    </div>
  `;

  const mockFetcher = {
    fetchText: async () => sampleHtml
  };

  const results = await collectFromAmazonHotlist({
    source: { id: 'amazon-hotlist', label: 'Amazon.se Hotlist', type: 'amazon-hotlist' },
    fetcher: mockFetcher,
    preferences: {
      hotlist: {
        minDiscountPct: 15,
        groups: [
          { label: 'Grafikkort (GPU)', keywords: ['RTX 5070'], minDiscountPct: 15 }
        ]
      }
    }
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].externalId, 'B0GPU50700');
  assert.equal(results[0].title, 'ASUS TUF Gaming GeForce RTX 5070 12GB GDDR7');
  assert.equal(results[0].priceSek, 7490);
  assert.equal(results[0].referencePriceSek, 9990);
  assert.equal(results[0].discountPct, 25);
});
