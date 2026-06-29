// ═══════════════════════════════════════════════════════════════
// llmClassifier — hosted Gemini fallback for resale-model extraction
// ───────────────────────────────────────────────────────────────
// The deterministic `extractResaleModel` matcher (resaleEngine.js) is the fast,
// free, authoritative path. It is conservative: noisy Blocket titles it cannot
// parse return null. This module recovers those by asking Gemini to CLEAN a
// noisy title into a canonical product label — it never invents resale keys.
//
// Key-consistency invariant: the cleaned label is fed BACK through
// `extractResaleModel`, so every resaleKey ultimately comes from the
// deterministic matcher. Comps and candidates therefore always bucket under
// identical keys, and a whole-system/accessory label the LLM mistakenly returns
// is re-rejected by the deterministic guards. The LLM only ever cleans text.
//
// Runs OUT OF BAND (after scans / at boot), batched, with a persistent on-disk
// cache so each unique title is classified at most once. Degrades gracefully:
// no API key, or any request failure, leaves the deterministic path untouched.
// ═══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import { extractResaleModel } from './resaleEngine.js';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Cheap pre-filter: only titles that plausibly name a flip-relevant product are
// ever sent to the LLM, so we never spend tokens on TVs, cables, fridges, etc.
const RELEVANT_HINT = new RegExp(
  [
    'iphone', 'ipad', 'macbook', 'mac\\s?book', 'airpods', 'apple\\s?watch', 'watch\\s?series',
    'rtx', 'gtx', 'radeon', 'geforce', 'grafikkort', '\\barc\\s?[ab]\\d', 'intel\\s?arc',
    'ryzen', 'threadripper', 'core\\s?ultra', '\\bi[3579][\\s-]?\\d{4,5}',
    'playstation', '\\bps[45]\\b', 'xbox', 'nintendo', 'switch', 'steam\\s?deck',
    'rog\\s?ally', 'legion\\s?go'
  ].join('|'),
  'i'
);

const SYSTEM_INSTRUCTION =
  'You normalize noisy Swedish/English second-hand electronics listing titles for a resale price index. ' +
  'For EACH input title, decide whether it is a SINGLE, bare, resellable product in one of these categories: ' +
  'iPhone, iPad, MacBook, AirPods, Apple Watch, a bare graphics card (GPU), a bare processor (CPU), ' +
  'a game console (PlayStation/Xbox/Nintendo Switch), or a handheld (Steam Deck/ROG Ally/Legion Go/Switch). ' +
  'If it IS such a product, return a clean canonical model label in standard English form with the brand/model and key specs only ' +
  '(examples: "RTX 4070 Ti", "iPhone 14 Pro 256GB", "MacBook Air M2", "PlayStation 5 Digital", "Nintendo Switch OLED", ' +
  '"Steam Deck OLED 512GB", "AMD Ryzen 7 5800X3D", "AirPods Pro 2"). ' +
  'Return null (not a label) when the title is a WHOLE computer/laptop/prebuilt/gaming build (e.g. "gamingdator", "speldator", ' +
  '"nybyggd dator", a Lenovo Legion / ASUS ROG laptop, or a CPU+GPU bundle), an accessory (case/skal/fodral/charger/cable/strap/screen protector), ' +
  'broken / for-parts, or anything outside the listed categories. ' +
  'Respond ONLY with a JSON array, one element per input, in the same order.';

const RESPONSE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      index: { type: 'integer' },
      cleanLabel: { type: 'string', nullable: true }
    },
    required: ['index']
  }
};

