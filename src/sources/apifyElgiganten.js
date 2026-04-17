import { absoluteUrl, firstFinite, parseSekValue, slugify, stripText } from '../lib/utils.js';

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function isOutletUrl(url) {
  return String(url ?? '').toLowerCase().includes('/product/outlet/');
}

function isGenericCategory(category) {
  const label = stripText(category).toLowerCase();
  return !label || label === 'outlet' || /^kategori \d+$/i.test(label);
}

function normalizeForMatch(text) {
  return stripText(text)
    .replace(/\boutlet\b/gi, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenSet(text) {
  return new Set(
    normalizeForMatch(text)
      .split(' ')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 1)
  );
}

function scoreTitleSimilarity(leftTitle, rightTitle) {
  const left = tokenSet(leftTitle);
  const right = tokenSet(rightTitle);

  if (!left.size || !right.size) {
    return 0;
  }

  let overlap = 0;

  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(left.size, right.size);
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
    .map((entry) => stripText(entry))
    .filter(Boolean);
  const primaryEnvVar = stripText(source.apiTokenEnvVar ?? 'APIFY_TOKEN') || 'APIFY_TOKEN';
  const discoveredPoolEnvVars = Object.keys(process.env)
    .filter((key) => /^APIFY_TOKEN_\d+$/i.test(key))
    .sort((left, right) => {
      const leftIndex = Number.parseInt(left.split('_').at(-1) ?? '', 10);
      const rightIndex = Number.parseInt(right.split('_').at(-1) ?? '', 10);
      return leftIndex - rightIndex;
    });
  const envVars = [...new Set([...explicitEnvVars, primaryEnvVar, ...discoveredPoolEnvVars])];
  const resolvedTokens = envVars
    .map((envVar) => process.env[envVar]?.trim())
    .filter(Boolean);

  if (!resolvedTokens.length) {
    throw new Error(`No Apify token is configured for ${source.label ?? source.id}.`);
  }

  return resolvedTokens;
}

function createTokenPicker(tokens) {
  let nextIndex = 0;

  return () => {
    const token = tokens[nextIndex % tokens.length];
    nextIndex += 1;
    return token;
  };
}

function readNumericValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value === 'string') {
    return parseSekValue(value);
  }

  if (Array.isArray(value)) {
    return firstFinite(...value.map((entry) => readNumericValue(entry)));
  }

  if (value && typeof value === 'object') {
    return firstFinite(
      readNumericValue(value.amount),
      readNumericValue(value.value),
      readNumericValue(value.current),
      readNumericValue(value.price),
      readNumericValue(value.min),
      readNumericValue(value.max)
    );
  }

  return null;
}

function detectAvailability(record) {
  const stockLevel = stripText(record.onlineStockLevel);

  if (stockLevel) {
    return stockLevel;
  }

  if (record.onlineStockInStock === true || record.isAvailableOnline === true || record.inStock === true) {
    return 'in stock';
  }

  if (record.onlineStockInStock === false || record.isAvailableOnline === false || record.inStock === false) {
    return 'out of stock';
  }

  if (Number.isFinite(record.storesWithStockCount) && record.storesWithStockCount > 0) {
    return `${record.storesWithStockCount} stores with stock`;
  }

  return 'unknown';
}

function buildDescription(record) {
  const bulletPoints = asArray(record.bulletPoints).map((entry) => stripText(entry)).filter(Boolean);

  if (bulletPoints.length) {
    return bulletPoints.join(' • ');
  }

  const categoryPath = stripText(record.categoryPath || asArray(record.taxonomyNames).map((entry) => stripText(entry)).filter(Boolean).join(' > '));
  return categoryPath || null;
}

function getCategoryGroupId(record) {
  return stripText(record.categoryGroupId ?? record.apiRecord?.categoryGroupId ?? record.apiRecord?.cgm) || null;
}

