import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTraderaDraft, submitTraderaDraft } from '../src/services/traderaDrafts.js';

const RECORD = {
  id: 'inventory-1',
  purchasePriceSek: 5000,
  product: {
    title: 'ASUS RTX 4070 Ti outlet',
    projectedResaleSek: 7200,
    imageUrl: 'https://img.example/gpu.jpg',
    url: 'https://shop.example/gpu'
  }
};

test('builds a human-reviewed Tradera draft without publishing', () => {
  const draft = buildTraderaDraft(RECORD, { condition: 'Used - excellent' });
  assert.equal(draft.askingPriceSek, 7200);
  assert.equal(draft.publish, false);
  assert.equal(draft.externalReference, RECORD.id);
  assert.deepEqual(draft.imageUrls, ['https://img.example/gpu.jpg']);
});

test('remote draft submission fails closed without credentials', async () => {
  await assert.rejects(
    () => submitTraderaDraft(buildTraderaDraft(RECORD), {}),
    /not configured/
  );
});
