/**
 * Inet category ("template") resolution for products from the agent API.
 *
 * Watch groups filter on Inet's template id (Grafikkort = 17, Moderkort = 117
 * and so on). The HTML pages carried it; the agent API does not. But a
 * template is Inet's specification template, so a product's specification
 * fields identify it: on 2026-11-10, 20 of 20 sampled products were nearest to
 * a product of their own template (Jaccard 0.70–1.0 on "group/field" names,
 * desktops and laptops kept apart), while different templates scored ≤ 0.54.
 *
 * So: products already tracked keep their template; for a new one we look up
 * its details once and pick the template whose learned signatures it matches
 * best. Signatures are learned from tracked products of known template.
 * Results are cached in the watcher state, so each product costs one lookup.
 */

export const MIN_TEMPLATE_SIMILARITY = 0.6;
const SIGNATURES_PER_TEMPLATE = 3;
const SAMPLES_TRIED_PER_TEMPLATE = 4;
const MAX_CACHE_ENTRIES = 5000;
/** Lookup ids per check: 30 requests at most, and far fewer once learned. */
export const MAX_LOOKUP_IDS_PER_CHECK = 300;

const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** Sorted "group/field" names of a product's specifications. */
export function specSignature(detail) {
  const names = new Set();
  for (const group of Array.isArray(detail?.specifications) ? detail.specifications : []) {
    for (const spec of Array.isArray(group?.specifications) ? group.specifications : []) {
      if (group?.name && spec?.name) names.add(`${group.name}/${spec.name}`);
    }
  }
  return [...names].sort();
}