function resolveCategoryFromRecord(record) {
  const categoryCandidates = [
    record.leafCategory,
    record.apiRecord?.leafCategory,
    record.apiRecord?.ptLowestLevelNodeValue,
    record.apiRecord?.ptLevel2NodeValue,
    record.apiRecord?.ptLevel1NodeValue,
    asArray(record.taxonomy).at(-1),
    asArray(record.apiRecord?.taxonomy).at(-1)
  ]
    .map((value) => stripText(value))
    .filter(Boolean);

  for (const candidate of categoryCandidates) {
    if (candidate.toLowerCase() !== 'outlet') {
      return candidate;
    }
  }

  return null;
}

function resolveCategory(record, source, categoryByGroupId = {}, referenceMatch = null) {
  const direct = resolveCategoryFromRecord(record);

  if (direct) {
    return direct;
  }

  if (referenceMatch?.category && !isGenericCategory(referenceMatch.category)) {
    return referenceMatch.category;
  }

  const categoryGroupId = getCategoryGroupId(record);
  const mapped = stripText(categoryByGroupId?.[categoryGroupId] ?? '');

  if (mapped && !isGenericCategory(mapped)) {
    return mapped;
  }

  return categoryGroupId ? `Kategori ${categoryGroupId}` : source.category;
}

function extractIdentifiers(record) {
  return {
    articleNumber: stripText(record.apiRecord?.articleNumber ?? record.productId ?? record.sku ?? record.id ?? '') || null,
    altArticleNumber: stripText(record.apiRecord?.altArticleNumber ?? '') || null,
    manufacturerArticleNumber: stripText(record.apiRecord?.manufacturerArticleNumber ?? '') || null,
    gtin: stripText(record.apiRecord?.GTIN ?? record.apiRecord?.gtin ?? '') || null
  };
}

function primaryLookupQuery(record) {
  const identifiers = extractIdentifiers(record);
  const identifierQuery = [
    Number.isFinite(Number.parseInt(identifiers.manufacturerArticleNumber ?? '', 10))
      ? null
      : identifiers.manufacturerArticleNumber,
    Number.isFinite(Number.parseInt(identifiers.altArticleNumber ?? '', 10)) ? null : identifiers.altArticleNumber,
    identifiers.manufacturerArticleNumber,
    identifiers.altArticleNumber,
    identifiers.gtin
  ]
    .map((value) => stripText(value))
    .find(Boolean);

  if (identifierQuery) {
    return identifierQuery;
  }

  return normalizeForMatch(record.title)
    .split(' ')
    .slice(0, 9)
    .join(' ');
}

function resolveReferencePrice(record, currentPriceSek) {
  const discountAmount = firstFinite(readNumericValue(record.discountAmount), readNumericValue(record.apiRecord?.discountAmount));
  const fromDiscountAmount =
    Number.isFinite(discountAmount) && discountAmount > 0 && Number.isFinite(currentPriceSek)
      ? currentPriceSek + discountAmount
      : null;

  return firstFinite(
    readNumericValue(record.priceOriginal),
    readNumericValue(record.originalPrice),
    readNumericValue(record.regularPrice),
    readNumericValue(record.listPrice),
    readNumericValue(record.priceBefore),
    readNumericValue(record.wasPrice),
    readNumericValue(record.beforePrice),
    readNumericValue(record.apiRecord?.beforePrice),
    readNumericValue(record.apiRecord?.priceBefore),
    readNumericValue(record.apiRecord?.regularPrice),
    readNumericValue(record.apiRecord?.recommendedRetailPrice),
    fromDiscountAmount
  );
}

function createEnrichmentState(sourceState = {}) {
  sourceState.enrichment = sourceState.enrichment && typeof sourceState.enrichment === 'object' ? sourceState.enrichment : {};
  sourceState.enrichment.categoryByGroupId =
    sourceState.enrichment.categoryByGroupId && typeof sourceState.enrichment.categoryByGroupId === 'object'
      ? sourceState.enrichment.categoryByGroupId
      : {};
  sourceState.enrichment.referenceByExternalId =
    sourceState.enrichment.referenceByExternalId && typeof sourceState.enrichment.referenceByExternalId === 'object'
      ? sourceState.enrichment.referenceByExternalId
      : {};
  sourceState.enrichment.lookupMissesByExternalId =
    sourceState.enrichment.lookupMissesByExternalId && typeof sourceState.enrichment.lookupMissesByExternalId === 'object'
      ? sourceState.enrichment.lookupMissesByExternalId
      : {};
  sourceState.enrichment.queryCache =
    sourceState.enrichment.queryCache && typeof sourceState.enrichment.queryCache === 'object'
      ? sourceState.enrichment.queryCache
      : {};
  return sourceState.enrichment;
}