// Stable cache key: lowercase, collapse whitespace. Independent of the resale
// engine's heavier normalization so the cache stays human-readable.
export function cacheKeyForTitle(title) {
  return String(title ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isFlipRelevantTitle(title) {
  return RELEVANT_HINT.test(String(title ?? ''));
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create the Gemini-backed classifier, or return null when disabled / no key.
 * @returns {null | {
 *   resolveModel(title): object|null,
 *   getCleanLabel(title): string|null|undefined,
 *   enrich(titles: string[]): Promise<{classified:number, rejected:number, errors:number}>,
 *   size(): number
 * }}
 */
export function createLlmClassifier(opts = {}) {
  const {
    apiKey = '',
    enabled = true,
    model = 'gemini-2.5-flash-lite',
    cacheFile = null,
    batchSize = 25,
    maxTitlesPerRun = 400,
    requestTimeoutMs = 30000,
    maxRetries = 2,
    fetchImpl = globalThis.fetch,
    logger = console
  } = opts;

  if (!enabled || !apiKey || typeof fetchImpl !== 'function') return null;

  // normTitle -> string (clean label) | null (rejected). Absent = not yet seen.
  const cache = new Map();

  function loadCache() {
    if (!cacheFile) return;
    try {
      if (!fs.existsSync(cacheFile)) return;
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const entries = raw?.entries ?? {};
      for (const [k, v] of Object.entries(entries)) {
        cache.set(k, v === null ? null : String(v));
      }
      logger.log?.(`[llm] loaded ${cache.size} cached title classifications`);
    } catch (err) {
      logger.warn?.(`[llm] cache load failed: ${err.message}`);
    }
  }

  function saveCache() {
    if (!cacheFile) return;
    try {
      const entries = {};
      for (const [k, v] of cache.entries()) entries[k] = v;
      fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, entries }, null, 0));
    } catch (err) {
      logger.warn?.(`[llm] cache save failed: ${err.message}`);
    }
  }

  loadCache();

  function getCleanLabel(title) {
    return cache.get(cacheKeyForTitle(title));
  }

  // Deterministic-first resolver with LLM gap-fill. Always re-keys through the
  // deterministic matcher so resaleKeys stay consistent across the whole index.
  function resolveModel(title) {
    const direct = extractResaleModel(title);
    if (direct) return direct;
    const clean = cache.get(cacheKeyForTitle(title));
    if (typeof clean === 'string' && clean) {
      return extractResaleModel(clean); // may still be null if it re-fails guards
    }
    return null;
  }

  async function callGemini(titles) {
    const numbered = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ role: 'user', parts: [{ text: `Titles:\n${numbered}` }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA
      }
    };
    const url = `${GEMINI_ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetchWithTimeout(fetchImpl, url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }, requestTimeoutMs);

        if (res.status === 503 || res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}`);
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('empty response');
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error('response not an array');
        return parsed;
      } catch (err) {
        lastErr = err;
        if (err.name === 'AbortError') await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw lastErr ?? new Error('classification failed');
  }

  async function enrich(titles) {
    const stats = { classified: 0, rejected: 0, errors: 0 };

    // Unique, relevant, not-yet-cached titles, capped to bound cost per run.
    const seen = new Set();
    const pending = [];
    for (const title of titles ?? []) {
      const key = cacheKeyForTitle(title);
      if (!key || seen.has(key) || cache.has(key)) continue;
      if (!isFlipRelevantTitle(title)) continue;
      if (extractResaleModel(title)) continue; // deterministic already handles it
      seen.add(key);
      pending.push(title);
      if (pending.length >= maxTitlesPerRun) break;
    }
    if (pending.length === 0) return stats;

    logger.log?.(`[llm] classifying ${pending.length} new title(s) via ${model}`);

    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      let parsed;
      try {
        parsed = await callGemini(batch);
      } catch (err) {
        // Leave this batch uncached so it retries on a later run.
        stats.errors += batch.length;
        logger.warn?.(`[llm] batch failed (${batch.length} titles): ${err.message}`);
        continue;
      }

      const labelByIndex = new Map();
      for (const row of parsed) {
        const idx = Number(row?.index);
        if (Number.isInteger(idx)) labelByIndex.set(idx, row?.cleanLabel ?? null);
      }
      // 1-based indices from the prompt; any title the model omitted is rejected.
      for (let j = 0; j < batch.length; j++) {
        const label = labelByIndex.get(j + 1);
        const key = cacheKeyForTitle(batch[j]);
        if (typeof label === 'string' && label.trim()) {
          cache.set(key, label.trim());
          stats.classified++;
        } else {
          cache.set(key, null);
          stats.rejected++;
        }
      }
    }

    saveCache();
    logger.log?.(`[llm] done: ${stats.classified} labelled, ${stats.rejected} rejected, ${stats.errors} errored`);
    return stats;
  }

  return { resolveModel, getCleanLabel, enrich, size: () => cache.size };
}
