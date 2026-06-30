import test from 'node:test';
import assert from 'node:assert/strict';

import { validateReferencePrice } from '../src/lib/referencePrice.js';

test('accepts a plausible reference and labels it claimed without corroboration', () => {
  const { trustedReference, confidence } = validateReferencePrice({
    sourceReference: 1000,
    currentPriceSek: 700
  });
  assert.equal(trustedReference, 1000);
  assert.equal(confidence, 'claimed');
});

test('rejects implausible references (scaling / mismatch errors)', () => {
  // 1000 -> 50 implies a 95% discount: almost certainly bad data.
  const { trustedReference, confidence } = validateReferencePrice({
    sourceReference: 1000,
    currentPriceSek: 50
  });
  assert.equal(trustedReference, null);
  assert.equal(confidence, 'none');
});

test('rejects references that tower over genuine cross-store peers', () => {
  // Same product sells for ~1000 across 3 stores, but this store claims a 5000 "before" price.
  const { trustedReference, confidence } = validateReferencePrice({
    sourceReference: 5000,
    currentPriceSek: 900,
    peerMedian: 1000,
    peerCount: 3
  });
  assert.equal(trustedReference, null);
  assert.equal(confidence, 'none');
});

test('keeps reference but only marks claimed when peers are inflated-but-not-gross', () => {
  // 2x the peer median is suspect but below the 2.5x gross-outlier cut.
  const { trustedReference, confidence } = validateReferencePrice({
    sourceReference: 2000,
    currentPriceSek: 900,
    peerMedian: 1000,
    peerCount: 3
  });
  assert.equal(trustedReference, 2000);
  assert.equal(confidence, 'claimed');
});

test('marks verified when reference is supported by cross-store peers', () => {
  const { trustedReference, confidence } = validateReferencePrice({
    sourceReference: 1050,
    currentPriceSek: 800,
    peerMedian: 1000,
    peerCount: 3
  });
  assert.equal(trustedReference, 1050);
  assert.equal(confidence, 'verified');
});

test('marks verified when a separately-matched catalog price exists', () => {
  const { confidence } = validateReferencePrice({
    sourceReference: 1200,
    currentPriceSek: 900,
    hasCatalogMatch: true
  });
  assert.equal(confidence, 'verified');
});

test('marks verified when the item is at its historical low', () => {
  const { confidence } = validateReferencePrice({
    sourceReference: 1200,
    currentPriceSek: 900,
    atHistoricalLow: true
  });
  assert.equal(confidence, 'verified');
});

test('does not apply peer checks without enough genuine peers', () => {
  // Only one listing in the identity group — no cross-store corroboration available,
  // so a single-source outlet reference is accepted as claimed (not rejected).
  const { trustedReference, confidence } = validateReferencePrice({
    sourceReference: 3000,
    currentPriceSek: 1500,
    peerMedian: 1500,
    peerCount: 1
  });
  assert.equal(trustedReference, 3000);
  assert.equal(confidence, 'claimed');
});

test('returns none when reference is missing or not above the buy price', () => {
  assert.equal(validateReferencePrice({ sourceReference: null, currentPriceSek: 500 }).confidence, 'none');
  assert.equal(validateReferencePrice({ sourceReference: 400, currentPriceSek: 500 }).confidence, 'none');
  assert.equal(validateReferencePrice({ sourceReference: 500, currentPriceSek: 500 }).confidence, 'none');
});