function markCategoryMapping(categoryByGroupId, categoryGroupId, categoryLabel) {
  const id = stripText(categoryGroupId ?? '');
  const label = stripText(categoryLabel ?? '');

  if (!id || !label || isGenericCategory(label)) {
    return;
  }

  categoryByGroupId[id] = label;
}

function toMatchPayload(record, fallbackSourceLabel = 'Elgiganten') {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const priceSek = firstFinite(
    readNumericValue(record.priceCurrent),
    readNumericValue(record.currentPrice),
    readNumericValue(record.price),
    readNumericValue(record.activePrice),
    readNumericValue(record.activePriceAmount)
  );

  if (!Number.isFinite(priceSek) || priceSek <= 0) {
    return null;
  }

  const url = absoluteUrl('https://www.elgiganten.se', record.url || record.productPageUrl || '');
  const title = stripText(record.title);
  const category = resolveCategoryFromRecord(record);
  const categoryGroupId = getCategoryGroupId(record);
  const brand = stripText(record.brand ?? record.apiRecord?.brand ?? '');

  return {
    title,
    url,
    priceSek,
    category: category || null,
    categoryGroupId,
    sourceLabel: stripText(record.source ?? fallbackSourceLabel) || fallbackSourceLabel,
    brand: brand || null,
    identifiers: extractIdentifiers(record)
  };
}

function scoreRegularMatch(outletRecord, candidateRecord) {
  const outletIdentifiers = extractIdentifiers(outletRecord);
  const candidateIdentifiers = candidateRecord.identifiers;
  const outletCategoryGroupId = getCategoryGroupId(outletRecord);
  const titleSimilarity = scoreTitleSimilarity(outletRecord.title, candidateRecord.title);
  const outletBrand = stripText(outletRecord.brand ?? outletRecord.apiRecord?.brand ?? '').toLowerCase();
  const candidateBrand = stripText(candidateRecord.brand ?? '').toLowerCase();

  const sameManufacturer =
    outletIdentifiers.manufacturerArticleNumber &&
    candidateIdentifiers.manufacturerArticleNumber &&
    outletIdentifiers.manufacturerArticleNumber === candidateIdentifiers.manufacturerArticleNumber;
  const sameAlt =
    outletIdentifiers.altArticleNumber &&
    candidateIdentifiers.altArticleNumber &&
    outletIdentifiers.altArticleNumber === candidateIdentifiers.altArticleNumber;
  const sameGtin = outletIdentifiers.gtin && candidateIdentifiers.gtin && outletIdentifiers.gtin === candidateIdentifiers.gtin;
  const sameArticle =
    outletIdentifiers.articleNumber &&
    candidateIdentifiers.articleNumber &&
    outletIdentifiers.articleNumber === candidateIdentifiers.articleNumber;

  let score = 0;
  score += sameManufacturer ? 120 : 0;
  score += sameAlt ? 105 : 0;
  score += sameGtin ? 95 : 0;
  score += sameArticle ? 70 : 0;
  score += Math.round(titleSimilarity * 80);
  score += outletCategoryGroupId && outletCategoryGroupId === candidateRecord.categoryGroupId ? 12 : 0;
  score += outletBrand && candidateBrand && outletBrand === candidateBrand ? 8 : 0;

  const exactIdentifierMatch = sameManufacturer || sameAlt || sameGtin || sameArticle;
  const validByTitle =
    titleSimilarity >= 0.72 ||
    (titleSimilarity >= 0.6 && outletCategoryGroupId && outletCategoryGroupId === candidateRecord.categoryGroupId);

  return {
    score,
    exactIdentifierMatch,
    validByTitle
  };
}

