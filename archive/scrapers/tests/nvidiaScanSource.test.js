// ARCHIVED 2026-10-31 with archive/scrapers/nvidiaScanSource.js. Not run by
// `npm test`; run it explicitly: node --test archive/scrapers/tests/
// The original used the live-feed poller harness from test/nvidia.test.js;
// this copy feeds equivalent getStatus() snapshots directly.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { collectFromNvidia, mapNvidiaCard, setNvidiaLiveStatusProvider } from '../nvidiaScanSource.js';

const card = (cardKey, extra = {}) => ({ cardKey, locale: 'sv-se', sku: `PRO${cardKey}`, available: false, product_url: null, api_reachable: true, ...extra });

describe('nvidia scan source - collectFromNvidia', () => {
  const source = { id: 'nvidia-fe', label: 'NVIDIA Founders Edition', type: 'nvidia', locale: 'sv-se' };
  const now = '2026-10-31T12:00:00.000Z';

  afterEach(() => setNvidiaLiveStatusProvider(null));

  it('maps live feed cards into observations without network calls', async () => {
    setNvidiaLiveStatusProvider(() => ({
      enabled: true,
      cards: [
        card('5090'),
        card('5080', { available: true, product_url: 'https://store.example/5080' }),
        card('5070', { api_reachable: false })
      ]
    }));
    const sourceState = {};
    const obs = await collectFromNvidia({ source, sourceState, now });
    assert.deepEqual(obs.map((o) => o.externalId), ['nvidia-fe-5090-sv-se', 'nvidia-fe-5080-sv-se']);
    assert.equal(obs[0].availability, 'out_of_stock');
    assert.equal(obs[1].availability, 'in_stock');
    assert.equal(obs[1].url, 'https://store.example/5080');
    assert.equal(obs[1].priceSek, 13990);
    assert.equal(sourceState.lastScanPartial, true, '5070 was unhealthy, so the snapshot is partial');
  });

  it('throws when the tracker is disabled or the feed has no fresh data', async () => {
    await assert.rejects(collectFromNvidia({ source, now }), /not initialised/);
    setNvidiaLiveStatusProvider(() => ({ enabled: false, cards: [] }));
    await assert.rejects(collectFromNvidia({ source, now }), /disabled/);
    setNvidiaLiveStatusProvider(() => ({ enabled: true, cards: [card('5090', { api_reachable: false })], lastError: null }));
    await assert.rejects(collectFromNvidia({ source, now }), /no fresh data/);
  });
  it('mapNvidiaCard falls back to the store URL when out of stock', () => {
    const obs = mapNvidiaCard({
      card: { cardKey: '5090', sku: 'PROFESHOP5090', available: false, product_url: null, locale: 'sv-se' },
      source,
      now
    });
    assert.equal(obs.title, 'NVIDIA GeForce RTX 5090 Founders Edition');
    assert.equal(obs.category, 'GPU');
    assert.equal(obs.condition, 'new');
    assert.equal(obs.availability, 'out_of_stock');
    assert.equal(obs.priceSek, 25990);
    assert.match(obs.url, /marketplace\.nvidia\.com\/sv-se\/consumer\/graphics-cards\/nvidia-geforce-rtx-5090\//);
    assert.ok(obs.notes.includes('PROFESHOP5090'));
  });
});
