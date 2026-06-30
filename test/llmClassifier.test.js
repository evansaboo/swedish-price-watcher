import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLlmClassifier,
  cacheKeyForTitle,
  isFlipRelevantTitle
} from '../src/services/llmClassifier.js';

const silentLogger = { log() {}, warn() {} };

// Build a fake fetch that returns a Gemini-shaped response from a label map.
function mockFetch(labelByTitle, { calls } = {}) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const text = body.contents[0].parts[0].text;
    // Parse "1. <title>\n2. <title>" back into ordered titles.
    const titles = text.split('\n').slice(1).map(l => l.replace(/^\d+\.\s/, ''));
    if (calls) calls.push(titles);
    const arr = titles.map((t, i) => ({
      index: i + 1,
      cleanLabel: t in labelByTitle ? labelByTitle[t] : null
    }));
    return {
      ok: true,
      status: 200,
      async json() {
        return { candidates: [{ content: { parts: [{ text: JSON.stringify(arr) }] } }] };
      }
    };
  };
}

test('createLlmClassifier returns null without an api key or when disabled', () => {
  assert.equal(createLlmClassifier({ apiKey: '' }), null);
  assert.equal(createLlmClassifier({ apiKey: 'x', enabled: false }), null);
});

// Build a fake fetch returning an Ollama /api/chat-shaped response.
function mockOllamaFetch(labelByTitle, { calls } = {}) {
  return async (url, options) => {
    assert.ok(String(url).endsWith('/api/chat'), 'ollama provider must hit /api/chat');
    const body = JSON.parse(options.body);
    assert.equal(body.stream, false);
    assert.ok(body.format, 'ollama must request structured output');
    const text = body.messages[1].content;
    const titles = text.split('\n')
      .map(l => l.replace(/^\d+\.\s/, ''))
      .filter(l => l && l !== 'Titles:' && !/^Return a JSON/.test(l));
    if (calls) calls.push(titles);
    const arr = titles.map((t, i) => ({
      index: i + 1,
      cleanLabel: t in labelByTitle ? labelByTitle[t] : null
    }));
    return { ok: true, status: 200, async json() { return { message: { content: JSON.stringify(arr) } }; } };
  };
}

test('ollama provider classifies via local /api/chat without an api key', async () => {
  const calls = [];
  const c = createLlmClassifier({
    provider: 'ollama', ollamaModel: 'qwen2.5:3b',
    fetchImpl: mockOllamaFetch({ 'Säljer min gamla GeForce 3060 Ti grafikkort fint skick': 'RTX 3060 Ti' }, { calls }),
    logger: silentLogger
  });
  assert.ok(c, 'ollama classifier needs no api key');
  assert.equal(c.provider, 'ollama');
  await c.enrich(['Säljer min gamla GeForce 3060 Ti grafikkort fint skick']);
  assert.equal(calls.length, 1, 'missed title must be sent to the local model');
  const r = c.resolveModel('Säljer min gamla GeForce 3060 Ti grafikkort fint skick');
  assert.equal(r.resaleKey, 'rtx-3060-ti');
});

test('isFlipRelevantTitle pre-filters to plausible flip products', () => {
  assert.equal(isFlipRelevantTitle('Nybyggd gamingdator RTX 5060 Ryzen 5'), true);
  assert.equal(isFlipRelevantTitle('iPhone 14 Pro 256GB'), true);
  assert.equal(isFlipRelevantTitle('Samsung 65" QLED TV'), false);
  assert.equal(isFlipRelevantTitle('Philips Hue glödlampa'), false);
});