function findBestRegularMatch(outletRecord, candidateRecords = []) {
  let best = null;
  let bestScore = -1;
  let bestMeta = null;

  for (const candidate of candidateRecords) {
    if (!candidate || !candidate.url || isOutletUrl(candidate.url)) {
      continue;
    }

    const meta = scoreRegularMatch(outletRecord, candidate);

    if (meta.score > bestScore) {
      best = candidate;
      bestScore = meta.score;
      bestMeta = meta;
    }
  }

  if (!best || !bestMeta) {
    return null;
  }

  const accepted = bestMeta.exactIdentifierMatch || (bestMeta.validByTitle && bestMeta.score >= 72);

  if (!accepted) {
    return null;
  }

  return {
    priceSek: best.priceSek,
    title: best.title,
    url: best.url,
    category: best.category,
    categoryGroupId: best.categoryGroupId,
    sourceLabel: best.sourceLabel
  };
}

function buildNotes(record, source) {
  const campaignNotes = asArray(record.campaigns)
    .map((entry) => {
      if (typeof entry === 'string') {
        return stripText(entry);
      }

      if (entry && typeof entry === 'object') {
        return stripText(entry.name ?? entry.title ?? entry.label);
      }

      return '';
    })
    .filter(Boolean);

  return campaignNotes.length ? campaignNotes.join(' • ') : source.notes ?? null;
}

function isProductRecord(record) {
  if (!record || typeof record !== 'object') {
    return false;
  }

  if (record.resultType && record.resultType !== 'product') {
    return false;
  }

  return Boolean(stripText(record.title) && stripText(record.url || record.productPageUrl));
}

function buildActorInput(source) {
  if (source.actorInput && Object.keys(source.actorInput).length) {
    return { ...source.actorInput };
  }

  return {
    startUrl: 'https://www.elgiganten.se/search?q=outlet&view=products',
    results_wanted: source.maxItems ?? 30,
    max_pages: 3
  };
}

function sanitizeActorInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const sanitized = {};

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length ? sanitized : null;
}

function buildActorInputs(source) {
  const inputs = [];
  const seenKeys = new Set();

  const addInput = (candidateInput) => {
    const sanitized = sanitizeActorInput(candidateInput);

    if (!sanitized) {
      return;
    }

    const serialized = JSON.stringify(sanitized);

    if (seenKeys.has(serialized)) {
      return;
    }

    seenKeys.add(serialized);
    inputs.push(sanitized);
  };

  addInput(buildActorInput(source));

  for (const variant of asArray(source.actorInputVariants)) {
    addInput(variant);
  }

  const keywordQueries = asArray(source.actorKeywordQueries)
    .map((entry) => stripText(entry))
    .filter(Boolean);
  const keywordInputDefaults = {
    results_wanted: source.actorKeywordResultsWanted ?? source.actorInput?.results_wanted ?? 500,
    max_pages: source.actorKeywordMaxPages ?? source.actorInput?.max_pages ?? 30,
    includeRawRecord: source.actorInput?.includeRawRecord ?? true
  };

  for (const keyword of keywordQueries) {
    addInput({
      ...keywordInputDefaults,
      keyword
    });
  }

  return inputs;
}

function buildLookupInput(source, query) {
  return {
    keyword: query,
    results_wanted: source.referenceLookupResultsWanted ?? 80,
    max_pages: source.referenceLookupMaxPages ?? 2,
    includeRawRecord: true
  };
}

function matchesPathRules(url, includePaths = [], excludePaths = []) {
  const normalizedUrl = String(url ?? '').toLowerCase();

  if (!normalizedUrl) {
    return false;
  }

  const matchesInclude =
    !includePaths.length ||
    includePaths.some((pathFragment) => normalizedUrl.includes(String(pathFragment).toLowerCase()));
  const matchesExclude = excludePaths.some((pathFragment) => normalizedUrl.includes(String(pathFragment).toLowerCase()));

  return matchesInclude && !matchesExclude;
}

