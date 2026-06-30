// ═══════════════════════════════════════════════════════════════
// llmClassifier — LLM fallback for resale-model extraction
// ───────────────────────────────────────────────────────────────
// Supports two interchangeable providers, selected by `provider`:
//   • 'gemini' — hosted Google Generative Language API (needs GEMINI_API_KEY;
//                free tier is rate-limited to ~20 req/min, hence the pacing).
//   • 'ollama' — a LOCAL model served by Ollama (e.g. on the Raspberry Pi).
//                No API key, no cost, no rate limit. Slower per request, but the
//                on-disk cache means each unique title is classified only once.
//
// The deterministic `extractResaleModel` matcher (resaleEngine.js) is the fast,
// free, authoritative path. It is conservative: noisy Blocket titles it cannot
// parse return null. This module recovers those by asking the LLM to CLEAN a
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
import { extractResaleModel, looksLikeAccessoryOrRepair, looksLikeSystemOrBuild } from './resaleEngine.js';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Categories where the platform name (PlayStation/Xbox/Switch) is SHARED by games
// and peripherals, so the deterministic matcher's positives are low-precision: a
// bare-named game ("PS5 Dragons Dogma 2") looks exactly like the console. For these,
// even a deterministic MATCH is re-verified by the LLM before it is trusted. Every
// other category (Apple/GPU/CPU) is high-precision and bypasses the LLM entirely.
const LOW_PRECISION_CATEGORIES = new Set(['Game consoles', 'Handhelds']);

// Bump whenever the prompt / classification semantics change so stale on-disk
// classifications from an older prompt are discarded and re-classified. (v2 made
// the prompt game/peripheral-aware; v3 added few-shot examples so small LOCAL
// models reliably null named game titles like "Mario Kart" instead of echoing them.)
const CACHE_VERSION = 3;

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
  'a VIDEO GAME or game disc/cartridge (software, not the console), ' +
  'a console PERIPHERAL (controller/handkontroll/gamepad/DualSense/Joy-Con/headset/racing wheel/charging dock/face-plate/memory card), ' +
  'broken / for-parts, or anything outside the listed categories. ' +
  'CRITICAL: a named VIDEO GAME is software even when it names a console — if the title is a game TITLE/FRANCHISE ' +
  '(e.g. Mario Kart, Zelda, Pokémon, Super Mario, FIFA / EA Sports FC, Call of Duty, Hogwarts Legacy, Elden Ring, ' +
  'God of War, Spider-Man, Minecraft, Grand Theft Auto/GTA, Dragons Dogma, Funko Fusion), return null — NEVER echo it as the console. ' +
  'A real console listing names the HARDWARE itself (e.g. "PlayStation 5 Slim", "Xbox Series X konsol", "Nintendo Switch OLED spelkonsol"); a game or accessory merely mentions the platform. ' +
  'Worked examples (input -> output): ' +
  '"Mario Kart 8 Deluxe Nintendo Switch" -> null; ' +
  '"EA Sports FC 25 spel till PlayStation 5" -> null; ' +
  '"Sony DualSense handkontroll till PS5" -> null; ' +
  '"Nintendo Switch OLED Joy-Con par" -> null; ' +
  '"PlayStation 5 Slim Digital Edition konsol" -> "PlayStation 5 Digital"; ' +
  '"Säljer min GeForce RTX 3070 Ti grafikkort fint skick" -> "RTX 3070 Ti"; ' +
  '"Nybyggd gamingdator RTX 4070 Ti Ryzen 7 7800X3D" -> null; ' +
  '"iPhone 13 Pro 128GB grafit med laddare" -> "iPhone 13 Pro 128GB". ' +
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

