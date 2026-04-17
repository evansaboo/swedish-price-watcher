import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../src/app.js';
import { createDefaultState } from '../src/lib/store.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

test('manual run explains when no sources are enabled', async () => {
  const app = await buildApp({
    config: {
      publicDir,
      sources: []
    },
    store: {
      getState() {
        return createDefaultState();
      }
    },
    scanState: {
      running: false,
      lastError: null
    },
    triggerScan: async () => ({})
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/run'
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    ok: false,
    message: 'No sources are enabled. Add or enable a source in config/sources.json.'
  });

  await app.close();
});

test('manual run starts in the background when sources are enabled', async () => {
  let triggerStarted = false;
  let releaseTrigger = () => {};
  const triggerGate = new Promise((resolve) => {
    releaseTrigger = resolve;
  });

  const app = await buildApp({
    config: {
      publicDir,
      sources: [
        {
          id: 'komplett-outlet-electronics',
          label: 'Komplett outlet electronics',
          enabled: true
        }
      ]
    },
    store: {
      getState() {
        return createDefaultState();
      }
    },
    scanState: {
      running: false,
      lastError: null,
      startedAt: null,
      currentSourceId: null,
      completedSources: 0,
      totalSources: 0
    },
    triggerScan: async () => {
      triggerStarted = true;
      await triggerGate;
      return {};
    }
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/run'
  });

  assert.equal(triggerStarted, true);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), {
    ok: true,
    started: true,
    message: 'Live scan started.'
  });

  releaseTrigger();
  await app.close();
});

test('returns simplified outlet products and favorite category stats', async () => {
  const state = createDefaultState();
  state.items = {
    'elgiganten-outlet-latest:1000290': {
      listingKey: 'elgiganten-outlet-latest:1000290',
      sourceId: 'elgiganten-outlet-latest',
      sourceLabel: 'Elgiganten outlet latest',
      condition: 'outlet',
      category: 'Horlurar',
      title: 'Sony WH-1000XM5 outlet',
      url: 'https://www.elgiganten.se/product/outlet/1000290',
      latestPriceSek: 2790,
      referencePriceSek: 3990,
      marketValueSek: 3990,
      highestPriceSek: 3990,
      firstSeenAt: '2026-04-17T09:00:00.000Z',
      lastSeenAt: '2026-04-17T10:00:00.000Z'
    },
    'elgiganten-outlet-latest:1000291': {
      listingKey: 'elgiganten-outlet-latest:1000291',
      sourceId: 'elgiganten-outlet-latest',
      sourceLabel: 'Elgiganten outlet latest',
      condition: 'outlet',
      category: 'TV',
      title: 'LG OLED C2 outlet',
      url: 'https://www.elgiganten.se/product/outlet/1000291',
      latestPriceSek: 9990,
      referencePriceSek: 12990,
      marketValueSek: 12990,
      highestPriceSek: 12990,
      firstSeenAt: '2026-04-17T09:00:00.000Z',
      lastSeenAt: '2026-04-17T10:00:00.000Z'
    },
    'elgiganten-outlet-latest:1000292': {
      listingKey: 'elgiganten-outlet-latest:1000292',
      sourceId: 'elgiganten-outlet-latest',
      sourceLabel: 'Elgiganten outlet latest',
      condition: 'outlet',
      category: 'Horlurar',
      title: 'Outlet product without catalog match',
      url: 'https://www.elgiganten.se/product/outlet/1000292',
      latestPriceSek: 1490,
      referencePriceSek: null,
      marketValueSek: null,
      highestPriceSek: 1490,
      firstSeenAt: '2026-04-17T09:00:00.000Z',
      lastSeenAt: '2026-04-17T10:00:00.000Z'
    }
  };
  state.preferences.favoriteCategories = ['Horlurar'];

  const app = await buildApp({
    config: {
      publicDir,
      sources: []
    },
    store: {
      getState() {
        return state;
      },
      async save() {}
    },
    scanState: {
      running: false,
      lastError: null,
      startedAt: null,
      currentSourceId: null,
      completedSources: 0,
      totalSources: 0
    },
    triggerScan: async () => ({})
  });

  const productsResponse = await app.inject({
    method: 'GET',
    url: '/api/outlet-products?favoritesOnly=true'
  });
  const products = productsResponse.json();

  assert.equal(productsResponse.statusCode, 200);
  assert.equal(products.length, 2);
  assert.equal(products.every((product) => product.category === 'Horlurar'), true);
  assert.equal(products.some((product) => product.discountSek === 1200 && product.discountPercent === 30), true);

  const categoriesResponse = await app.inject({
    method: 'GET',
    url: '/api/outlet-categories'
  });
  const categories = categoriesResponse.json();

  const filteredResponse = await app.inject({
    method: 'GET',
    url: '/api/outlet-products?referenceOnly=true&minDiscountPercent=25&maxPriceSek=3000'
  });
  const filteredProducts = filteredResponse.json();

  assert.equal(categoriesResponse.statusCode, 200);
  assert.equal(categories.length, 2);
  assert.equal(categories.find((category) => category.name === 'Horlurar').favorite, true);
  assert.equal(categories.find((category) => category.name === 'TV').favorite, false);
  assert.equal(filteredResponse.statusCode, 200);
  assert.equal(filteredProducts.length, 1);
  assert.equal(filteredProducts[0].listingKey, 'elgiganten-outlet-latest:1000290');

  await app.close();
});

