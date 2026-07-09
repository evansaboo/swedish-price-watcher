import test from 'node:test';
import assert from 'node:assert/strict';

// The auth module's key cache is a module-level singleton (by design — it's
// shared across all Elgiganten sources). Each test re-imports with a unique
// query string to get a fresh module instance and an isolated cache.
async function freshAuthModule() {
  return import(`../src/sources/elgigantenAuth.js?t=${Date.now()}-${Math.random()}`);
}

function fakeApiKey(validUntilEpochSec) {
  return Buffer.from(`validUntil=${validUntilEpochSec}&other=1`, 'utf8').toString('base64');
}

test('getSharedAlgoliaApiKey returns key from direct 200 response and caches it', async () => {
  const { getSharedAlgoliaApiKey } = await freshAuthModule();
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  const key = fakeApiKey(Math.floor(Date.now() / 1000) + 600);

  globalThis.fetch = async () => {
    callCount += 1;
    return {
      ok: true,
      status: 200,
      headers: new Map([['set-cookie', null]]).get ? { get: () => null } : {},
      clone() { return this; },
      json: async () => ({ apiKey: key })
    };
  };

  try {
    const first = await getSharedAlgoliaApiKey('[test]');
    const second = await getSharedAlgoliaApiKey('[test]');
    assert.equal(first, key);
    assert.equal(second, key);
    assert.equal(callCount, 1, 'second call should reuse the cached key without another fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getSharedAlgoliaApiKey retries on 429 and succeeds on the next attempt', async () => {
  const { getSharedAlgoliaApiKey } = await freshAuthModule();
  const originalFetch = globalThis.fetch;
  const key = fakeApiKey(Math.floor(Date.now() / 1000) + 600);
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => (name === 'retry-after' ? '0' : null) },
        clone() { return this; },
        json: async () => ({})
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      clone() { return this; },
      json: async () => ({ apiKey: key })
    };
  };

  try {
    const result = await getSharedAlgoliaApiKey('[test]');
    assert.equal(result, key);
    assert.equal(callCount, 2, 'should retry once after a 429 before succeeding');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getSharedAlgoliaApiKey throws with disableHours after exhausting retries on persistent 429', async () => {
  const { getSharedAlgoliaApiKey } = await freshAuthModule();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    headers: { get: (name) => (name === 'retry-after' ? '0' : null) },
    clone() { return this; },
    json: async () => ({})
  });

  try {
    await assert.rejects(
      () => getSharedAlgoliaApiKey('[test]'),
      (err) => {
        assert.match(err.message, /rate-limited \(429\)/);
        assert.equal(err.disableHours, 2);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
