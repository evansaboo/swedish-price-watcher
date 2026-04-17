import test from 'node:test';
import assert from 'node:assert/strict';

import { collectSource } from '../src/sources/index.js';

test('collects Elgiganten outlet items from Apify actor output', async () => {
  const previousToken = process.env.APIFY_TOKEN;
  process.env.APIFY_TOKEN = 'test-apify-token';

  try {
    let receivedRequest = null;
    const fetcher = {
      async fetchJsonApi(url, options) {
        receivedRequest = { url, options };

        return [
          {
            resultType: 'product',
            productId: '1000290',
            title: 'DJI Osmo Mobile 8 outlet',
            url: 'https://www.elgiganten.se/product/outlet/dji-osmo-mobile-8-gimbalstabilisator/1000290',
            priceCurrent: [1949, 1559.2],
            onlineStockLevel: '25+',
            leafCategory: 'Outlet',
            categoryGroupId: '43210',
            apiRecord: {
              cgm: 43210,
              articleNumber: '1000290',
              manufacturerArticleNumber: 'CPOS0000032501'
            },
            bulletPoints: ['ActiveTrack 7.0', '10 timmars batteritid'],
            imageUrl: 'https://next-media.elkjop.com/image/1000290.jpg'
          },
          {
            resultType: 'product',
            productId: '9000290',
            title: 'DJI Osmo Mobile 8',
            url: 'https://www.elgiganten.se/product/sport-fritid/kameratillbehor/dji-osmo-mobile-8/9000290',
            priceCurrent: 2490,
            leafCategory: 'Kamerastativ',
            categoryGroupId: '43210',
            apiRecord: {
              cgm: 43210,
              articleNumber: '9000290',
              manufacturerArticleNumber: 'CPOS0000032501'
            }
          },
          {
            resultType: 'product',
            productId: '1000299',
            title: 'Not outlet product',
            url: 'https://www.elgiganten.se/product/sport-fritid/not-outlet/1000299',
            priceCurrent: 999
          },
          {
            resultType: 'content',
            title: 'Outlet inspiration',
            url: 'https://www.elgiganten.se/outlet-guide'
          }
        ];
      }
    };

    const observations = await collectSource({
      source: {
        id: 'elgiganten-outlet-latest',
        type: 'apify-elgiganten',
        label: 'Elgiganten outlet latest',
        category: 'electronics',
        condition: 'outlet',
        actorId: 'shahidirfan/elgiganten-scraper',
        actorInput: {
          startUrl: 'https://www.elgiganten.se/search?q=outlet&view=products',
          results_wanted: 20,
          max_pages: 2
        },
        includePaths: ['/product/outlet/'],
        actorTimeoutMs: 120000,
        apiTokenEnvVar: 'APIFY_TOKEN',
        shippingEstimateSek: 0,
        feesEstimateSek: 0
      },
      fetcher,
      sourceState: {},
      now: '2026-04-17T09:30:00.000Z'
    });

    assert.equal(receivedRequest.url, 'https://api.apify.com/v2/acts/shahidirfan~elgiganten-scraper/run-sync-get-dataset-items?clean=1&format=json');
    assert.equal(receivedRequest.options.method, 'POST');
    assert.equal(receivedRequest.options.headers.authorization, 'Bearer test-apify-token');
    assert.equal(receivedRequest.options.timeoutMs, 120000);
    assert.deepEqual(JSON.parse(receivedRequest.options.body), {
      startUrl: 'https://www.elgiganten.se/search?q=outlet&view=products',
      results_wanted: 20,
      max_pages: 2
    });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].externalId, '1000290');
    assert.equal(observations[0].title, 'DJI Osmo Mobile 8 outlet');
    assert.equal(observations[0].priceSek, 1949);
    assert.equal(observations[0].referencePriceSek, 2490);
    assert.equal(observations[0].marketValueSek, 2490);
    assert.equal(observations[0].referenceMatchType, 'catalog-match');
    assert.equal(observations[0].referenceTitle, 'DJI Osmo Mobile 8');
    assert.equal(observations[0].availability, '25+');
    assert.equal(observations[0].category, 'Kamerastativ');
    assert.match(observations[0].description, /ActiveTrack 7.0/i);
  } finally {
    if (previousToken == null) {
      delete process.env.APIFY_TOKEN;
    } else {
      process.env.APIFY_TOKEN = previousToken;
    }
  }
});