test('resolveModel prefers the deterministic matcher and never calls the LLM for it', async () => {
  const calls = [];
  const c = createLlmClassifier({
    apiKey: 'k', fetchImpl: mockFetch({}, { calls }), logger: silentLogger
  });
  // Clean title the deterministic matcher already handles.
  const r = c.resolveModel('ASUS TUF Gaming GeForce RTX 4070 Ti 16GB');
  assert.equal(r.resaleKey, 'rtx-4070-ti');
  await c.enrich(['ASUS TUF Gaming GeForce RTX 4070 Ti 16GB']);
  assert.equal(calls.length, 0, 'deterministic titles must not be sent to the LLM');
});

test('enrich classifies missed titles and re-keys via the deterministic matcher', async () => {
  const labels = {
    'Säljer min gamla GeForce 3060 Ti grafikkort fint skick': 'RTX 3060 Ti'
  };
  const c = createLlmClassifier({
    apiKey: 'k', fetchImpl: mockFetch(labels), logger: silentLogger
  });
  // A structural accessory and a whole build are both filtered out before the LLM
  // (never sent/classified) — only the noisy bare-GPU title needs cleaning.
  const titles = [
    ...Object.keys(labels),
    'Silikonskal iPhone 14',
    'Gamingdator – MSI RTX 5060 | Intel i5-11400F'
  ];
  const stats = await c.enrich(titles);
  assert.equal(stats.classified, 1);
  assert.equal(stats.rejected, 0);

  // The cleaned label is re-keyed through the deterministic matcher.
  const r = c.resolveModel('Säljer min gamla GeForce 3060 Ti grafikkort fint skick');
  assert.equal(r.resaleKey, 'rtx-3060-ti');
  assert.equal(r.demandCategory, 'Graphics cards');

  // The build (system veto) and the accessory (accessory veto) both resolve null.
  assert.equal(c.resolveModel('Gamingdator – MSI RTX 5060 | Intel i5-11400F'), null);
  assert.equal(c.resolveModel('Silikonskal iPhone 14'), null);
});

test('console game-vs-hardware is decided deterministically, not by the LLM', async () => {
  const calls = [];
  const c = createLlmClassifier({
    apiKey: 'k', fetchImpl: mockFetch({}, { calls }), logger: silentLogger
  });
  // The deterministic hardware gate rejects the game and keeps the console, so the
  // unreliable local model is never consulted for either.
  await c.enrich(['PS5 Dragons Dogma 2', 'PlayStation 5 Slim Digital Edition']);
  assert.equal(calls.length, 0, 'console titles must NOT be sent to the LLM');

  // The game (leftover "dragons dogma" tokens) is dropped; the bare console matches.
  assert.equal(c.resolveModel('PS5 Dragons Dogma 2'), null);
  assert.equal(c.resolveModel('PlayStation 5 Slim Digital Edition').resaleKey, 'ps5-digital');
});

test('the LLM may not CREATE a console from a non-console title', async () => {
  // A KVM/network "switch" or a game with a parenthetical platform tag must never
  // become a console even if a stale cache holds a hallucinated console label.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-console-veto-'));
  const cacheFile = path.join(dir, 'cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 3,
    entries: {
      [cacheKeyForTitle('KVM-switch med VGA och USB')]: 'Nintendo Switch',
      [cacheKeyForTitle('NBA 2K23 (Xbox Series X)')]: 'Xbox Series X'
    }
  }));
  const c = createLlmClassifier({ apiKey: 'k', cacheFile, fetchImpl: mockFetch({}), logger: silentLogger });
  assert.equal(c.resolveModel('KVM-switch med VGA och USB'), null);
  assert.equal(c.resolveModel('NBA 2K23 (Xbox Series X)'), null);
});

test('high-precision (non-console) positives bypass the LLM', async () => {
  const calls = [];
  const c = createLlmClassifier({
    apiKey: 'k', fetchImpl: mockFetch({}, { calls }), logger: silentLogger
  });
  // A clean iPhone + GPU are high-precision: never sent for review.
  await c.enrich(['Apple iPhone 15 Pro 256GB', 'PNY GeForce RTX 4070 grafikkort']);
  assert.equal(calls.length, 0, 'high-precision titles must not be sent to the LLM');
  assert.equal(c.resolveModel('Apple iPhone 15 Pro 256GB').resaleKey, 'iphone-15-pro-256gb');
});