// Ollama structured-outputs schema. Ollama follows standard JSON Schema, so a
// nullable field is expressed as a union type (not OpenAPI's `nullable`), and we
// REQUIRE cleanLabel so small local models always emit it (null when rejected).
const OLLAMA_FORMAT = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      index: { type: 'integer' },
      cleanLabel: { type: ['string', 'null'] }
    },
    required: ['index', 'cleanLabel']
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
    provider = 'gemini',
    apiKey = '',
    enabled = true,
    model = 'gemini-2.5-flash-lite',
    ollamaUrl = 'http://127.0.0.1:11434',
    ollamaModel = 'qwen2.5:3b',
    cacheFile = null,
    batchSize = 25,
    maxTitlesPerRun = 400,
    requestTimeoutMs = 30000,
    maxRetries = 4,
    minRequestIntervalMs = 4500, // pace requests to ~13/min, under free-tier RPM
    rateLimitBackoffMs = 8000,   // 429 backoff base (per-minute window)
    serverErrorBackoffMs = 1500, // 5xx/503 backoff base
    fetchImpl = globalThis.fetch,
    logger = console
  } = opts;

  const isOllama = provider === 'ollama';

  if (!enabled || typeof fetchImpl !== 'function') return null;
  // Gemini needs an API key; Ollama runs locally and needs none.
  if (!isOllama && !apiKey) return null;

  // Local models are slower per request but unmetered. Smaller batches keep their
  // structured output reliable; a longer timeout absorbs CPU-only inference latency.
  const effectiveBatchSize = isOllama ? Math.min(batchSize, 8) : batchSize;
  const effectiveTimeoutMs = isOllama ? Math.max(requestTimeoutMs, 180000) : requestTimeoutMs;
  const activeModel = isOllama ? ollamaModel : model;

  // normTitle -> string (clean label) | null (rejected). Absent = not yet seen.
  const cache = new Map();
  let nextRequestAt = 0; // simple client-side rate limiter (ms epoch)
  let enrichInFlight = null; // coalesces concurrent enrich() calls

  async function paceRequests() {
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    nextRequestAt = Date.now() + minRequestIntervalMs;
  }

  function loadCache() {
    if (!cacheFile) return;
    try {
      if (!fs.existsSync(cacheFile)) return;
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const entries = raw?.entries ?? {};
      if (raw?.version !== CACHE_VERSION) {
        // Targeted migration instead of a full wipe (a wipe re-classifies every
        // title at once and triggers a rate-limit storm). Only entries whose
        // cached label re-keys INTO a low-precision console/handheld category are
        // dropped — those are the ones an older prompt could have mislabelled
        // (e.g. a game cleaned to "Nintendo Switch"). Null verdicts and
        // high-precision labels (Apple/GPU/CPU) are kept as-is.
        let kept = 0, dropped = 0;
        for (const [k, v] of Object.entries(entries)) {
          if (v === null) { cache.set(k, null); kept++; continue; }
          const reKeyed = extractResaleModel(String(v));
          if (reKeyed && LOW_PRECISION_CATEGORIES.has(reKeyed.demandCategory)) { dropped++; continue; }
          cache.set(k, String(v)); kept++;
        }
        logger.log?.(`[llm] migrated cache v${raw?.version}->v${CACHE_VERSION}: kept ${kept}, dropped ${dropped} low-precision for re-classification`);
        saveCache();
        return;
      }
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
      fs.writeFileSync(cacheFile, JSON.stringify({ version: CACHE_VERSION, entries }, null, 0));
    } catch (err) {
      logger.warn?.(`[llm] cache save failed: ${err.message}`);
    }
  }

  loadCache();

  function getCleanLabel(title) {
    return cache.get(cacheKeyForTitle(title));
  }

  // Deterministic-first resolver with LLM gap-fill + low-precision gate. Always
  // re-keys through the deterministic matcher so resaleKeys stay consistent.
  function resolveModel(title) {
    const direct = extractResaleModel(title);
    if (direct) {
      // High-precision categories (Apple/GPU/CPU): trust the matcher directly.
      if (!LOW_PRECISION_CATEGORIES.has(direct.demandCategory)) return direct;
      // Low-precision (consoles/handhelds): re-verify against the LLM verdict.
      const key = cacheKeyForTitle(title);
      if (cache.has(key)) {
        const clean = cache.get(key);
        if (clean === null) return null;                 // LLM: game/peripheral → drop
        if (typeof clean === 'string' && clean) {
          return extractResaleModel(clean) ?? direct;    // re-key cleaned label
        }
      }
      return direct; // not yet classified → keep optimistically (cleaned next run)
    }
    const clean = cache.get(cacheKeyForTitle(title));
    if (typeof clean === 'string' && clean) {
      // Veto: never let the LLM "recover" a structural accessory/repair title by
      // cleaning the accessory word away (e.g. "Swivel Case för iPad" → "iPad").
      if (looksLikeAccessoryOrRepair(title)) return null;
      // Veto: never let the LLM "recover" a complete system/laptop/build into a
      // bare component (e.g. "Gamingdator RTX 5070 Ryzen 7" → "RTX 5070"). Small
      // local models routinely do this, which would pollute the bare-card comp
      // index with whole-build prices. The deterministic build guard is authoritative.
      if (looksLikeSystemOrBuild(title)) return null;
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
        await paceRequests();
        const res = await fetchWithTimeout(fetchImpl, url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }, requestTimeoutMs);

        if (res.status === 503 || res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}`);
          // Respect the server's RetryInfo when present (free-tier 429s report a
          // concrete retry delay); otherwise grow the backoff per attempt.
          let serverRetryMs = 0;
          if (res.status === 429) {
            try {
              const errBody = await res.json();
              const retry = errBody?.error?.details
                ?.find(d => String(d?.['@type']).includes('RetryInfo'))?.retryDelay;
              if (retry) serverRetryMs = (parseFloat(retry) || 0) * 1000;
            } catch { /* body not JSON — fall back to fixed backoff */ }
          }
          const base = (res.status === 429 ? rateLimitBackoffMs : serverErrorBackoffMs) * (attempt + 1);
          const backoff = Math.max(base, serverRetryMs);
          nextRequestAt = Date.now() + backoff;
          await new Promise(r => setTimeout(r, backoff));
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
        if (err.name === 'AbortError') await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    throw lastErr ?? new Error('classification failed');
  }

  // Local Ollama provider (OpenAI-free, no rate limit). Uses structured outputs
  // (`format` schema) so even a small model returns valid JSON. Serialized by the
  // Ollama server itself, so no client-side pacing is needed.
  async function callOllama(titles) {
    const numbered = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const body = {
      model: ollamaModel,
      stream: false,
      format: OLLAMA_FORMAT,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: SYSTEM_INSTRUCTION },
        { role: 'user', content: `Titles:\n${numbered}\n\nReturn a JSON array with one object {"index","cleanLabel"} per title, in order.` }
      ]
    };
    const url = `${ollamaUrl.replace(/\/+$/, '')}/api/chat`;

    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetchWithTimeout(fetchImpl, url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }, effectiveTimeoutMs);

        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status}`);
          await new Promise(r => setTimeout(r, serverErrorBackoffMs * (attempt + 1)));
          continue;
        }
        const data = await res.json();
        const text = data?.message?.content;
        if (!text) throw new Error('empty response');
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error('response not an array');
        return parsed;
      } catch (err) {
        lastErr = err;
        if (err.name === 'AbortError') await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastErr ?? new Error('classification failed');
  }

  const callModel = isOllama ? callOllama : callGemini;

  async function enrich(titles) {
    // Coalesce concurrent runs: overlapping enrich loops (boot + post-scan) would
    // each pace independently and blow the provider's per-minute request cap.
    if (enrichInFlight) return enrichInFlight;
    enrichInFlight = runEnrich(titles).finally(() => { enrichInFlight = null; });
    return enrichInFlight;
  }

  async function runEnrich(titles) {
    const stats = { classified: 0, rejected: 0, errors: 0 };

    // Unique, relevant, not-yet-cached titles, capped to bound cost per run.
    const seen = new Set();
    const pending = [];
    for (const title of titles ?? []) {
      const key = cacheKeyForTitle(title);
      if (!key || seen.has(key) || cache.has(key)) continue;
      if (!isFlipRelevantTitle(title)) continue;
      // Never classify structural accessories/repairs — they are unambiguous and
      // must not be recoverable as the device, so there is nothing for the LLM to do.
      if (looksLikeAccessoryOrRepair(title)) continue;
      // Never classify complete systems/laptops/builds — unambiguously not a bare
      // component; sending them to a small model only risks hallucinated card labels.
      if (looksLikeSystemOrBuild(title)) continue;
      // Skip titles the deterministic matcher already resolves to a HIGH-precision
      // category; low-precision console/handheld positives still need LLM review.
      const direct = extractResaleModel(title);
      if (direct && !LOW_PRECISION_CATEGORIES.has(direct.demandCategory)) continue;
      seen.add(key);
      pending.push(title);
      if (pending.length >= maxTitlesPerRun) break;
    }
    if (pending.length === 0) return stats;

    logger.log?.(`[llm] classifying ${pending.length} new title(s) via ${activeModel}`);

    for (let i = 0; i < pending.length; i += effectiveBatchSize) {
      const batch = pending.slice(i, i + effectiveBatchSize);
      let parsed;
      try {
        parsed = await callModel(batch);
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
      // Persist after every batch so slow LOCAL runs (minutes per batch) survive a
      // restart without losing all progress and re-classifying from scratch.
      saveCache();
    }

    logger.log?.(`[llm] done: ${stats.classified} labelled, ${stats.rejected} rejected, ${stats.errors} errored`);
    return stats;
  }

  return { resolveModel, getCleanLabel, enrich, size: () => cache.size, provider: isOllama ? 'ollama' : 'gemini', model: activeModel };
}