test('runs additional keyword inputs and deduplicates repeated records', async () => {
  const previousToken = process.env.APIFY_TOKEN;
  const previousToken2 = process.env.APIFY_TOKEN_2;
  process.env.APIFY_TOKEN = 'test-apify-token';
  process.env.APIFY_TOKEN_2 = 'test-apify-token-2';

  try {
    const requests = [];
    const fetcher = {
      async fetchJsonApi(_url, options) {
        const body = JSON.parse(options.body);
        requests.push({
          body,
          authorization: options.headers.authorization
        });

        if (body.keyword === 'outlet gaming') {
          return [
            {
              resultType: 'product',
              productId: '2000101',
              title: 'ASUS GeForce RTX 5060 Ti 8GB DUAL OC grafikkort',
              url: 'https://www.elgiganten.se/product/outlet/asus-geforce-rtx-5060-ti-8gb-dual-oc-grafikkort/2000101',
              priceCurrent: 4990,
              leafCategory: 'Outlet'
            },
            {
              resultType: 'product',
              productId: '2000100',
              title: 'QPAD Flux 65 tangentbord gaming',
              url: 'https://www.elgiganten.se/product/outlet/qpad-flux-65-tangentbord-gaming/2000100',
              priceCurrent: 899,
              leafCategory: 'Outlet'
            }
          ];
        }

        return [
          {
            resultType: 'product',
            productId: '2000100',
            title: 'QPAD Flux 65 tangentbord gaming',
            url: 'https://www.elgiganten.se/product/outlet/qpad-flux-65-tangentbord-gaming/2000100',
            priceCurrent: 899,
            leafCategory: 'Outlet'
          }
        ];
      }
    };

    const observations = await collectSource({
      source: {
        id: 'elgiganten-outlet-latest',
        type: 'apify-elgiganten',
        label: 'Elgiganten outlet latest',
        category: 'electronics',
        condition: 'outlet',
        actorId: 'shahidirfan/elgiganten-scraper',
        actorInput: {
          startUrl: 'https://www.elgiganten.se/search?q=outlet&view=products',
          results_wanted: 20,
          max_pages: 2
        },
        actorKeywordQueries: ['outlet gaming'],
        referenceLookup: false,
        includePaths: ['/product/outlet/'],
        actorTimeoutMs: 120000,
        apiTokenEnvVar: 'APIFY_TOKEN',
        shippingEstimateSek: 0,
        feesEstimateSek: 0
      },
      fetcher,
      sourceState: {},
      now: '2026-04-17T12:00:00.000Z'
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.startUrl, 'https://www.elgiganten.se/search?q=outlet&view=products');
    assert.equal(requests[1].body.keyword, 'outlet gaming');
    assert.equal(requests[0].authorization, 'Bearer test-apify-token');
    assert.equal(requests[1].authorization, 'Bearer test-apify-token-2');
    assert.equal(observations.length, 2);
    assert.equal(
      observations.some((observation) => observation.title.includes('grafikkort')),
      true
    );
  } finally {
    if (previousToken == null) {
      delete process.env.APIFY_TOKEN;
    } else {
      process.env.APIFY_TOKEN = previousToken;
    }

    if (previousToken2 == null) {
      delete process.env.APIFY_TOKEN_2;
    } else {
      process.env.APIFY_TOKEN_2 = previousToken2;
    }
  }
});

test('retries transient Apify 502 failures with token rotation', async () => {
  const previousToken = process.env.APIFY_TOKEN;
  const previousToken2 = process.env.APIFY_TOKEN_2;
  process.env.APIFY_TOKEN = 'test-apify-token';
  process.env.APIFY_TOKEN_2 = 'test-apify-token-2';

  try {
    const authorizations = [];
    let attempts = 0;
    const fetcher = {
      async fetchJsonApi(_url, options) {
        attempts += 1;
        authorizations.push(options.headers.authorization);

        if (attempts <= 2) {
          throw new Error(
            'Request failed for https://api.apify.com/v2/acts/shahidirfan~elgiganten-scraper/run-sync-get-dataset-items?clean=1&format=json: 502 Bad Gateway'
          );
        }

        return [
          {
            resultType: 'product',
            productId: '3000100',
            title: 'Retry resilient outlet listing',
            url: 'https://www.elgiganten.se/product/outlet/retry-resilient-outlet-listing/3000100',
            priceCurrent: 1290,
            leafCategory: 'Outlet'
          }
        ];
      }
    };

    const observations = await collectSource({
      source: {
        id: 'elgiganten-outlet-latest',
        type: 'apify-elgiganten',
        label: 'Elgiganten outlet latest',
        category: 'electronics',
        condition: 'outlet',
        actorId: 'shahidirfan/elgiganten-scraper',
        actorInput: {
          startUrl: 'https://www.elgiganten.se/search?q=outlet&view=products',
          results_wanted: 20,
          max_pages: 2
        },
        includePaths: ['/product/outlet/'],
        actorTimeoutMs: 120000,
        actorRequestRetries: 2,
        actorRetryBaseMs: 1,
        actorRetryMaxMs: 2,
        apiTokenEnvVar: 'APIFY_TOKEN',
        referenceLookup: false
      },
      fetcher,
      sourceState: {},
      now: '2026-04-17T14:00:00.000Z'
    });

    assert.equal(attempts, 3);
    assert.deepEqual(authorizations, ['Bearer test-apify-token', 'Bearer test-apify-token-2', 'Bearer test-apify-token']);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].externalId, '3000100');
  } finally {
    if (previousToken == null) {
      delete process.env.APIFY_TOKEN;
    } else {
      process.env.APIFY_TOKEN = previousToken;
    }

    if (previousToken2 == null) {
      delete process.env.APIFY_TOKEN_2;
    } else {
      process.env.APIFY_TOKEN_2 = previousToken2;
    }
  }
});
