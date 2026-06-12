import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractJsonObjects, mapDustinProduct, parseDustinPage } from '../src/sources/dustin.js';

const FIXTURE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dustin-fyndvaror.html'),
  'utf8'
);

const SOURCE = { id: 'dustin-fyndvaror', type: 'dustin-fyndvaror', label: 'Dustin Fyndvaror' };
const NOW = '2026-06-12T10:00:00.000Z';

// Synthetic product matching the live searchResultProduct shape (Aug 2025 capture)
function makeProduct(overrides = {}) {
  return {
    id: '5020050005',
    productErpIdentifier: '5020050005',
    displayName: 'Stealth 16 Mercedes-AMG - (Fyndvara klass 2)',
    primaryImageId: 'd2000010011367321.jpg',
    manufacturerName: 'Msi',
    manufacturerProductIdentifier: 'Stealth 16 AMG A1VGG-242NEU',
    displaySpecifications: 'Core Ultra 9 32GB 2000GB RTX 4070 16"',
    nameSlug: 'stealth-16-mercedes-amg---fyndvara-klass-2',
    price: {
      price: 22995,
      originalPrice: 27995,
      formatted: { price: '22 995 kr', originalPrice: '27 995 kr' }
    },
    categoryName: null,
    availability: {
      availabilityStatus: 'IN_STOCK',
      isAvailableForSale: true
    },
    ...overrides
  };
}

test('extractJsonObjects pulls balanced product objects from fixture HTML', () => {
  const objects = extractJsonObjects(FIXTURE, '"searchResultProduct":{');
  assert.equal(objects.length, 3, 'fixture embeds 3 searchResultProduct blobs');
  for (const obj of objects) {
    assert.ok(obj.id, 'every blob has an id');
    assert.ok(obj.price, 'every blob has a price object');
  }
});

test('extractJsonObjects survives strings containing braces and escaped quotes', () => {
  const html = 'x"marker":{"a":"escaped \\" quote and { brace","b":{"c":1}}y';
  const objects = extractJsonObjects(html, '"marker":{');
  assert.equal(objects.length, 1);
  assert.equal(objects[0].b.c, 1);
  assert.match(objects[0].a, /escaped/);
});

test('mapDustinProduct maps core fields', () => {
  const obs = mapDustinProduct(makeProduct(), SOURCE, NOW);
  assert.ok(obs);
  assert.equal(obs.externalId, '5020050005');
  assert.equal(obs.title, 'Msi Stealth 16 Mercedes-AMG - (Fyndvara klass 2)');
  assert.equal(obs.priceSek, 22995);
  assert.equal(obs.referencePriceSek, 27995);
  assert.equal(obs.condition, 'outlet');
  assert.equal(obs.conditionLabel, 'Fyndvara klass 2');
  assert.equal(obs.availability, 'in_stock');
  assert.equal(obs.manufacturerArticleNumber, 'Stealth 16 AMG A1VGG-242NEU');
  assert.equal(obs.url, 'https://www.dustinhome.se/product/5020050005/stealth-16-mercedes-amg---fyndvara-klass-2');
  assert.match(obs.imageUrl, /^https:\/\/cf-images\.dustin\.eu\/.*d2000010011367321\//);
});

test('mapDustinProduct strips the fyndvara marker from the product identity', () => {
  const obs = mapDustinProduct(makeProduct(), SOURCE, NOW);
  assert.ok(!obs.productKey.includes('fyndvara'), `productKey must not contain fyndvara: ${obs.productKey}`);
});

test('mapDustinProduct skips items not available for sale', () => {
  const obs = mapDustinProduct(
    makeProduct({ availability: { availabilityStatus: 'OUT_OF_STOCK', isAvailableForSale: false } }),
    SOURCE, NOW
  );
  assert.equal(obs, null);
});

test('mapDustinProduct ignores equal original price (no fake discount)', () => {
  const obs = mapDustinProduct(
    makeProduct({ price: { price: 1000, originalPrice: 1000 } }),
    SOURCE, NOW
  );
  assert.equal(obs.referencePriceSek, null);
});

test('parseDustinPage filters by title pattern and deduplicates', () => {
  const seen = new Set();
  const withFilter = parseDustinPage(FIXTURE, SOURCE, NOW, seen, /fyndvara/i);
  assert.ok(withFilter.length >= 1, 'finds fyndvara products');
  for (const obs of withFilter) {
    assert.match(obs.title, /fyndvara/i);
  }

  // Re-parsing with the same seen set yields nothing (dedupe)
  const again = parseDustinPage(FIXTURE, SOURCE, NOW, seen, /fyndvara/i);
  assert.equal(again.length, 0);

  // Without filter, the unrelated promo-panel product is included too
  const all = parseDustinPage(FIXTURE, SOURCE, NOW, new Set(), null);
  assert.ok(all.length > withFilter.length, 'unfiltered parse includes promo products');
});