export function signatureSimilarity(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const name of left) if (right.has(name)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** The best-matching template id, or null if none is similar enough. */
export function classifyTemplate(signature, signatures, { minSimilarity = MIN_TEMPLATE_SIMILARITY } = {}) {
  if (!signature?.length) return null;
  let best = null;
  for (const [templateId, samples] of Object.entries(plainObject(signatures))) {
    for (const sample of Array.isArray(samples) ? samples : []) {
      const score = signatureSimilarity(signature, sample);
      if (!best || score > best.score) best = { templateId, score };
    }
  }
  return best && best.score >= minSimilarity ? best.templateId : null;
}

/** id → template id for everything tracked; outlet items also vouch for their parent. */
function knownTemplates(state) {
  const known = new Map();
  for (const record of Object.values(plainObject(state.products))) {
    const templateId = record?.templateId == null ? null : String(record.templateId);
    if (!templateId) continue;
    if (record.id && !known.has(String(record.id))) known.set(String(record.id), templateId);
    if (record.bargainParentId && !known.has(String(record.bargainParentId))) known.set(String(record.bargainParentId), templateId);
  }
  return known;
}

/** Ids of tracked products to learn signatures from, for templates without one yet. */
function learningSamples(state, known) {
  const byTemplate = new Map();
  for (const record of Object.values(plainObject(state.products))) {
    if (!record || record.missingSince || record.templateId == null) continue;
    const templateId = String(record.templateId);
    // The full product (parent) has the complete specification list.
    const id = String(record.bargainParentId || record.id);
    if (!byTemplate.has(templateId)) byTemplate.set(templateId, new Set());
    byTemplate.get(templateId).add(id);
  }
  const samples = [];
  for (const [templateId, ids] of byTemplate) {
    if (plainObject(state.templateSignatures)[templateId]?.length) continue;
    const tried = new Set(plainObject(state.templateSamplesTried)[templateId] ?? []);
    const fresh = [...ids].filter((id) => !tried.has(id) && known.get(id) === templateId);
    for (const id of fresh.slice(0, Math.max(0, Math.min(2, SAMPLES_TRIED_PER_TEMPLATE - tried.size)))) {
      samples.push({ id, templateId });
    }
  }
  return samples;
}

function rememberSignature(state, templateId, signature) {
  if (!signature.length) return;
  const list = Array.isArray(state.templateSignatures[templateId]) ? state.templateSignatures[templateId] : [];
  const key = signature.join('|');
  if (!list.some((s) => s.join('|') === key)) list.push(signature);
  state.templateSignatures[templateId] = list.slice(-SIGNATURES_PER_TEMPLATE);
}

function pruneCache(state) {
  const entries = Object.entries(state.templateCache);
  if (entries.length <= MAX_CACHE_ENTRIES) return;
  entries
    .sort((a, b) => Date.parse(a[1]?.at ?? 0) - Date.parse(b[1]?.at ?? 0))
    .slice(0, entries.length - MAX_CACHE_ENTRIES)
    .forEach(([id]) => delete state.templateCache[id]);
}

const emptyLookup = () => ({ products: new Map(), notFound: new Set(), failed: new Set() });

/** A failed lookup leaves its products for the next check instead of failing it. */
async function safeLookup(lookup, ids, logger) {
  try {
    const result = await lookup(ids);
    return {
      products: result?.products instanceof Map ? result.products : new Map(),
      notFound: result?.notFound instanceof Set ? result.notFound : new Set(),
      failed: result?.failed instanceof Set ? result.failed : new Set(),
    };
  } catch (error) {
    logger.warn?.(`[inet] Product lookup failed: ${error.message}`);
    return { ...emptyLookup(), failed: new Set(ids) };
  }
}

/**
 * Fill in `templateId` on the agent pages' products, looking up details for
 * products of unknown template. Products that could not be resolved this
 * check (lookup failed or over budget) are dropped from the page, so the next
 * check treats them as new instead of silently recording them uncategorised.
 *
 * Mutates `pages` and `state` (`templateCache`, `templateSignatures`,
 * `templateSamplesTried`).
 */
export async function resolveInetTemplates({
  state,
  pages,
  lookup,
  nowIso,
  maxLookupIds = MAX_LOOKUP_IDS_PER_CHECK,
  logger = console,
}) {
  state.templateCache = plainObject(state.templateCache);
  state.templateSignatures = plainObject(state.templateSignatures);
  state.templateSamplesTried = plainObject(state.templateSamplesTried);
  const known = knownTemplates(state);
  const cached = (id) => (id && Object.hasOwn(state.templateCache, id) ? state.templateCache[id] : undefined);

  const unresolved = [];
  for (const page of pages) {
    if (!page?.found || !Array.isArray(page.products)) continue;
    for (const product of page.products) {
      const candidates = [product.id, product.bargainParentId].filter(Boolean).map(String);
      const fromState = candidates.map((id) => known.get(id)).find(Boolean);
      const fromCache = candidates.map(cached).find((entry) => entry !== undefined);
      if (fromState) product.templateId = fromState;
      else if (fromCache) product.templateId = fromCache.templateId ?? null;
      else unresolved.push({ product, page, key: String(product.bargainParentId || product.id) });
    }
  }
  const stats = { unresolved: unresolved.length, learned: 0, classified: 0, unmatched: 0, deferred: 0, lookups: 0 };
  if (!unresolved.length) return stats;

  const samples = learningSamples(state, known);
  const sampleIds = samples.map((s) => s.id);
  const keys = [...new Set(unresolved.map((u) => u.key))];
  const budget = Math.max(0, maxLookupIds - sampleIds.length);
  const lookupKeys = keys.slice(0, budget);
  const first = await safeLookup(lookup, [...sampleIds, ...lookupKeys], logger);
  stats.lookups += sampleIds.length + lookupKeys.length;

  for (const { id, templateId } of samples) {
    state.templateSamplesTried[templateId] = [...new Set([...(state.templateSamplesTried[templateId] ?? []), id])];
    const detail = first.products.get(id);
    if (detail) {
      rememberSignature(state, templateId, specSignature(detail));
      stats.learned += 1;
    }
  }

  // An outlet item whose parent is gone: try the item's own (shorter) specs.
  const retry = unresolved
    .filter((u) => u.key !== u.product.id && first.notFound.has(u.key))
    .map((u) => u.product.id);
  const second = retry.length ? await safeLookup(lookup, retry, logger) : emptyLookup();
  stats.lookups += retry.length;

  for (const { product, page, key } of unresolved) {
    const detail = first.products.get(key) ?? second.products.get(product.id);
    const answered = detail || (first.notFound.has(key) && (key === product.id || second.notFound.has(product.id)));
    if (!answered) {
      page.products = page.products.filter((p) => p !== product);
      if (Array.isArray(page.productIds)) page.productIds = page.productIds.filter((id) => id !== product.id);
      stats.deferred += 1;
      continue;
    }
    const templateId = detail ? classifyTemplate(specSignature(detail), state.templateSignatures) : null;
    product.templateId = templateId;
    state.templateCache[key] = { templateId, at: nowIso };
    if (key !== product.id) state.templateCache[product.id] = { templateId, at: nowIso };
    if (templateId) stats.classified += 1;
    else stats.unmatched += 1;
  }

  pruneCache(state);
  if (stats.deferred) logger.warn?.(`[inet] ${stats.deferred} new product(s) left for the next check (category lookup incomplete).`);
  return stats;
}
