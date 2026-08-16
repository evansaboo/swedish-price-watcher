import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGroupFilters,
  normalizeWatchGroups,
  selectOffer,
  collectHotlistWithKey,
  DEFAULT_WATCH_GROUPS,
} from '../src/sources/elgigantenHotlist.js';

const NOW = '2026-08-16T12:00:00.000Z';

function makeSource(overrides = {}) {
  return {
    id: 'elgiganten-hotlist',
    type: 'elgiganten-hotlist',
    label: 'Elgiganten Hotlist',
    minDiscountPct: 15,
    watchGroups: [{ label: 'Grafikkort (GPU)', taxonomyIds: ['PT263'] }],
    ...overrides,
  };
}

// Field shape captured from the live commerce_b2c_OCSEELG Algolia index (Aug 2026)
function makeHit(overrides = {}) {
  return {
    objectID: '901234',
    articleNumber: '901234',
    title: 'Gigabyte GeForce RTX 5060 WINDFORCE OC 8G grafikkort',
    brand: 'Gigabyte',
    price: { amount: 4999, currency: 'SEK' },
    beforePrice: null,
    cheapestBItem: null,
    isBuyableOnline: true,
    productUrl: 'https://www.elgiganten.se/product/gigabyte-rtx-5060/901234',
    imageUrl: null,
    productTaxonomy: [
      { id: 'PT103', level: 1, name: 'Gaming' },
      { id: 'PT262', level: 2, name: 'Datorkomponenter' },
      { id: 'PT263', level: 3, name: 'Grafikkort (GPU)' },
    ],
    ...overrides,
  };
}

/** Mock fetcher that captures the outgoing Algolia body and replays canned results. */
function makeFetcher(resultsPerRequest) {
  const calls = [];
  return {
    calls,
    async fetchJsonApi(url, options) {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      return {
        results: body.requests.map((_req, i) => ({ hits: resultsPerRequest[i] ?? [] })),
      };
    },
  };
}

test('buildGroupFilters combines taxonomy and brand clauses', () => {
  assert.equal(
    buildGroupFilters({ taxonomyIds: ['PT263'] }),
    '(productTaxonomy.id:"PT263")',
  );
  assert.equal(
    buildGroupFilters({ taxonomyIds: ['PT254'], brands: ['Apple'] }),
    '(productTaxonomy.id:"PT254") AND (brand:"Apple")',
  );
  assert.equal(
    buildGroupFilters({ taxonomyIds: ['PT263', 'PT269'] }),
    '(productTaxonomy.id:"PT263" OR productTaxonomy.id:"PT269")',
  );
});

test('normalizeWatchGroups falls back to defaults and drops disabled/empty groups', () => {
  assert.equal(normalizeWatchGroups(undefined).length, DEFAULT_WATCH_GROUPS.length);
  assert.equal(normalizeWatchGroups([]).length, DEFAULT_WATCH_GROUPS.length);

  const groups = normalizeWatchGroups([
    { label: 'On', taxonomyIds: ['PT263'] },
    { label: 'Off', taxonomyIds: ['PT269'], enabled: false },
    { label: 'Empty' },
  ]);
  assert.deepEqual(groups.map((g) => g.label), ['On']);
});

test('selectOffer prefers a B-grade unit over the campaign price', () => {
  const offer = selectOffer(makeHit({
    price: { amount: 4999 },
    beforePrice: 5999,
    cheapestBItem: { articleNumber: '901234-B', price: 3999 },
  }));
  assert.equal(offer.kind, 'outlet');
  assert.equal(offer.priceSek, 3999);
  // Reference is the *current* new price, not beforePrice — the honest comparison.
  assert.equal(offer.referencePriceSek, 4999);
  assert.equal(offer.articleNumber, '901234-B');
});

test('selectOffer falls back to campaign pricing, and returns null without a discount signal', () => {
  const deal = selectOffer(makeHit({ price: { amount: 4499 }, beforePrice: 5999 }));
  assert.equal(deal.kind, 'deal');
  assert.equal(deal.priceSek, 4499);
  assert.equal(deal.referencePriceSek, 5999);

  assert.equal(selectOffer(makeHit()), null, 'no beforePrice and no B-grade unit');
  assert.equal(selectOffer(makeHit({ price: { amount: 0 } })), null);
  // A B-grade unit that is not actually cheaper is not an opportunity.
  assert.equal(selectOffer(makeHit({ cheapestBItem: { price: 5200 } })), null);
});