test('a hallucinated whole-system label is still rejected by deterministic guards', async () => {
  // Even if the LLM wrongly returns a system-y label, re-keying rejects it.
  const c = createLlmClassifier({
    apiKey: 'k',
    fetchImpl: mockFetch({ 'Stökig gamingdator-annons RTX 4070': 'Gamingdator RTX 4070' }),
    logger: silentLogger
  });
  await c.enrich(['Stökig gamingdator-annons RTX 4070']);
  assert.equal(c.resolveModel('Stökig gamingdator-annons RTX 4070'), null);
});

test('a build cleaned into a BARE card label is vetoed (build comp pollution fix)', async () => {
  // The real failure mode: a small model strips a build/laptop down to a clean
  // bare-card label ("RTX 5070") that DOES re-key to a bare card. The system/build
  // veto must block it so whole-build prices never enter the bare-GPU comp index.
  const calls = [];
  const buildTitle = 'Gigabyte A16 gaming laptop 16" svart i7 16GB 1TB RTX 5070';
  const c = createLlmClassifier({
    apiKey: 'k',
    fetchImpl: mockFetch({ [buildTitle]: 'RTX 5070' }, { calls }),
    logger: silentLogger
  });
  // Build/laptop titles must never be sent to the LLM in the first place.
  await c.enrich([buildTitle]);
  assert.equal(calls.length, 0, 'system/build titles must be skipped before the LLM');

  // Seed a stale "RTX 5070" cache label (as an older prompt could have produced)
  // and prove resolveModel's veto — not an empty cache — is what blocks it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-build-veto-'));
  const cacheFile = path.join(dir, 'cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 3,
    entries: { [cacheKeyForTitle(buildTitle)]: 'RTX 5070' }
  }));
  const seeded = createLlmClassifier({ apiKey: 'k', cacheFile, fetchImpl: mockFetch({}), logger: silentLogger });
  assert.equal(seeded.getCleanLabel(buildTitle), 'RTX 5070', 'cache really holds the bad label');
  assert.equal(seeded.resolveModel(buildTitle), null, 'veto blocks the stale bare-card label');
});

