import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractResaleModel,
  buildResaleIndex,
  computeFlips
} from '../src/services/resaleEngine.js';

describe('extractResaleModel', () => {
  it('collapses GPU board-partner noise to the chip model', () => {
    const a = extractResaleModel('ASUS TUF Gaming GeForce RTX 4070 Ti 12GB OC');
    const b = extractResaleModel('MSI GeForce RTX 4070 Ti Ventus 3X');
    assert.ok(a);
    assert.equal(a.resaleKey, 'rtx-4070-ti');
    assert.equal(a.demandCategory, 'Graphics cards');
    assert.equal(a.resaleKey, b.resaleKey, 'different brands → same resale key');
  });

  it('separates RTX 4070 from RTX 4070 Ti', () => {
    assert.equal(extractResaleModel('Gigabyte RTX 4070 Windforce').resaleKey, 'rtx-4070');
    assert.notEqual(
      extractResaleModel('RTX 4070').resaleKey,
      extractResaleModel('RTX 4070 Ti').resaleKey
    );
  });

  it('extracts iPhone model + variant + storage', () => {
    const m = extractResaleModel('Apple iPhone 15 Pro Max 256GB Blå Titan');
    assert.equal(m.resaleKey, 'iphone-15-pro-max-256gb');
    assert.equal(m.demandCategory, 'Apple — iPhone');
  });

  it('matches iPhone titles with interleaved colour words', () => {
    const m = extractResaleModel('iPhone svart 14 128 GB');
    assert.equal(m.resaleKey, 'iphone-14-base-128gb');
  });

  it('rejects accessories so a case/charger is not priced as the device', () => {
    // Real production false positive: a MacBook case keyed as a MacBook laptop.
    assert.equal(extractResaleModel('dBramante Island MacBook Pro 14 (M3 Pro/Max) fodral (klar)'), null);
    assert.equal(extractResaleModel('Apple iPhone 15 Pro Silikonskal MagSafe Svart'), null);
    assert.equal(extractResaleModel('USB-C laddare till MacBook Pro 14 M3'), null);
    assert.equal(extractResaleModel('Skärmskydd iPhone 15 Pro Max härdat glas'), null);
    assert.equal(extractResaleModel('Sportband Apple Watch Series 9 45mm'), null);
    // …but the genuine device still matches.
    assert.equal(extractResaleModel('Apple iPhone 15 Pro 256GB Blå Titan').resaleKey, 'iphone-15-pro-256gb');
  });

  it('keys MacBook by line + Apple silicon chip', () => {
    const m = extractResaleModel('MacBook Air M2 13" 8GB 256GB');
    assert.equal(m.resaleKey, 'macbook-air-m2');
    assert.equal(m.demandCategory, 'Apple — MacBook');
  });

  it('handles consoles and handhelds', () => {
    assert.equal(extractResaleModel('Sony PlayStation 5 Pro').resaleKey, 'ps5-pro');
    assert.equal(extractResaleModel('PS5 Slim Digital Edition').resaleKey, 'ps5-digital');
    assert.equal(extractResaleModel('Nintendo Switch OLED Vit').resaleKey, 'nintendo-switch-oled');
    assert.equal(extractResaleModel('Valve Steam Deck OLED 1TB').resaleKey, 'steam-deck-oled');
  });

  it('extracts AMD and Intel CPU model signatures', () => {
    assert.equal(extractResaleModel('AMD Ryzen 7 7800X3D').resaleKey, 'ryzen-7-7800x3d');
    assert.equal(extractResaleModel('Intel Core i5-13600KF').resaleKey, 'intel-i5-13600kf');
  });

  it('returns null for non-resale items', () => {
    assert.equal(extractResaleModel('Tvättmaskin Samsung 8kg'), null);
    assert.equal(extractResaleModel('HDMI-kabel 2m'), null);
  });
});

describe('buildResaleIndex', () => {
  const used = [
    { title: 'iPhone 15 Pro 256GB', latestPriceSek: 9000, url: 'u1' },
    { title: 'Apple iPhone 15 Pro 256 GB grå', latestPriceSek: 8000, url: 'u2' },
    { title: 'iPhone 15 Pro 256GB nyskick', latestPriceSek: 10000, url: 'u3' },
    { title: 'Diskmaskin', latestPriceSek: 500, url: 'u4' }
  ];

  it('buckets by resale key and computes median + sample count', () => {
    const index = buildResaleIndex(used);
    const entry = index.get('iphone-15-pro-256gb');
    assert.ok(entry);
    assert.equal(entry.sampleCount, 3);
    assert.equal(entry.medianSek, 9000);
    assert.equal(entry.minSek, 8000);
    assert.equal(entry.maxSek, 10000);
  });

  it('ignores items with no extractable model or invalid price', () => {
    const index = buildResaleIndex([
      { title: 'Random thing', latestPriceSek: 100 },
      { title: 'iPhone 15 Pro 256GB', latestPriceSek: 0 }
    ]);
    assert.equal(index.size, 0);
  });
});

describe('computeFlips', () => {
  const index = buildResaleIndex([
    { title: 'RTX 4070 Ti', latestPriceSek: 7000, url: 'b1' },
    { title: 'RTX 4070 Ti', latestPriceSek: 7500, url: 'b2' },
    { title: 'RTX 4070 Ti', latestPriceSek: 8000, url: 'b3' }
  ]);

  it('surfaces a profitable flip below the Blocket median', () => {
    const flips = computeFlips(
      [{ listingKey: 'o:1', title: 'ASUS RTX 4070 Ti OC', latestPriceSek: 5000, condition: 'outlet' }],
      index,
      { flatFeeSek: 0, resaleAdjustFactor: 1 }
    );
    assert.equal(flips.length, 1);
    assert.equal(flips[0].resaleMedianSek, 7500);
    assert.equal(flips[0].buyPriceSek, 5000);
    assert.equal(flips[0].netProfitSek, 2500);
    assert.equal(flips[0].roiPercent, 50);
    assert.equal(flips[0].sampleCount, 3);
  });

  it('drops flips below the profit/ROI floor', () => {
    const flips = computeFlips(
      [{ listingKey: 'o:2', title: 'RTX 4070 Ti', latestPriceSek: 7400, condition: 'outlet' }],
      index,
      { minNetProfitSek: 300 }
    );
    assert.equal(flips.length, 0);
  });

  it('requires a minimum number of Blocket comps', () => {
    const thin = buildResaleIndex([{ title: 'RTX 4090', latestPriceSek: 15000 }]);
    const flips = computeFlips(
      [{ listingKey: 'o:3', title: 'RTX 4090', latestPriceSek: 9000, condition: 'outlet' }],
      thin,
      { minSampleCount: 3 }
    );
    assert.equal(flips.length, 0);
  });

  it('sorts by net profit descending', () => {
    const flips = computeFlips(
      [
        { listingKey: 'o:a', title: 'RTX 4070 Ti', latestPriceSek: 6000, condition: 'outlet' },
        { listingKey: 'o:b', title: 'RTX 4070 Ti', latestPriceSek: 4000, condition: 'outlet' }
      ],
      index,
      { flatFeeSek: 0, resaleAdjustFactor: 1 }
    );
    assert.equal(flips[0].listingKey, 'o:b');
    assert.ok(flips[0].netProfitSek > flips[1].netProfitSek);
  });
});