function toObservation(record, source, now, categoryByGroupId = {}, referenceMatch = null, cachedReference = null) {
  const title = stripText(record.title);
  const url = absoluteUrl('https://www.elgiganten.se', record.url || record.productPageUrl || '');
  const priceSek = firstFinite(
    readNumericValue(record.priceCurrent),
    readNumericValue(record.currentPrice),
    readNumericValue(record.price),
    readNumericValue(record.activePrice),
    readNumericValue(record.activePriceAmount)
  );

  if (!title || !url || priceSek == null) {
    return null;
  }

  const matchedReference = referenceMatch ?? cachedReference;
  const referencePriceSek = firstFinite(matchedReference?.priceSek, resolveReferencePrice(record, priceSek));
  const imageUrls = asArray(record.imageUrls).map((entry) => stripText(entry)).filter(Boolean);
  const externalId = stripText(record.productId ?? record.sku ?? record.id ?? '');
  const categoryGroupId = getCategoryGroupId(record);
  const identifiers = extractIdentifiers(record);
  const referenceMatchType =
    matchedReference?.priceSek != null ? 'catalog-match' : referencePriceSek != null ? 'listing-reference' : null;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    externalId: externalId || slugify(url),
    productKey: source.productKey ?? slugify(title),
    title,
    url,
    category: resolveCategory(record, source, categoryByGroupId, matchedReference),
    categoryGroupId,
    condition: source.condition,
    priceSek,
    marketValueSek: referencePriceSek ?? source.marketValueSek,
    referencePriceSek: referencePriceSek ?? source.referencePriceSek,
    referenceUrl: matchedReference?.url ?? null,
    referenceTitle: matchedReference?.title ?? null,
    referenceSourceLabel: matchedReference?.sourceLabel ?? null,
    referenceMatchType,
    articleNumber: identifiers.articleNumber,
    altArticleNumber: identifiers.altArticleNumber,
    manufacturerArticleNumber: identifiers.manufacturerArticleNumber,
    gtin: identifiers.gtin,
    resaleEstimateSek: source.resaleEstimateSek,
    shippingEstimateSek: source.shippingEstimateSek,
    feesEstimateSek: source.feesEstimateSek,
    availability: detectAvailability(record),
    description: buildDescription(record),
    imageUrl: stripText(record.imageUrl ?? record.primaryImageUrl ?? imageUrls[0] ?? '') || null,
    notes: buildNotes(record, source),
    seenAt: now
  };
}

function buildActorRecordKey(record) {
  const resultType = stripText(record?.resultType ?? 'product') || 'product';
  const externalId = stripText(
    record?.productId ?? record?.sku ?? record?.id ?? record?.apiRecord?.articleNumber ?? record?.apiRecord?.objectID
  );

  if (externalId) {
    return `${resultType}:${externalId}`;
  }

  const rawUrl = stripText(record?.url || record?.productPageUrl || '');
  const url = rawUrl ? absoluteUrl('https://www.elgiganten.se', rawUrl) : null;

  if (url) {
    return `${resultType}:${url}`;
  }

  const title = stripText(record?.title ?? '');

  return title ? `${resultType}:title:${slugify(title)}` : null;
}

async function runActorInput({ fetcher, source, actorId, token, actorInput }) {
  const response = await fetcher.fetchJsonApi(
    `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?clean=1&format=json`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(actorInput),
      timeoutMs: source.actorTimeoutMs,
      skipHostDelay: true
    }
  );

  return Array.isArray(response) ? response : [];
}

async function runLookup({ source, fetcher, actorId, token, query }) {
  return runActorInput({
    fetcher,
    source,
    actorId,
    token,
    actorInput: buildLookupInput(source, query)
  });
}

function shouldRetryMissedLookup(previousMissIso, retryHours) {
  if (!previousMissIso) {
    return true;
  }

  const previous = Date.parse(previousMissIso);

  if (Number.isNaN(previous)) {
    return true;
  }

  return Date.now() - previous >= retryHours * 60 * 60 * 1000;
}

