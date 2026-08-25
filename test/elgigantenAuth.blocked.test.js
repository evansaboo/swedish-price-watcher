import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isHardDeny,
  getElgigantenBlockStatus,
  getSharedAlgoliaApiKey,
  resetElgigantenAuthState
} from '../src/sources/elgigantenAuth.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { createDefaultState } from '../src/lib/store.js';
import { ProductCache } from '../src/services/productCache.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

function buildTestCache(state) {
  const cache = new ProductCache();
  cache.rebuild(state);
  return cache;
}

/**
 * Elgiganten moved from a 429 bot *challenge* (solvable by presenting a real
 * browser) to a 403 firewall *deny* on the egress IP, where every path —
 * including /robots.txt — is refused. The old code only cooled down on 429, so
 * a permanent block was retried forever: each scan cycle and each hotlist poll
 * launched a fresh Chromium on the Pi just to be denied again.
 */

test('elgiganten hard-deny handling', async (t) => {
  t.afterEach(() => {
    resetElgigantenAuthState();
    delete process.env.ELGIGANTEN_PROXY_URL;
  });

  await t.test('distinguishes a deny from the 429 challenge', () => {
    assert.equal(isHardDeny(403, 'deny'), true);
    assert.equal(isHardDeny(403, 'DENY'), true);
    // The challenge is recoverable via a browser, so it must NOT be a deny.
    assert.equal(isHardDeny(429, 'challenge'), false);
    assert.equal(isHardDeny(403, 'challenge'), false);
    assert.equal(isHardDeny(403, null), false);
    assert.equal(isHardDeny(200, 'deny'), false);
  });

  await t.test('starts out unblocked', () => {
    const status = getElgigantenBlockStatus();
    assert.equal(status.blocked, false);
    assert.equal(status.blockedUntil, null);
  });

  await t.test('reports whether a proxy escape hatch is configured', () => {
    assert.equal(getElgigantenBlockStatus().proxyConfigured, false);
    process.env.ELGIGANTEN_PROXY_URL = 'http://user:pass@proxy.example:8000';
    assert.equal(getElgigantenBlockStatus().proxyConfigured, true);
  });

  await t.test('a malformed proxy is ignored rather than crashing the scan', () => {
    process.env.ELGIGANTEN_PROXY_URL = 'not a url';
    assert.equal(getElgigantenBlockStatus().proxyConfigured, false);
  });

  await t.test('while blocked it fails fast without launching a browser', async () => {
    // Force the module into the blocked state through its public surface by
    // driving a denied acquisition, with the browser path disabled so no
    // Chromium is launched and the direct path is fully stubbed.
    process.env.ELGIGANTEN_NO_BROWSER = '1';
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{"error":{"code":"403"}}', {
        status: 403,
        headers: { 'x-vercel-mitigated': 'deny' }
      });
    };

    try {
      await assert.rejects(() => getSharedAlgoliaApiKey('[test]'), /blocked by Elgiganten/);
      assert.equal(fetchCalls, 1, 'a deny must not be retried');

      const status = getElgigantenBlockStatus();
      assert.equal(status.blocked, true);
      assert.ok(status.blockedUntil, 'cooldown deadline is recorded');

      // Every later caller (other sources, the hotlist poller) short-circuits.
      await assert.rejects(() => getSharedAlgoliaApiKey('[test-2]'), /blocked by Elgiganten/);
      assert.equal(fetchCalls, 1, 'no further requests while cooling down');
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.ELGIGANTEN_NO_BROWSER;
    }
  });

  await t.test('the thrown error tells the caller to cool the source down', async () => {
    process.env.ELGIGANTEN_NO_BROWSER = '1';
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{}', {
      status: 403,
      headers: { 'x-vercel-mitigated': 'deny' }
    });

    try {
      const err = await getSharedAlgoliaApiKey('[test]').catch((e) => e);
      // src/index.js turns disableHours into sourceState.disabledUntil.
      assert.ok(err.disableHours > 0, 'carries a cooldown so scans stand down');
      assert.equal(err.blocked, true);
      assert.equal(err.status, 403);
      assert.match(err.message, /ELGIGANTEN_PROXY_URL/, 'points at the recovery path');
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.ELGIGANTEN_NO_BROWSER;
    }
  });
});

test('POST /api/elgiganten/retry clears a stale cooldown', async (t) => {
  t.afterEach(() => resetElgigantenAuthState());

  const state = createDefaultState();
  // Two Elgiganten sources cooling down, plus an unrelated source that must
  // be left alone.
  state.sourceStates = {
    'elgiganten-outlet': { disabledUntil: new Date(Date.now() + 6 * 3600_000).toISOString() },
    'elgiganten-hotlist': { disabledUntil: new Date(Date.now() + 6 * 3600_000).toISOString() },
    'netonnet-outlet': { disabledUntil: new Date(Date.now() + 6 * 3600_000).toISOString() }
  };

  let saved = 0;
  const app = await buildApp({
    config: {
      publicDir,
      sources: [
        { id: 'elgiganten-outlet', enabled: true },
        { id: 'elgiganten-hotlist', enabled: true },
        { id: 'netonnet-outlet', enabled: true }
      ]
    },
    store: { getState: () => state, save: async () => { saved++; } },
    productCache: buildTestCache(state),
    scanState: { running: false, lastError: null },
    triggerScan: async () => ({})
  });
  t.after(() => app.close());

  // Stub the reachability probe so the test never touches the network.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 429 });
  t.after(() => { globalThis.fetch = realFetch; });

  const res = await app.inject({ method: 'POST', url: '/api/elgiganten/retry' });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stillBlocked, false, '429 is a solvable challenge, not a block');
  assert.deepEqual(body.clearedSources.sort(), ['elgiganten-hotlist', 'elgiganten-outlet']);
  assert.equal(saved, 1, 'the cleared cooldown is persisted');

  assert.equal(state.sourceStates['elgiganten-outlet'].disabledUntil, undefined);
  assert.equal(state.sourceStates['elgiganten-hotlist'].disabledUntil, undefined);
  assert.ok(
    state.sourceStates['netonnet-outlet'].disabledUntil,
    'unrelated sources keep their own cooldown'
  );
});

test('status endpoint reports the Elgiganten block', async (t) => {
  t.afterEach(() => resetElgigantenAuthState());

  const state = createDefaultState();
  const app = await buildApp({
    config: { publicDir, sources: [] },
    store: { getState: () => state, save: async () => {} },
    productCache: buildTestCache(state),
    scanState: { running: false, lastError: null },
    triggerScan: async () => ({})
  });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/status' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().elgigantenBlock.blocked, false);
});

test('retry reports when the IP is still blocked', async (t) => {
  t.afterEach(() => resetElgigantenAuthState());

  const state = createDefaultState();
  const app = await buildApp({
    config: { publicDir, sources: [] },
    store: { getState: () => state, save: async () => {} },
    productCache: buildTestCache(state),
    scanState: { running: false, lastError: null },
    triggerScan: async () => ({})
  });
  t.after(() => app.close());

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', {
    status: 403,
    headers: { 'x-vercel-mitigated': 'deny' }
  });
  t.after(() => { globalThis.fetch = realFetch; });

  const body = (await app.inject({ method: 'POST', url: '/api/elgiganten/retry' })).json();
  assert.equal(body.stillBlocked, true);
  assert.equal(body.probe.status, 'denied');
  // The user must not be told it worked when the IP is still denied.
  assert.match(body.message, /still blocked/i);
});
