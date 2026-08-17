import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGroupFilters,
  buildGroupRequests,
  normalizeWatchGroups,
  selectOffer,
  titleMatchesKeyword,
  collectHotlistWithKey,
  DEFAULT_WATCH_GROUPS,
  buildOutletUrl,
} from '../src/sources/elgigantenHotlist.js';
import {
  MAX_SUBQUERIES,
  normalizeHotlistConfig,
  normalizeHotlistGroup,
} from '../src/services/hotlistConfig.js';

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

test('a B-grade offer links to the outlet unit, not the full-price page', () => {
  // The alert shows the B-grade price, so the buy link — and the cart-staging
  // browser that follows it — must land on the B-grade product.
  const hit = {
    objectID: '895772',
    title: 'Samsung 990 PRO intern SSD (4TB)',
    price: { amount: 10490 },
    productUrl:
      'https://www.elgiganten.se/product/gaming/datorkomponenter/intern-lagring/intern-ssd/samsung-990-pro-intern-ssd-4tb/895772',
    cheapestBItem: { articleNumber: '922068', price: 8392 },
  };
  const offer = selectOffer(hit);
  assert.equal(offer.kind, 'outlet');
  assert.equal(
    buildOutletUrl(hit.productUrl, offer.articleNumber),
    'https://www.elgiganten.se/product/outlet/samsung-990-pro-intern-ssd-4tb/922068'
  );
});

test('outlet URL derivation fails closed on unexpected shapes', () => {
  assert.equal(buildOutletUrl('https://example.com/product/x/1', '2'), null);
  assert.equal(buildOutletUrl('https://www.elgiganten.se/product/a/b/1', null), null);
  assert.equal(buildOutletUrl(null, '2'), null);
});

// ── Configurable categories and keywords ────────────────────────

test('categories can be given as names instead of taxonomy IDs', () => {
  const filters = buildGroupFilters({
    taxonomyNames: ['Grafikkort (GPU)', 'Laptop'],
    brands: ['Apple'],
  });
  assert.equal(
    filters,
    '(productTaxonomy.name:"Grafikkort (GPU)" OR productTaxonomy.name:"Laptop") AND (brand:"Apple")',
  );
});

test('taxonomy IDs and names combine into one category clause', () => {
  const filters = buildGroupFilters({ taxonomyIds: ['PT263'], taxonomyNames: ['Laptop'] });
  assert.equal(filters, '(productTaxonomy.id:"PT263" OR productTaxonomy.name:"Laptop")');
});

test('each keyword becomes its own sub-query sharing the group filters', () => {
  const group = normalizeHotlistGroup({
    label: 'GPU',
    taxonomyNames: ['Grafikkort (GPU)'],
    keywords: ['RTX 5090', 'RTX 5080'],
  });
  const plans = buildGroupRequests(group, 40);

  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((p) => p.request.query), ['RTX 5090', 'RTX 5080']);
  // The filters are identical, so the keywords narrow within the category.
  assert.equal(plans[0].request.filters, plans[1].request.filters);
  assert.equal(plans[0].request.hitsPerPage, 40);
});

test('a group without keywords is a single filter-only sub-query', () => {
  const group = normalizeHotlistGroup({ label: 'GPU', taxonomyNames: ['Grafikkort (GPU)'] });
  const plans = buildGroupRequests(group, 100);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].request.query, '');
  assert.equal(plans[0].keyword, null);
});

test('keyword sub-queries still travel in ONE multi-query request', async () => {
  const fetcher = makeFetcher([[], [], []]);
  await collectHotlistWithKey({
    source: makeSource(),
    hotlistConfig: normalizeHotlistConfig({
      groups: [
        { label: 'GPU', taxonomyNames: ['Grafikkort (GPU)'], keywords: ['RTX 5090', 'RTX 5080'] },
        { label: 'Phones', taxonomyNames: ['Mobiltelefon'] },
      ],
    }),
    sourceState: {}, fetcher, now: NOW, apiKey: 'k',
  });

  assert.equal(fetcher.calls.length, 1, 'still one HTTP round-trip per poll');
  assert.equal(fetcher.calls[0].body.requests.length, 3);
});

