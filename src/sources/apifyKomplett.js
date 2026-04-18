/**
 * Apify source handler for shahidirfan/komplett-products-scraper.
 *
 * The actor output uses different field names from the Elgiganten actor:
 *   name            → title
 *   price_number    → priceSek
 *   material_number → articleNumber  (Komplett internal ID)
 *   manufacturer_part_number → manufacturerArticleNumber
 *   image_url       → imageUrl
 *   availability_status + availability_text → availability
 *
 * Reference price lookup runs the same actor with `keyword` to find
 * the standard-condition listing and extract its price.
 */

import { absoluteUrl, firstFinite, slugify, stripText } from '../lib/utils.js';

// ── Utility ─────────────────────────────────────────────────────────────────

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function normalizeActorId(actorId) {
  return String(actorId ?? '')
    .trim()
    .replace(/^https?:\/\/apify\.com\//i, '')
    .replace(/^acts\//i, '')
    .replace(/\//g, '~');
}

function getApiTokens(source) {
  const explicitEnvVars = asArray(source.apiTokenEnvVars)
    .map((v) => stripText(v))
    .filter(Boolean);
  const primaryEnvVar = stripText(source.apiTokenEnvVar ?? 'APIFY_TOKEN') || 'APIFY_TOKEN';
  const poolEnvVars = Object.keys(process.env)
    .filter((k) => /^APIFY_TOKEN_\d+$/i.test(k))
    .sort((a, b) => Number.parseInt(a.split('_').at(-1), 10) - Number.parseInt(b.split('_').at(-1), 10));
  const all = [...new Set([...explicitEnvVars, primaryEnvVar, ...poolEnvVars])];
  const tokens = all.map((k) => process.env[k]?.trim()).filter(Boolean);

  if (!tokens.length) {
    throw new Error(`No Apify token configured for ${source.label ?? source.id}.`);
  }

  return tokens;
}

function createTokenPicker(tokens) {
  let i = 0;
  return () => tokens[(i++) % tokens.length];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function isRetriableError(error) {
  const msg = String(error?.message ?? '');
  return /\b(429|5\d\d)\b/.test(msg) || /timed out after/i.test(msg) ||
    /\b(ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|socket hang up)\b/i.test(msg);
}

function retryDelayMs(source, attempt) {
  const base = Math.max(1, source.actorRetryBaseMs ?? 1200);
  const max = Math.max(base, source.actorRetryMaxMs ?? 12000);
  return Math.min(max, base * 2 ** attempt + Math.round(base * 0.2 * Math.random()));
}

// ── Actor call ───────────────────────────────────────────────────────────────

async function runActor({ fetcher, source, actorId, tokenPicker, input }) {
  const retries = Math.max(0, source.actorRequestRetries ?? 3);
  const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?clean=1&format=json`;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetcher.fetchJsonApi(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenPicker()}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        timeoutMs: source.actorTimeoutMs,
        skipHostDelay: true
      });
      return Array.isArray(res) ? res : [];
    } catch (err) {
      lastErr = err;
      if (!isRetriableError(err) || attempt >= retries) throw err;
      await sleep(retryDelayMs(source, attempt));
    }
  }

  throw lastErr ?? new Error('Apify actor request failed.');
}

// ── Record parsing ───────────────────────────────────────────────────────────

const BASE = 'https://www.komplett.se';

function resolveUrl(raw) {
  return absoluteUrl(BASE, stripText(raw ?? ''));
}

function isOutletUrl(url) {
  return String(url ?? '').toLowerCase().includes('/demovaror/');
}

function extractPrice(record) {
  const num = record.price_number;
  if (typeof num === 'number' && Number.isFinite(num) && num > 0) return Math.round(num);
  // Fallback: parse the display price string "6 383:-"
  const str = String(record.price ?? '').replace(/\s/g, '').replace(':-', '').replace(',', '.');
  const parsed = parseFloat(str);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function extractAvailability(record) {
  const text = stripText(record.availability_text ?? record.availability_status ?? '');
  if (text) return text;
  if (record.availability_status === 'Stocked') return 'i lager';
  if (record.availability_status === 'OutOfStock') return 'out of stock';
  return 'unknown';
}

function extractCategory(record, source) {
  // Infer from URL path segment: /product/NNNN/<category>/<sub>/name
  const url = resolveUrl(record.url);
  if (url) {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    // Skip 'product', numeric ID, and 'demovaror'/'demo-*'
    const meaningful = parts.filter((p) => p !== 'product' && !/^\d+$/.test(p) && p !== 'demovaror' && !p.startsWith('demo-'));
    if (meaningful.length) {
      return meaningful[0].replace(/-/g, ' ');
    }
  }
  return source.category ?? 'electronics';
}

function normalizeForMatch(text) {
  return stripText(text)
    .replace(/\b(b-grade|bgrade|demovaror?|outlet)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenSet(text) {
  return new Set(normalizeForMatch(text).split(' ').filter((t) => t.length > 1));
}

function titleSimilarity(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let hits = 0;
  for (const t of left) if (right.has(t)) hits++;
  return hits / Math.max(left.size, right.size);
}

// ── Reference matching ───────────────────────────────────────────────────────

function buildLookupQuery(record) {
  const mpn = stripText(record.manufacturer_part_number ?? '');
  if (mpn && !/^\d+$/.test(mpn)) return mpn;
  return normalizeForMatch(record.name ?? '').split(' ').slice(0, 9).join(' ');
}

function findBestRegularMatch(outletRecord, candidates) {
  const mpn = stripText(outletRecord.manufacturer_part_number ?? '');
  let best = null;
  let bestScore = -1;

  for (const c of candidates) {
    const url = resolveUrl(c.url);
    if (!url || isOutletUrl(url)) continue;

    const candMpn = stripText(c.manufacturer_part_number ?? '');
    const exactMpn = mpn && candMpn && mpn === candMpn;
    const sim = titleSimilarity(outletRecord.name ?? '', c.name ?? '');
    const score = (exactMpn ? 150 : 0) + Math.round(sim * 80);

    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }

  if (!best) return null;

  const mpnBest = stripText(best.manufacturer_part_number ?? '');
  const exactMpn = mpn && mpnBest && mpn === mpnBest;
  const sim = titleSimilarity(outletRecord.name ?? '', best.name ?? '');
  if (!exactMpn && sim < 0.65) return null;

  return best;
}

// ── Enrichment state ─────────────────────────────────────────────────────────

function createEnrichmentState(sourceState) {
  sourceState.enrichment ??= {};
  sourceState.enrichment.referenceByArticle ??= {};
  sourceState.enrichment.missesByArticle ??= {};
  sourceState.enrichment.queryCache ??= {};
  return sourceState.enrichment;
}

// ── Observation builder ──────────────────────────────────────────────────────

function toObservation(record, source, now, referenceMatch = null, cachedReference = null) {
  const title = stripText(record.name ?? '');
  const url = resolveUrl(record.url);
  const priceSek = extractPrice(record);

  if (!title || !url || priceSek == null) return null;

  const matched = referenceMatch ?? cachedReference;
  const referencePriceSek = matched ? extractPrice(matched) : null;
  const articleNumber = stripText(record.material_number ?? '');
  const referenceMatchType = referencePriceSek != null ? 'catalog-match' : null;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId: articleNumber || slugify(url),
    productKey: source.productKey ?? slugify(title),
    title,
    url,
    category: extractCategory(record, source),
    condition: source.condition,
    priceSek,
    marketValueSek: referencePriceSek ?? source.marketValueSek ?? null,
    referencePriceSek: referencePriceSek ?? source.referencePriceSek ?? null,
    referenceUrl: matched ? resolveUrl(matched.url) : null,
    referenceTitle: matched ? stripText(matched.name ?? '') : null,
    referenceSourceLabel: matched ? (source.label ?? source.id) : null,
    referenceMatchType,
    articleNumber: articleNumber || null,
    manufacturerArticleNumber: stripText(record.manufacturer_part_number ?? '') || null,
    resaleEstimateSek: source.resaleEstimateSek,
    shippingEstimateSek: source.shippingEstimateSek,
    feesEstimateSek: source.feesEstimateSek,
    availability: extractAvailability(record),
    imageUrl: stripText(record.image_url ?? '') || null,
    seenAt: now
  };
}

// ── Main collector ───────────────────────────────────────────────────────────

function buildDiscoveryInputs(source) {
  const inputs = [];
  const seen = new Set();

  const add = (input) => {
    const key = JSON.stringify(input);
    if (!seen.has(key)) { seen.add(key); inputs.push(input); }
  };

  if (source.actorInput && Object.keys(source.actorInput).length) {
    add({ ...source.actorInput });
  } else {
    add({
      startUrl: 'https://www.komplett.se/search?q=b-grade&list_view=list',
      results_wanted: source.maxItems ?? 50,
      max_pages: 5
    });
  }

  for (const variant of asArray(source.actorInputVariants)) {
    add({ ...variant });
  }

  for (const kw of asArray(source.actorKeywordQueries).map((k) => stripText(k)).filter(Boolean)) {
    add({
      keyword: kw,
      results_wanted: source.actorKeywordResultsWanted ?? 100,
      max_pages: source.actorKeywordMaxPages ?? 3
    });
  }

  return inputs;
}

export async function collectFromApifyKomplett({ source, fetcher, sourceState, now }) {
  const actorId = normalizeActorId(source.actorId ?? 'shahidirfan/komplett-products-scraper');

  if (!actorId) {
    throw new Error(`actorId not configured for ${source.label ?? source.id}.`);
  }

  const tokenPicker = createTokenPicker(getApiTokens(source));
  const enrichment = createEnrichmentState(sourceState ?? {});
  const { referenceByArticle, missesByArticle, queryCache } = enrichment;
  const includePaths = asArray(source.includePaths);
  const excludePaths = asArray(source.excludePaths);

  // ── 1. Discovery runs ───────────────────────────────────────────────────────
  const allRecords = [];
  const seenKeys = new Set();

  for (const input of buildDiscoveryInputs(source)) {
    const records = await runActor({ fetcher, source, actorId, tokenPicker, input });

    for (const rec of records) {
      const key = stripText(rec.material_number ?? '') || resolveUrl(rec.url);
      if (key && seenKeys.has(key)) continue;
      if (key) seenKeys.add(key);
      allRecords.push(rec);
    }
  }

  // ── 2. Filter outlet records ────────────────────────────────────────────────
  const outletRecords = allRecords.filter((rec) => {
    const url = resolveUrl(rec.url);
    if (!url) return false;
    const pathname = new URL(url).pathname.toLowerCase();
    const hasInclude = !includePaths.length || includePaths.some((p) => pathname.includes(p.toLowerCase()));
    const hasExclude = excludePaths.some((p) => pathname.includes(p.toLowerCase()));
    return hasInclude && !hasExclude;
  });

  // ── 3. Reference lookup ─────────────────────────────────────────────────────
  const directMatches = new Map();

  if (source.referenceLookup !== false) {
    const retryHours = source.referenceLookupRetryHours ?? 24;
    const maxPerScan = source.referenceLookupMaxPerScan ?? 80;

    const queue = outletRecords
      .filter((rec) => {
        const art = stripText(rec.material_number ?? '');
        if (referenceByArticle[art]) return false;
        const missAt = missesByArticle[art];
        if (missAt && Date.now() - Date.parse(missAt) < retryHours * 3_600_000) return false;
        return Boolean(buildLookupQuery(rec));
      })
      .sort((a, b) => (extractPrice(b) ?? 0) - (extractPrice(a) ?? 0))
      .slice(0, maxPerScan);

    const concurrency = Math.max(1, source.referenceLookupConcurrency ?? 4);
    let idx = 0;

    const worker = async () => {
      while (idx < queue.length) {
        const rec = queue[idx++];
        const art = stripText(rec.material_number ?? '');
        const query = buildLookupQuery(rec);
        const cacheKey = query.toLowerCase();

        let match = null;

        if (queryCache[cacheKey]) {
          const cached = queryCache[cacheKey];
          const ttl = (retryHours * 3_600_000);
          if (Date.now() - Date.parse(cached.checkedAt ?? '') <= ttl) {
            match = cached.match ?? null;
          }
        }

        if (match === null && cacheKey) {
          const lookupRecords = await runActor({
            fetcher, source, actorId, tokenPicker,
            input: {
              keyword: query,
              results_wanted: source.referenceLookupResultsWanted ?? 30,
              max_pages: source.referenceLookupMaxPages ?? 2
            }
          });
          match = findBestRegularMatch(rec, lookupRecords.filter((r) => !isOutletUrl(r.url)));
          queryCache[cacheKey] = { checkedAt: now, match };
        }

        if (match) {
          directMatches.set(art, match);
          referenceByArticle[art] = { ...match, matchedAt: now };
          delete missesByArticle[art];
        } else if (art) {
          missesByArticle[art] = now;
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  // ── 4. Prune stale query cache ──────────────────────────────────────────────
  const stale = Object.entries(queryCache)
    .sort((a, b) => Date.parse(b[1]?.checkedAt ?? '') - Date.parse(a[1]?.checkedAt ?? ''))
    .slice(1000);
  for (const [k] of stale) delete queryCache[k];

  // ── 5. Build observations ───────────────────────────────────────────────────
  const observations = outletRecords
    .map((rec) => {
      const art = stripText(rec.material_number ?? '');
      return toObservation(
        rec, source, now,
        art ? directMatches.get(art) : null,
        art ? referenceByArticle[art] : null
      );
    })
    .filter(Boolean);

  return source.maxItems ? observations.slice(0, Number(source.maxItems)) : observations;
}
