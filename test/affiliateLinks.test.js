import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAffiliateUrl, decorateAffiliatePayload } from '../src/services/affiliateLinks.js';

test('affiliate URL templates encode the retailer destination', () => {
  const source = {
    affiliateProgram: {
      network: 'approved-network',
      linkTemplate: 'https://track.example/click?destination={url}'
    }
  };
  const result = buildAffiliateUrl('https://shop.example/product?id=42&color=blue', source);
  assert.equal(result.affiliate, true);
  assert.equal(result.affiliateNetwork, 'approved-network');
  assert.match(result.buyUrl, /destination=https%3A%2F%2Fshop\.example/);
});

test('missing or invalid affiliate configuration falls back to raw URL', () => {
  const raw = 'https://shop.example/product/42';
  assert.equal(buildAffiliateUrl(raw, {}).buyUrl, raw);
  assert.equal(buildAffiliateUrl(raw, {}).affiliate, false);
  assert.equal(buildAffiliateUrl(raw, { affiliateProgram: { linkTemplate: 'javascript:bad/{url}' } }).buyUrl, raw);
});

test('affiliate decoration preserves paginated response metadata', () => {
  const sources = new Map([[
    'shop',
    { affiliateProgram: { network: 'n', linkTemplate: 'https://track.example/?u={url}' } }
  ]]);
  const payload = decorateAffiliatePayload({
    items: [{ sourceId: 'shop', url: 'https://shop.example/p/1' }],
    total: 1
  }, sources);
  assert.equal(payload.total, 1);
  assert.equal(payload.items[0].affiliate, true);
});
