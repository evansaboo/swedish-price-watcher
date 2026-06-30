import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseTraderaCards, collectFromTradera } from '../src/sources/tradera.js';

// Minimal but realistic Tradera ended-search card markup (obfuscated class names,
// data-testid price, data-item-type, item link, img.tradera.net image).
function card({ id, type, title, price }) {
  return `
    <div id="item-card-${id}" data-item-loaded="false" data-item-type="${type}" class="x__itemCard">
      <div class="x__imageWrapper">
        <a data-link-type="next-link" title="${title}" href="/item/341372/${id}/slug">
          <img src="https://img.tradera.net/images/${id}.jpg" />
        </a>
      </div>
      <div class="x__price"><span data-testid="price">${price}\u00a0kr<span class="sr-only">,</span></span></div>
    </div>`;
}

const SAMPLE_HTML = `<!DOCTYPE html><html><body><div data-search-results-items="">
  ${card({ id: '725612943', type: 'Auction', title: 'ASUS GeForce RTX 4070 12Gb Grafikkort', price: '4\u00a0202' })}
  ${card({ id: '721794351', type: 'AuctionBin', title: 'ASUS GeForce RTX 4070 12GB Dual White OC', price: '4\u00a0600' })}
  ${card({ id: '730547919', type: 'PureBin', title: 'HP OMEN 14 OLED RTX 4070', price: '17\u00a0000' })}
  ${card({ id: '999000111', type: 'ShopItem', title: 'Butik RTX 4070 ny', price: '6\u00a0999' })}
</div></body></html>`;

describe('parseTraderaCards', () => {
  it('extracts id, type, title, url, price and image for each card', () => {
    const cards = parseTraderaCards(SAMPLE_HTML);
    assert.equal(cards.length, 4);
    const first = cards[0];
    assert.equal(first.id, '725612943');
    assert.equal(first.type, 'Auction');
    assert.equal(first.title, 'ASUS GeForce RTX 4070 12Gb Grafikkort');
    assert.equal(first.url, 'https://www.tradera.com/item/341372/725612943/slug');
    assert.equal(first.priceSek, 4202);
    assert.equal(first.imageUrl, 'https://img.tradera.net/images/725612943.jpg');
  });

  it('parses prices with non-breaking-space thousands separators', () => {
    const cards = parseTraderaCards(SAMPLE_HTML);
    assert.equal(cards.find(c => c.id === '730547919').priceSek, 17000);
  });

  it('ignores class-name occurrences of item-card and returns only real cards', () => {
    const noise = '<div class="item-card-image-module-scss-module__abc"></div>' + SAMPLE_HTML;
    assert.equal(parseTraderaCards(noise).length, 4);
  });

  it('returns empty array for markup without cards', () => {
    assert.deepEqual(parseTraderaCards('<html><body>no results</body></html>'), []);
  });
});

describe('collectFromTradera', () => {
  function makeFetcher(html) {
    return {
      async fetchText() {
        return { body: html };
      },
    };
  }

  const source = {
    id: 'tradera-sold',
    type: 'tradera-sold',
    label: 'Tradera',
    keywords: ['rtx 4070'],
    maxPagesPerKeyword: 1,
  };

  it('keeps only realized auction sales (Auction / AuctionBin) as sold comps', async () => {
    const obs = await collectFromTradera({
      source,
      fetcher: makeFetcher(SAMPLE_HTML),
      sourceState: {},
      now: new Date().toISOString(),
    });
    // PureBin + ShopItem excluded → 2 auction sales remain
    assert.equal(obs.length, 2);
    for (const o of obs) {
      assert.equal(o.condition, 'used');
      assert.equal(o.availability, 'sold');
      assert.equal(o.soldComp, true);
      assert.equal(o.sourceId, 'tradera-sold');
      assert.ok(Number.isFinite(o.priceSek) && o.priceSek > 0);
    }
  });

  it('deduplicates by item id across pages', async () => {
    const obs = await collectFromTradera({
      source: { ...source, maxPagesPerKeyword: 3 },
      fetcher: makeFetcher(SAMPLE_HTML),
      sourceState: {},
      now: new Date().toISOString(),
    });
    const ids = obs.map(o => o.externalId);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('stops gracefully on empty response', async () => {
    const obs = await collectFromTradera({
      source,
      fetcher: { async fetchText() { return { body: '' }; } },
      sourceState: {},
      now: new Date().toISOString(),
    });
    assert.deepEqual(obs, []);
  });
});
