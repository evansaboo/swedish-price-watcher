import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDigestDeals, buildDigestPayload, shouldSendDigest } from '../src/services/digest.js';
import { createDefaultState } from '../src/lib/store.js';

// 2026-06-12 was a Friday; 10:30 Stockholm = 08:30 UTC (CEST)
const NOW = new Date('2026-06-12T08:30:00.000Z');

const BASE_DIGEST = { enabled: true, time: '08:00', webhook: 'https://discord.example/digest' };

test('shouldSendDigest fires at/after the configured Stockholm time once per day', () => {
  assert.equal(shouldSendDigest(BASE_DIGEST, null, NOW), true, 'past 08:00 local, never sent');
  assert.equal(shouldSendDigest({ ...BASE_DIGEST, time: '20:00' }, null, NOW), false, 'before 20:00 local');
  assert.equal(
    shouldSendDigest(BASE_DIGEST, '2026-06-12T06:05:00.000Z', NOW), false,
    'already sent today (08:05 Stockholm)'
  );
  assert.equal(
    shouldSendDigest(BASE_DIGEST, '2026-06-11T06:05:00.000Z', NOW), true,
    'last sent yesterday'
  );
});

test('shouldSendDigest requires enabled flag and webhook', () => {
  assert.equal(shouldSendDigest({ ...BASE_DIGEST, enabled: false }, null, NOW), false);
  assert.equal(shouldSendDigest({ ...BASE_DIGEST, webhook: '' }, null, NOW), false);
  assert.equal(shouldSendDigest(null, null, NOW), false);
  assert.equal(shouldSendDigest(undefined, null, NOW), false);
});

test('buildDigestDeals keeps only fresh items, honours minScore and maxItems', () => {
  const state = createDefaultState();
  const nowMs = NOW.getTime();
  const fresh = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
  const stale = new Date(nowMs - 48 * 60 * 60 * 1000).toISOString();

  state.items = {
    'a:1': { listingKey: 'a:1', firstSeenAt: fresh },
    'a:2': { listingKey: 'a:2', firstSeenAt: fresh },
    'a:3': { listingKey: 'a:3', firstSeenAt: stale },
    'a:4': { listingKey: 'a:4', firstSeenAt: fresh }
  };
  state.deals = [
    { listingKey: 'a:1', score: 90, title: 'Top deal', url: 'https://x/1', currentPriceSek: 100, discountPercent: 40, sourceLabel: 'S' },
    { listingKey: 'a:2', score: 70, title: 'Good deal', url: 'https://x/2', currentPriceSek: 200, discountPercent: 25, sourceLabel: 'S' },
    { listingKey: 'a:3', score: 60, title: 'Stale deal', url: 'https://x/3', currentPriceSek: 300, discountPercent: 20, sourceLabel: 'S' },
    { listingKey: 'a:4', score: 10, title: 'Weak deal', url: 'https://x/4', currentPriceSek: 400, discountPercent: 2, sourceLabel: 'S' }
  ];

  const all = buildDigestDeals(state, { maxItems: 10 }, nowMs);
  assert.deepEqual(all.map(d => d.listingKey), ['a:1', 'a:2', 'a:4'], 'stale item excluded');

  const scored = buildDigestDeals(state, { maxItems: 10, minScore: 50 }, nowMs);
  assert.deepEqual(scored.map(d => d.listingKey), ['a:1', 'a:2']);

  const capped = buildDigestDeals(state, { maxItems: 1 }, nowMs);
  assert.deepEqual(capped.map(d => d.listingKey), ['a:1']);
});

test('buildDigestPayload renders numbered lines within Discord limits', () => {
  const deals = [
    { title: 'RTX 5070', url: 'https://x/1', currentPriceSek: 6999, discountPercent: 30, sourceLabel: 'Elgiganten Outlet' },
    { title: 'Sony WH-1000XM5', url: 'https://x/2', currentPriceSek: 2490, discountPercent: null, sourceLabel: 'Webhallen' }
  ];
  const payload = buildDigestPayload(deals, NOW);
  assert.match(payload.content, /Daily digest/);
  assert.match(payload.content, /top 2 new deals/);
  const desc = payload.embeds[0].description;
  assert.match(desc, /\*\*1\.\*\* \[RTX 5070\]/);
  assert.match(desc, /−30%/);
  assert.match(desc, /\*\*2\.\*\*/);
  assert.ok(!desc.includes('−null'), 'missing discount omitted');
  assert.ok(desc.length <= 4096);
});