function pickLookupQueue(outletRecords, categoryByGroupId, referenceByExternalId, lookupMissesByExternalId, source) {
  const pendingByCategory = new Map();
  const missingReferences = [];
  const retryHours = source.referenceLookupRetryHours ?? 24;

  for (const record of outletRecords) {
    const externalId = stripText(record.productId ?? record.sku ?? record.id ?? '');

    if (!externalId || referenceByExternalId[externalId]) {
      continue;
    }

    if (!shouldRetryMissedLookup(lookupMissesByExternalId[externalId], retryHours)) {
      continue;
    }

    if (!primaryLookupQuery(record)) {
      continue;
    }

    const categoryGroupId = getCategoryGroupId(record);
    const directCategory = resolveCategoryFromRecord(record);
    const categoryKnown =
      (directCategory && !isGenericCategory(directCategory)) ||
      (categoryGroupId && categoryByGroupId[categoryGroupId] && !isGenericCategory(categoryByGroupId[categoryGroupId]));

    const currentPrice = firstFinite(
      readNumericValue(record.priceCurrent),
      readNumericValue(record.currentPrice),
      readNumericValue(record.price),
      readNumericValue(record.activePrice)
    );

    const candidate = {
      record,
      externalId,
      categoryGroupId,
      categoryKnown,
      currentPrice
    };

    if (!categoryKnown && categoryGroupId && !pendingByCategory.has(categoryGroupId)) {
      pendingByCategory.set(categoryGroupId, candidate);
    }

    missingReferences.push(candidate);
  }

  const queue = [];
  const seen = new Set();

  for (const candidate of pendingByCategory.values()) {
    queue.push(candidate);
    seen.add(candidate.externalId);
  }

  missingReferences
    .sort((left, right) => (right.currentPrice ?? 0) - (left.currentPrice ?? 0))
    .forEach((candidate) => {
      if (!seen.has(candidate.externalId)) {
        queue.push(candidate);
        seen.add(candidate.externalId);
      }
    });

  return queue.slice(0, source.referenceLookupMaxPerScan ?? 300);
}

function buildRegularCandidates(records = []) {
  return records
    .filter(isProductRecord)
    .filter((record) => !isOutletUrl(record.url || record.productPageUrl))
    .map((record) => toMatchPayload(record))
    .filter(Boolean);
}