test('scheduler settings can be read and updated through API', async () => {
  const state = createDefaultState();
  const schedulerState = {
    enabled: true,
    intervalMinutes: 180,
    nextRunAt: null,
    activeWindow: {
      enabled: true,
      startTime: '07:00',
      endTime: '00:00',
      timeZone: 'Europe/Stockholm'
    },
    isInActiveWindow: true
  };

  const app = await buildApp({
    config: {
      publicDir,
      sources: []
    },
    store: {
      getState() {
        return state;
      },
      async save() {}
    },
    scanState: {
      running: false,
      lastError: null,
      startedAt: null,
      currentSourceId: null,
      completedSources: 0,
      totalSources: 0
    },
    triggerScan: async () => ({}),
    scheduler: {
      getState() {
        return { ...schedulerState };
      },
      async update(next) {
        if (next.enabled !== undefined) {
          schedulerState.enabled = Boolean(next.enabled);
        }

        if (next.intervalMinutes !== undefined) {
          schedulerState.intervalMinutes = Number.parseInt(String(next.intervalMinutes), 10);
        }

        if (next.activeWindow && typeof next.activeWindow === 'object') {
          schedulerState.activeWindow = {
            ...schedulerState.activeWindow,
            ...next.activeWindow
          };
        }

        return { ...schedulerState };
      }
    }
  });

  const getResponse = await app.inject({
    method: 'GET',
    url: '/api/scheduler'
  });

  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.json().intervalMinutes, 180);
  assert.equal(getResponse.json().activeWindow.startTime, '07:00');

  const updateResponse = await app.inject({
    method: 'PUT',
    url: '/api/scheduler',
    payload: {
      enabled: false,
      intervalMinutes: 45,
      activeWindow: {
        enabled: true,
        startTime: '08:00',
        endTime: '23:00',
        timeZone: 'Europe/Stockholm'
      }
    }
  });

  assert.equal(updateResponse.statusCode, 200);
  assert.deepEqual(updateResponse.json(), {
    enabled: false,
    intervalMinutes: 45,
    nextRunAt: null,
    activeWindow: {
      enabled: true,
      startTime: '08:00',
      endTime: '23:00',
      timeZone: 'Europe/Stockholm'
    },
    isInActiveWindow: true
  });

  const invalidResponse = await app.inject({
    method: 'PUT',
    url: '/api/scheduler',
    payload: {
      intervalMinutes: 0
    }
  });

  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(invalidResponse.json().message, 'intervalMinutes must be a positive integer.');

  const invalidWindowResponse = await app.inject({
    method: 'PUT',
    url: '/api/scheduler',
    payload: {
      activeWindow: {
        startTime: '25:00'
      }
    }
  });

  assert.equal(invalidWindowResponse.statusCode, 400);
  assert.equal(invalidWindowResponse.json().message, 'activeWindow.startTime must use HH:MM format.');

  await app.close();
});
