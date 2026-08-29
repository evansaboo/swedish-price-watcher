import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaapiHeaders, normalizePaapiItem } from '../src/sources/amazonPaapi.js';

test('buildPaapiHeaders generates valid AWS SigV4 authorization headers', () => {
  const headers = buildPaapiHeaders({
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    payload: JSON.stringify({ Keywords: 'RTX 5090' }),
    now: new Date('2026-08-29T12:00:00.000Z')
  });

  assert.equal(headers['host'], 'webservices.amazon.se');
  assert.equal(headers['x-amz-date'], '20260829T120000Z');
  assert.equal(headers['x-amz-target'], 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems');
  assert.ok(headers['Authorization'].startsWith('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260829/eu-west-1/ProductAdvertisingAPI/aws4_request'));
  assert.ok(headers['Authorization'].includes('SignedHeaders=content-encoding;content-type;host;x-amz-date;x-amz-target'));
  assert.ok(headers['Authorization'].includes('Signature='));
});

test('normalizePaapiItem formats PA-API item into price watcher observation', () => {
  const rawItem = {
    ASIN: 'B0CY29272Y',
    DetailPageURL: 'https://www.amazon.se/dp/B0CY29272Y?tag=zpeedx-21',
    ItemInfo: {
      Title: { DisplayValue: 'ASUS TUF Gaming GeForce RTX 5070 12GB GDDR7' },
      ByLineInfo: { Brand: { DisplayValue: 'ASUS' } },
      Classifications: { ProductGroup: { DisplayValue: 'Personal Computer' } }
    },
    Images: {
      Primary: {
        Medium: { URL: 'https://m.media-amazon.com/images/I/71xyz.jpg' }
      }
    },
    Offers: {
      Listings: [
        {
          Price: {
            Amount: 7490.0,
            Currency: 'SEK',
            Savings: {
              Amount: 2500.0,
              Percentage: 25
            }
          },
          SavingBasis: {
            Amount: 9990.0,
            Currency: 'SEK'
          }
        }
      ]
    }
  };

  const item = normalizePaapiItem(rawItem, {
    source: { id: 'amazon-hotlist', label: 'Amazon.se Hotlist' },
    group: { label: 'Grafikkort (GPU)' },
    now: '2026-08-29T12:00:00.000Z'
  });

  assert.equal(item.id, 'amazon-hotlist:B0CY29272Y');
  assert.equal(item.externalId, 'B0CY29272Y');
  assert.equal(item.title, 'ASUS TUF Gaming GeForce RTX 5070 12GB GDDR7');
  assert.equal(item.brand, 'ASUS');
  assert.equal(item.category, 'Grafikkort (GPU)');
  assert.equal(item.priceSek, 7490);
  assert.equal(item.referencePriceSek, 9990);
  assert.equal(item.discountPct, 25);
  assert.equal(item.url, 'https://www.amazon.se/dp/B0CY29272Y?tag=zpeedx-21');
  assert.equal(item.imageUrl, 'https://m.media-amazon.com/images/I/71xyz.jpg');
});
