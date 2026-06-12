import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveIncrementalMode } from '../src/lib/incremental.js';

function makeSourceState(knownCount = 10) {
  return {
    knownExternalIds: new Set(Array.from({ length: knownCount }, (_, i) => `id-${i}`))
  };
}

test('inactive when source has no incrementalStopPages and no default', () => {
  const state = makeSourceState();
  const mode = resolveIncrementalMode({}, state);
  assert.equal(mode.active, false);
  assert.equal(mode.knownIds.size, 10, 'known IDs still exposed for logging');
});

test('inactive on first scan (no known IDs) even when configured', () => {
  const state = { knownExternalIds: new Set() };
  const mode = resolveIncrementalMode({ incrementalStopPages: 2 }, state);
  assert.equal(mode.active, false);
});

test('active with configured stop pages and known IDs', () => {
  const state = makeSourceState();
  const mode = resolveIncrementalMode({ incrementalStopPages: 3 }, state);
  assert.equal(mode.active, true);
  assert.equal(mode.stopPages, 3);
  assert.equal(state.incrementalScanCount, 1);
});

test('defaultStopPages enables incremental without config (ProShop behaviour)', () => {
  const state = makeSourceState();
  const mode = resolveIncrementalMode({}, state, { defaultStopPages: 2 });
  assert.equal(mode.active, true);
  assert.equal(mode.stopPages, 2);
});

test('forces a full scan every incrementalFullScanEvery-th run', () => {
  const source = { incrementalStopPages: 2, incrementalFullScanEvery: 3 };
  const state = makeSourceState();

  const run1 = resolveIncrementalMode(source, state);
  const run2 = resolveIncrementalMode(source, state);
  const run3 = resolveIncrementalMode(source, state);
  const run4 = resolveIncrementalMode(source, state);

  assert.equal(run1.active, true, 'run 1 incremental');
  assert.equal(run2.active, true, 'run 2 incremental');
  assert.equal(run3.active, false, 'run 3 forced full scan');
  assert.equal(state.incrementalScanCount === 0 || run3.active === false, true);
  assert.equal(run4.active, true, 'counter reset — run 4 incremental again');
});