export async function collectFromApifyElgiganten({ source, fetcher, sourceState, now }) {
  const actorId = normalizeActorId(source.actorId ?? 'lexis-solutions/elgiganten-scraper');

  if (!actorId) {
    throw new Error(`actorId is not configured for ${source.label ?? source.id}.`);
  }

  const tokenPicker = createTokenPicker(getApiTokens(source));
  const enrichment = createEnrichmentState(sourceState ?? {});
  const categoryByGroupId = enrichment.categoryByGroupId;
  const referenceByExternalId = enrichment.referenceByExternalId;
  const lookupMissesByExternalId = enrichment.lookupMissesByExternalId;
  const queryCache = enrichment.queryCache;
  const actorInputs = buildActorInputs(source);
  const actorRecords = [];
  const seenRecordKeys = new Set();

  for (const actorInput of actorInputs) {
    const response = await runActorInput({
      fetcher,
      source,
      actorId,
      token: tokenPicker(),
      actorInput
    });

    if (!Array.isArray(response)) {
      throw new Error(`Expected an array of dataset items from Apify actor ${actorId}.`);
    }

    for (const record of response) {
      const recordKey = buildActorRecordKey(record);

      if (recordKey && seenRecordKeys.has(recordKey)) {
        continue;
      }

      if (recordKey) {
        seenRecordKeys.add(recordKey);
      }

      actorRecords.push(record);
    }
  }

  const productRecords = actorRecords.filter(isProductRecord);
  const regularCandidates = buildRegularCandidates(productRecords);

  for (const cachedReference of Object.values(referenceByExternalId)) {
    markCategoryMapping(categoryByGroupId, cachedReference?.categoryGroupId, cachedReference?.category);
  }

  for (const candidate of regularCandidates) {
    markCategoryMapping(categoryByGroupId, candidate.categoryGroupId, candidate.category);
  }

  const outletRecords = productRecords.filter((record) =>
    matchesPathRules(record.url || record.productPageUrl, source.includePaths ?? [], source.excludePaths ?? [])
  );
  const directReferenceMatches = new Map();

  for (const record of outletRecords) {
    const localMatch = findBestRegularMatch(record, regularCandidates);

    if (!localMatch) {
      continue;
    }

    const externalId = stripText(record.productId ?? record.sku ?? record.id ?? '');
    if (externalId) {
      directReferenceMatches.set(externalId, localMatch);
      referenceByExternalId[externalId] = {
        ...localMatch,
        matchedAt: now
      };
      delete lookupMissesByExternalId[externalId];
    }

    markCategoryMapping(categoryByGroupId, getCategoryGroupId(record), localMatch.category);
  }

  if (source.referenceLookup !== false && (source.referenceLookupMaxPerScan ?? 300) > 0) {
    const lookupQueue = pickLookupQueue(
      outletRecords,
      categoryByGroupId,
      referenceByExternalId,
      lookupMissesByExternalId,
      source
    );
    let nextIndex = 0;
    const lookupConcurrency = Math.max(1, source.referenceLookupConcurrency ?? 6);

    const worker = async () => {
      while (nextIndex < lookupQueue.length) {
        const index = nextIndex;
        nextIndex += 1;
        const { record, externalId } = lookupQueue[index];
        const lookupQuery = primaryLookupQuery(record);
        const cacheKey = lookupQuery ? lookupQuery.toLowerCase() : '';
        let lookupMatch = null;
        let hasFreshCache = false;

        if (cacheKey && queryCache[cacheKey]) {
          const cached = queryCache[cacheKey];
          const retryHours = source.referenceLookupRetryHours ?? 24;
          const validUntil = Date.parse(cached.checkedAt ?? '') + retryHours * 60 * 60 * 1000;

          if (!Number.isNaN(validUntil) && Date.now() <= validUntil) {
            lookupMatch = cached.match ?? null;
            hasFreshCache = true;
          }
        }

        if (!hasFreshCache && cacheKey) {
          const lookupRecords = await runLookup({
            source,
            fetcher,
            actorId,
            token: tokenPicker(),
            query: lookupQuery
          });
          const lookupCandidates = buildRegularCandidates(lookupRecords);
          lookupMatch = findBestRegularMatch(record, lookupCandidates);
          queryCache[cacheKey] = {
            checkedAt: now,
            match: lookupMatch
          };
        }

        if (lookupMatch) {
          referenceByExternalId[externalId] = {
            ...lookupMatch,
            matchedAt: now
          };
          directReferenceMatches.set(externalId, lookupMatch);
          delete lookupMissesByExternalId[externalId];
          markCategoryMapping(categoryByGroupId, getCategoryGroupId(record), lookupMatch.category);
          markCategoryMapping(categoryByGroupId, lookupMatch.categoryGroupId, lookupMatch.category);
        } else {
          lookupMissesByExternalId[externalId] = now;
        }
      }
    };

    await Promise.all(Array.from({ length: lookupConcurrency }, worker));
  }

  const observations = outletRecords
    .map((record) => {
      const externalId = stripText(record.productId ?? record.sku ?? record.id ?? '');
      const directReferenceMatch = externalId ? directReferenceMatches.get(externalId) : null;
      const cachedReference = externalId ? referenceByExternalId[externalId] : null;
      return toObservation(record, source, now, categoryByGroupId, directReferenceMatch, cachedReference);
    })
    .filter(Boolean);

  const staleQueries = Object.entries(queryCache)
    .sort((left, right) => Date.parse(right[1]?.checkedAt ?? '') - Date.parse(left[1]?.checkedAt ?? ''))
    .slice(2000);

  for (const [cacheKey] of staleQueries) {
    delete queryCache[cacheKey];
  }

  return source.maxItems ? observations.slice(0, Number(source.maxItems)) : observations;
}