test('collectHotlistWithKey packs every watch group into a single Algolia request', async () => {
  const source = makeSource({
    watchGroups: [
      { label: 'Grafikkort (GPU)', taxonomyIds: ['PT263'] },
      { label: 'MacBook', taxonomyIds: ['PT254'], brands: ['Apple'] },
    ],
    hitsPerGroup: 50,
  });
  const fetcher = makeFetcher([[], []]);

  await collectHotlistWithKey({ source, sourceState: {}, fetcher, now: NOW, apiKey: 'k' });

  assert.equal(fetcher.calls.length, 1, 'one HTTP round-trip per poll');
  const { requests } = fetcher.calls[0].body;
  assert.equal(requests.length, 2);
  assert.equal(requests[0].filters, '(productTaxonomy.id:"PT263")');
  assert.equal(requests[1].filters, '(productTaxonomy.id:"PT254") AND (brand:"Apple")');
  assert.equal(requests[0].hitsPerPage, 50);
  assert.ok(fetcher.calls[0].url.includes('x-algolia-api-key=k'));
});

test('collectHotlistWithKey maps a B-grade opportunity into an observation', async () => {
  const hit = makeHit({ cheapestBItem: { articleNumber: '901234-B', price: 3999, bGradeTitle: 'Fyndvara klass A' } });
  const fetcher = makeFetcher([[hit]]);

  const [obs] = await collectHotlistWithKey({
    source: makeSource(), sourceState: {}, fetcher, now: NOW, apiKey: 'k',
  });

  assert.equal(obs.sourceId, 'elgiganten-hotlist');
  // Tracks the purchasable outlet SKU, not the A-grade catalogue entry.
  assert.equal(obs.externalId, '901234-B');
  assert.equal(obs.priceSek, 3999);
  assert.equal(obs.referencePriceSek, 4999);
  assert.equal(obs.discountPct, 20);
  assert.equal(obs.condition, 'outlet');
  assert.equal(obs.conditionLabel, 'Fyndvara klass A');
  // Real category, unlike the outlet index which collapses everything to "Outlet".
  assert.equal(obs.category, 'Grafikkort (GPU)');
  assert.equal(obs.watchGroup, 'Grafikkort (GPU)');
  assert.equal(obs.availability, 'in_stock');
  assert.equal(obs.seenAt, NOW);
});

test('collectHotlistWithKey enforces discount, price and stock filters', async () => {
  const hits = [
    // 20% off → kept
    makeHit({ objectID: 'keep', cheapestBItem: { articleNumber: 'keep-b', price: 3999 } }),
    // 4% off → below threshold
    makeHit({ objectID: 'small', cheapestBItem: { articleNumber: 'small-b', price: 4799 } }),
    // 20% off but not buyable online
    makeHit({ objectID: 'oos', isBuyableOnline: false, cheapestBItem: { articleNumber: 'oos-b', price: 3999 } }),
    // 20% off but above maxPriceSek
    makeHit({ objectID: 'pricey', price: { amount: 40000 }, cheapestBItem: { articleNumber: 'pricey-b', price: 32000 } }),
  ];
  const fetcher = makeFetcher([hits]);

  const observations = await collectHotlistWithKey({
    source: makeSource({ minDiscountPct: 15, maxPriceSek: 20000 }),
    sourceState: {}, fetcher, now: NOW, apiKey: 'k',
  });

  assert.deepEqual(observations.map((o) => o.externalId), ['keep-b']);
});

test('collectHotlistWithKey applies a per-group discount override and dedupes across groups', async () => {
  const shared = makeHit({ objectID: 'dup', cheapestBItem: { articleNumber: 'dup-b', price: 4599 } }); // 8% off
  const fetcher = makeFetcher([[shared], [shared]]);

  const observations = await collectHotlistWithKey({
    source: makeSource({
      minDiscountPct: 15,
      watchGroups: [
        { label: 'Grafikkort (GPU)', taxonomyIds: ['PT263'] },
        { label: 'MacBook', taxonomyIds: ['PT254'], brands: ['Apple'], minDiscountPct: 5 },
      ],
    }),
    sourceState: {}, fetcher, now: NOW, apiKey: 'k',
  });

  // Rejected by the global 15% threshold in group 1, accepted by the 5% override
  // in group 2, and emitted exactly once.
  assert.equal(observations.length, 1);
  assert.equal(observations[0].watchGroup, 'MacBook');
});

test('collectHotlistWithKey records poll telemetry on source state', async () => {
  const sourceState = {};
  const fetcher = makeFetcher([[makeHit({ cheapestBItem: { articleNumber: 'b', price: 3999 } })]]);

  await collectHotlistWithKey({ source: makeSource(), sourceState, fetcher, now: NOW, apiKey: 'k' });

  assert.equal(sourceState.lastPollAt, NOW);
  assert.equal(sourceState.lastGroupStats, 'Grafikkort (GPU):1/1');
});

test('collectHotlistWithKey returns nothing when all groups are disabled', async () => {
  const fetcher = makeFetcher([]);
  const observations = await collectHotlistWithKey({
    source: makeSource({ watchGroups: [{ label: 'Off', taxonomyIds: ['PT263'], enabled: false }] }),
    sourceState: {}, fetcher, now: NOW, apiKey: 'k',
  });
  assert.deepEqual(observations, []);
  assert.equal(fetcher.calls.length, 0, 'no request when there is nothing to poll');
});
