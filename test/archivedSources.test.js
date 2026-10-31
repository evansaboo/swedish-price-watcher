import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { JsonStore, SqliteStore, reconcileStateWithSources } from '../src/lib/store.js';
import { mergeObservations } from '../src/services/dealEngine.js';
import { ProductCache } from '../src/services/productCache.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// Since 2026-10-31 only the Elgiganten hotlist and the Komplett demo watcher
// feed the listing. Rows of the archived scrapers stay in the database but
// must never reach the dashboard, and nothing may delete them.

const ACTIVE = ['elgiganten-hotlist', 'komplett-demo'];

function obs(sourceId, id, overrides = {}) {
  return {
    sourceId,
    sourceLabel: sourceId,
    externalId: String(id),
    title: `${sourceId} product ${id}`,
    url: `https://example.test/${sourceId}/${id}`,
    category: 'Grafikkort',
    condition: 'outlet',
    priceSek: 1000 + id,
    availability: 'in_stock',
    seenAt: '2026-10-30T12:00:00.000Z',
    ...overrides
  };
}

function seed(state) {
  mergeObservations(state, [
    obs('elgiganten-hotlist', 1),
    obs('komplett-demo', 2),
    obs('netonnet-outlet', 3),
    obs('power-deals', 4),
    obs('blocket-electronics', 5, { condition: 'used' })
  ]);
  // A second observation so the archived rows carry price history.
  mergeObservations(state, [obs('netonnet-outlet', 3, { priceSek: 900, seenAt: '2026-10-30T13:00:00.000Z' })]);
  state.sourceStates['netonnet-outlet'] = { lastSuccessAt: '2026-10-30T13:00:00.000Z', lastCount: 1 };
  state.notifications['netonnet-outlet:3:rule:r1'] = '2026-10-30T13:00:00.000Z';
}

function rowCounts(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      items: Object.fromEntries(db.prepare('SELECT source_id, COUNT(*) AS n FROM items GROUP BY source_id').all().map((r) => [r.source_id, r.n])),
      history: db.prepare("SELECT COUNT(*) AS n FROM price_history WHERE listing_key = 'netonnet-outlet:3'").get().n,
      sourceStates: db.prepare("SELECT COUNT(*) AS n FROM source_states WHERE source_id = 'netonnet-outlet'").get().n,
      notifications: db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE notification_key LIKE 'netonnet-outlet:%'").get().n
    };
  } finally {
    db.close();
  }
}

test('archived-source rows are hidden from the listing but stay in SQLite through saves and restarts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archived-sources-'));
  const dbPath = path.join(dir, 'store.db');
  const warnings = [];
  const originalWarn = console.warn;
  try {
    const seedStore = new SqliteStore(dbPath);
    await seedStore.load();
    seed(seedStore.getState());
    await seedStore.save();
    const before = rowCounts(dbPath);
    assert.deepEqual(before.items, { 'blocket-electronics': 1, 'elgiganten-hotlist': 1, 'komplett-demo': 1, 'netonnet-outlet': 1, 'power-deals': 1 });
    assert.equal(before.history, 2);

    console.warn = (...args) => { warnings.push(args.join(' ')); };

    // Startup with only the active sources configured.
    const store = new SqliteStore(dbPath);
    await store.load();
    const { hiddenItems, hiddenSourceIds } = reconcileStateWithSources(store.getState(), ACTIVE);
    assert.equal(hiddenItems, 3);
    assert.deepEqual(hiddenSourceIds, ['blocket-electronics', 'netonnet-outlet', 'power-deals']);

    const state = store.getState();
    assert.deepEqual(Object.keys(state.items).sort(), ['elgiganten-hotlist:1', 'komplett-demo:2'], 'komplett-demo is not treated as archived');

    const cache = new ProductCache();
    cache.rebuild(state);
    assert.deepEqual(cache.products.map((p) => p.sourceId).sort(), ['elgiganten-hotlist', 'komplett-demo']);
    assert.deepEqual(cache.sources.map((s) => s.id).sort(), ['elgiganten-hotlist', 'komplett-demo']);

    // Every write path the app uses: metadata save, full sync, incremental
    // flush with a deletion of an active-source item.
    await store.save({ skipItems: true });
    await store.save();
    delete state.items['elgiganten-hotlist:1'];
    store.flushItems([], ['elgiganten-hotlist:1']);
    await store.save();

    const after = rowCounts(dbPath);
    assert.equal(after.items['netonnet-outlet'], 1);
    assert.equal(after.items['power-deals'], 1);
    assert.equal(after.items['blocket-electronics'], 1);
    assert.equal(after.items['elgiganten-hotlist'], undefined, 'active-source deletions still work');
    assert.equal(after.history, 2, 'price history of archived rows is kept');
    assert.equal(after.sourceStates, 1);
    assert.equal(after.notifications, 1);

    // A second restart hides them again, without warnings.
    const restarted = new SqliteStore(dbPath);
    await restarted.load();
    assert.equal(reconcileStateWithSources(restarted.getState(), ACTIVE).hiddenItems, 3);
    assert.deepEqual(warnings, []);

    // Reviving a source (configuring it again) brings its rows straight back.
    const revived = reconcileStateWithSources(restarted.getState(), [...ACTIVE, 'netonnet-outlet']);
    assert.equal(revived.hiddenItems, 2);
    assert.equal(restarted.getState().items['netonnet-outlet:3'].latestPriceSek, 900);
    assert.equal(restarted.getItemHistory('netonnet-outlet:3').length, 2);
  } finally {
    console.warn = originalWarn;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the JSON store also writes hidden archived-source items back untouched', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archived-sources-json-'));
  const file = path.join(dir, 'store.json');
  try {
    const first = new JsonStore(file);
    await first.load();
    seed(first.getState());
    await first.save();

    const store = new JsonStore(file);
    await store.load();
    reconcileStateWithSources(store.getState(), ACTIVE);
    assert.equal(Object.keys(store.getState().items).length, 2);
    await store.save();

    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(raw.items).sort(), [
      'blocket-electronics:5', 'elgiganten-hotlist:1', 'komplett-demo:2', 'netonnet-outlet:3', 'power-deals:4'
    ]);
    assert.equal(raw.inactiveItems, undefined, 'the in-memory split is not persisted');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('loading state with unknown source ids and stale scan metadata does not crash', () => {
  const state = {
    items: { 'gone-source:1': { listingKey: 'gone-source:1', sourceId: 'gone-source', latestPriceSek: 1 }, 'broken:2': null },
    deals: [{ listingKey: 'gone-source:1' }],
    sourceStates: { 'gone-source': { knownExternalIds: {} } },
    notifications: {},
    stats: { lastRunSummary: { sourceResults: [{ sourceId: 'gone-source', status: 'ok' }] } }
  };
  const result = reconcileStateWithSources(state, ACTIVE);
  assert.equal(result.hiddenItems, 2);
  assert.deepEqual(state.items, {});
  assert.deepEqual(state.deals, []);
  assert.ok(state.stats.lastRunSummary, 'old run summary is left alone');
});
