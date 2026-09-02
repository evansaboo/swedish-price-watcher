import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCardSku,
  mapNvidiaCard,
  DEFAULT_SKUS,
  SKU_PATTERNS,
  CARD_METADATA
} from '../src/sources/nvidia.js';

describe('nvidia source - resolveCardSku', () => {
  it('prefers dynamic SKU when present in dynamicSkus', () => {
    const dynamicSkus = {
      'sv-se': {
        '5090': { sku: 'DYNAMIC_5090_SKU', old_sku: 'OLD', last_change: '2026-01-01' }
      }
    };
    const sku = resolveCardSku('5090', 'sv-se', dynamicSkus);
    assert.equal(sku, 'DYNAMIC_5090_SKU');
  });

  it('falls back to Swedish SKU pattern when dynamicSkus is null', () => {
    const sku5090 = resolveCardSku('5090', 'sv-se', null);
    assert.equal(sku5090, 'PROFESHOP5090');

    const sku5080 = resolveCardSku('5080', 'sv-se', null);
    assert.equal(sku5080, 'PRO5080FESHOP');

    const sku5070 = resolveCardSku('5070', 'sv-se', null);
    assert.equal(sku5070, 'PRONVGFT570SHOP');
  });

  it('falls back to default SKU for 40-series cards', () => {
    const sku4090 = resolveCardSku('4090', 'sv-se', null);
    assert.equal(sku4090, 'NVGFT490');

    const sku4080s = resolveCardSku('4080S', 'sv-se', null);
    assert.equal(sku4080s, 'NVGFT480S');

    const sku4070s = resolveCardSku('4070S', 'sv-se', null);
    assert.equal(sku4070s, 'NVGFT470S');
  });

  it('handles other locales like en-gb and de-de properly', () => {
    assert.equal(resolveCardSku('5090', 'en-gb', null), 'SCANNVGFFE5090');
    assert.equal(resolveCardSku('5080', 'en-gb', null), '5080SCANNVGFFE');
    assert.equal(resolveCardSku('5090', 'de-de', null), 'PROFESHOP5090');
  });
});

describe('nvidia source - mapNvidiaCard', () => {
  const source = {
    id: 'nvidia-fe',
    label: 'NVIDIA Founders Edition',
    type: 'nvidia'
  };
  const now = '2026-09-02T12:00:00.000Z';

  it('maps an out-of-stock card with MSRP and default URL', () => {
    const obs = mapNvidiaCard({
      cardKey: '5090',
      sku: 'PROFESHOP5090',
      item: {
        is_active: 'false',
        product_url: '',
        price: '1000000',
        fe_sku: 'PROFESHOP5090_SE',
        locale: 'SE'
      },
      source,
      now,
      locale: 'sv-se'
    });

    assert.equal(obs.sourceId, 'nvidia-fe');
    assert.equal(obs.title, 'NVIDIA GeForce RTX 5090 Founders Edition');
    assert.equal(obs.category, 'GPU');
    assert.equal(obs.condition, 'new');
    assert.equal(obs.conditionLabel, 'Founders Edition');
    assert.equal(obs.availability, 'out_of_stock');
    assert.equal(obs.priceSek, 25990);
    assert.equal(obs.marketValueSek, 25990);
    assert.equal(obs.referencePriceSek, 25990);
    assert.ok(obs.url.includes('nvidia.com'));
    assert.ok(obs.notes.includes('PROFESHOP5090'));
  });

  it('maps an in-stock card with active buy URL and real price', () => {
    const obs = mapNvidiaCard({
      cardKey: '5080',
      sku: 'PRO5080FESHOP',
      item: {
        is_active: 'true',
        product_url: 'https://www.proshop.se/nvidia-5080-fe-direct-buy',
        price: '13990',
        fe_sku: 'PRO5080FESHOP_SE',
        locale: 'SE'
      },
      source,
      now,
      locale: 'sv-se'
    });

    assert.equal(obs.availability, 'in_stock');
    assert.equal(obs.priceSek, 13990);
    assert.equal(obs.url, 'https://www.proshop.se/nvidia-5080-fe-direct-buy');
    assert.ok(obs.notes.includes('In Stock 🚀'));
  });
});