test('classifications persist to disk and reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-cache-'));
  const cacheFile = path.join(dir, 'cache.json');
  const labels = { 'GeForce 3060 Ti fyndvara grafikkort': 'RTX 3060 Ti' };

  const calls1 = [];
  const c1 = createLlmClassifier({
    apiKey: 'k', cacheFile, fetchImpl: mockFetch(labels, { calls: calls1 }), logger: silentLogger
  });
  await c1.enrich(Object.keys(labels));
  assert.equal(calls1.length, 1);
  assert.ok(fs.existsSync(cacheFile));

  // A fresh instance loads the cache and does NOT re-call the LLM.
  const calls2 = [];
  const c2 = createLlmClassifier({
    apiKey: 'k', cacheFile, fetchImpl: mockFetch(labels, { calls: calls2 }), logger: silentLogger
  });
  const r = c2.resolveModel('GeForce 3060 Ti fyndvara grafikkort');
  assert.equal(r.resaleKey, 'rtx-3060-ti');
  await c2.enrich(Object.keys(labels));
  assert.equal(calls2.length, 0, 'cached titles must not be re-classified');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an older-version cache is migrated: high-precision kept, low-precision dropped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-cache-'));
  const cacheFile = path.join(dir, 'cache.json');
  // Simulate a v1 cache written by an older, game-unaware prompt: a real GPU
  // label (keep), a null verdict (keep), and a GAME mislabelled as the console
  // (drop — re-keys into a low-precision console category).
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 1,
    entries: {
      'geforce 3060 ti fyndvara grafikkort': 'RTX 3060 Ti',
      'nybyggd gamingdator rtx 4070': null,
      'nintendo lego marvel super heroes': 'Nintendo Switch'
    }
  }));

  const calls = [];
  const c = createLlmClassifier({
    apiKey: 'k', cacheFile, fetchImpl: mockFetch({}, { calls }), logger: silentLogger
  });

  // High-precision GPU label survives the migration (no LLM call needed).
  assert.equal(c.resolveModel('GeForce 3060 Ti fyndvara grafikkort').resaleKey, 'rtx-3060-ti');
  // Null verdict survives.
  assert.equal(c.getCleanLabel('Nybyggd gamingdator RTX 4070'), null);
  // The mislabelled game was dropped → its (now empty) entry no longer keys it.
  assert.equal(c.getCleanLabel('Nintendo Lego Marvel Super Heroes'), undefined);

  // The migrated cache is rewritten at the current version.
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(saved.version, 3);
  assert.ok(!('nintendo lego marvel super heroes' in saved.entries));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the LLM may not recover a structural accessory by cleaning it to a device', async () => {
  // Even if the cache holds a device label for an accessory title (an LLM that
  // stripped "Swivel Case" down to "iPad Pro 11"), the veto keeps it rejected.
  const c = createLlmClassifier({
    apiKey: 'k',
    fetchImpl: mockFetch({ 'Linocell Swivel Case för iPad Pro 11': 'iPad Pro 11' }),
    logger: silentLogger
  });
  await c.enrich(['Linocell Swivel Case för iPad Pro 11']);
  assert.equal(c.resolveModel('Linocell Swivel Case för iPad Pro 11'), null);
});

test('concurrent enrich() calls are coalesced into a single run', async () => {
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  const slowFetch = async (_url, options) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 20));
    const body = JSON.parse(options.body);
    const titles = body.contents[0].parts[0].text.split('\n').slice(1).map(l => l.replace(/^\d+\.\s/, ''));
    calls.push(titles);
    inFlight--;
    const arr = titles.map((t, i) => ({ index: i + 1, cleanLabel: null }));
    return { ok: true, status: 200, async json() { return { candidates: [{ content: { parts: [{ text: JSON.stringify(arr) }] } }] }; } };
  };
  const c = createLlmClassifier({
    apiKey: 'k', minRequestIntervalMs: 0, fetchImpl: slowFetch, logger: silentLogger
  });
  // Fire two enrich runs simultaneously; the second must coalesce into the first.
  const [s1, s2] = await Promise.all([
    c.enrich(['GeForce 3060 Ti grafikkort till salu A']),
    c.enrich(['GeForce 3060 Ti grafikkort till salu B'])
  ]);
  assert.equal(maxInFlight, 1, 'no two LLM requests should overlap');
  assert.deepEqual(s1, s2, 'both callers observe the same coalesced run');
});

test('a failing batch is left uncached so it retries later', async () => {
  let attempts = 0;
  const failingFetch = async () => {
    attempts++;
    return { ok: false, status: 503, async json() { return {}; } };
  };
  const c = createLlmClassifier({
    apiKey: 'k', maxRetries: 1, serverErrorBackoffMs: 5, minRequestIntervalMs: 0,
    fetchImpl: failingFetch, logger: silentLogger
  });
  const stats = await c.enrich(['GeForce 3060 Ti grafikkort till salu']);
  assert.equal(stats.classified, 0);
  assert.equal(stats.errors, 1);
  assert.ok(attempts >= 2, 'should retry on 503');
  // Not cached → resolves to null for now, can be retried on a later run.
  assert.equal(c.resolveModel('GeForce 3060 Ti grafikkort till salu'), null);
});

test('cacheKeyForTitle normalizes whitespace and case', () => {
  assert.equal(cacheKeyForTitle('  RTX  4070   Ti '), 'rtx 4070 ti');
});
