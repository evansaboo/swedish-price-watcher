import { load } from 'cheerio';

import { absoluteUrl, parseSekValue, slugify, stripText } from '../lib/utils.js';

function getSelectionValue(scope, selector, attribute) {
  const node = selector ? scope.find(selector).first() : scope.first();

  if (!node.length) {
    return '';
  }

  const value = attribute ? node.attr(attribute) : node.text();
  return stripText(value);
}

function buildBaseObservation(source, now) {
  return {
    sourceId: source.id,
    sourceLabel: source.label ?? source.id,
    sourceType: source.type,
    category: source.category,
    condition: source.condition,
    marketValueSek: source.marketValueSek,
    referencePriceSek: source.referencePriceSek,
    resaleEstimateSek: source.resaleEstimateSek,
    shippingEstimateSek: source.shippingEstimateSek,
    feesEstimateSek: source.feesEstimateSek,
    notes: source.notes ?? null,
    seenAt: now
  };
}

function collectSinglePage($, source, now) {
  const root = $.root();
  const title = getSelectionValue(root, source.selectors.title, source.attributes.title);
  const priceText = getSelectionValue(root, source.selectors.price, source.attributes.price);
  const availability = getSelectionValue(root, source.selectors.availability, source.attributes.availability) || 'unknown';
  const priceSek = parseSekValue(priceText);

  if (!title || priceSek == null) {
    return [];
  }

  return [
    {
      ...buildBaseObservation(source, now),
      externalId: slugify(source.externalId ?? source.productKey ?? source.url),
      productKey: source.productKey ?? slugify(title),
      title,
      url: source.url,
      availability,
      priceSek
    }
  ];
}

function collectListPage($, source, now) {
  const items = [];

  $(source.selectors.item).each((index, element) => {
    const scope = $(element);
    const title = getSelectionValue(scope, source.selectors.title, source.attributes.title);
    const priceText = getSelectionValue(scope, source.selectors.price, source.attributes.price);
    const link = getSelectionValue(scope, source.selectors.link, source.attributes.link ?? 'href');
    const availability = getSelectionValue(scope, source.selectors.availability, source.attributes.availability) || 'unknown';
    const explicitExternalId = getSelectionValue(scope, source.selectors.externalId, source.attributes.externalId);
    const priceSek = parseSekValue(priceText);

    if (!title || priceSek == null) {
      return;
    }

    items.push({
      ...buildBaseObservation(source, now),
      externalId: slugify(explicitExternalId || link || `${title}-${index}`),
      productKey: source.productKey ?? slugify(title),
      title,
      url: absoluteUrl(source.url, link || source.url),
      availability,
      priceSek
    });
  });

  return source.limit ? items.slice(0, Number(source.limit)) : items;
}

export async function collectFromHtml({ source, fetcher, sourceState, now }) {
  const result = await fetcher.fetchText(source, sourceState, source.url, {
    accept: 'text/html,application/xhtml+xml'
  });

  if (result.notModified) {
    return [];
  }

  const $ = load(result.body);
  return source.type === 'html-page' ? collectSinglePage($, source, now) : collectListPage($, source, now);
}