test('titleMatchesKeyword ignores noise but rejects a near-miss model', () => {
  assert.equal(titleMatchesKeyword('MSI GeForce RTX 5090 SUPRIM 32G', 'RTX 5090'), true);
  // The whole point: Algolia would happily return a 5070 for a "5090" query.
  assert.equal(titleMatchesKeyword('MSI GeForce RTX 5070 VENTUS', 'RTX 5090'), false);
  // Case and punctuation are not significant.
  assert.equal(titleMatchesKeyword('Apple iPhone 16 Pro Max 256 GB', 'iphone 16 pro'), true);
  // Short tokens are skipped so units/suffixes don't cause false rejections.
  assert.equal(titleMatchesKeyword('Kingston FURY 32 GB DDR5', 'DDR5 32 GB'), true);
  assert.equal(titleMatchesKeyword('anything', ''), true);
});

test('strict keyword matching filters out Algolia typo-tolerance bleed', async () => {
  const hits = [
    makeHit({ objectID: 'exact', title: 'MSI GeForce RTX 5090 SUPRIM', cheapestBItem: { articleNumber: 'exact-b', price: 3999 } }),
    makeHit({ objectID: 'near', title: 'MSI GeForce RTX 5070 VENTUS', cheapestBItem: { articleNumber: 'near-b', price: 3999 } }),
  ];
  const config = normalizeHotlistConfig({
    minDiscountPct: 10,
    groups: [{ label: 'GPU', taxonomyNames: ['Grafikkort (GPU)'], keywords: ['RTX 5090'] }],
  });

  const strict = await collectHotlistWithKey({
    source: makeSource(), hotlistConfig: config,
    sourceState: {}, fetcher: makeFetcher([hits]), now: NOW, apiKey: 'k',
  });
  assert.deepEqual(strict.map((o) => o.externalId), ['exact-b']);
  assert.equal(strict[0].matchedKeyword, 'RTX 5090');

  // Turning it off restores Algolia's own (looser) relevance ranking.
  config.groups[0].strictKeywordMatch = false;
  const loose = await collectHotlistWithKey({
    source: makeSource(), hotlistConfig: config,
    sourceState: {}, fetcher: makeFetcher([hits]), now: NOW, apiKey: 'k',
  });
  assert.deepEqual(loose.map((o) => o.externalId), ['exact-b', 'near-b']);
});

test('a product matching several keywords is emitted only once', async () => {
  const hit = makeHit({ title: 'MSI GeForce RTX 5090 SUPRIM', cheapestBItem: { articleNumber: 'dup-b', price: 3999 } });
  const observations = await collectHotlistWithKey({
    source: makeSource(),
    hotlistConfig: normalizeHotlistConfig({
      minDiscountPct: 10,
      groups: [{ label: 'GPU', taxonomyNames: ['Grafikkort (GPU)'], keywords: ['RTX 5090', 'SUPRIM'] }],
    }),
    sourceState: {}, fetcher: makeFetcher([[hit], [hit]]), now: NOW, apiKey: 'k',
  });

  assert.equal(observations.length, 1);
});

test('the sub-query budget bounds how large a single poll can get', async () => {
  const groups = Array.from({ length: 20 }, (_, i) => ({
    label: `g${i}`,
    taxonomyNames: ['Grafikkort (GPU)'],
    keywords: Array.from({ length: 10 }, (_, k) => `kw-${i}-${k}`),
  }));
  const fetcher = makeFetcher([[]]);

  await collectHotlistWithKey({
    source: makeSource(),
    hotlistConfig: normalizeHotlistConfig({ groups }),
    sourceState: {}, fetcher, now: NOW, apiKey: 'k',
  });

  assert.equal(fetcher.calls[0].body.requests.length, MAX_SUBQUERIES);
});
