import { XMLParser } from 'fast-xml-parser';

import { absoluteUrl, parseSekValue, slugify, stripText } from '../lib/utils.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_'
});

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function readField(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object') {
    return value['#text'] ?? value['@_href'] ?? '';
  }

  return '';
}

function getItems(feed) {
  if (feed?.rss?.channel?.item) {
    return asArray(feed.rss.channel.item);
  }

  if (feed?.feed?.entry) {
    return asArray(feed.feed.entry);
  }

  return [];
}

export async function collectFromRss({ source, fetcher, sourceState, now }) {
  const result = await fetcher.fetchText(source, sourceState, source.url, {
    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, text/html;q=0.6'
  });

  if (result.notModified) {
    return [];
  }

  const feed = parser.parse(result.body);
  const items = getItems(feed);

  return items
    .map((item) => {
      const title = stripText(readField(item.title));
      const description = stripText(readField(item.description) || readField(item.summary) || readField(item.content));
      const link = readField(item.link) || readField(item.guid) || source.url;
      const priceSek = parseSekValue(`${title} ${description}`);

      if (!title || priceSek == null) {
        return null;
      }

      return {
        sourceId: source.id,
        sourceLabel: source.label ?? source.id,
        sourceType: source.type,
        externalId: slugify(readField(item.guid) || link || title),
        productKey: source.productKey ?? slugify(title),
        title,
        url: absoluteUrl(source.url, link),
        category: source.category,
        condition: source.condition,
        priceSek,
        marketValueSek: source.marketValueSek,
        referencePriceSek: source.referencePriceSek,
        resaleEstimateSek: source.resaleEstimateSek,
        shippingEstimateSek: source.shippingEstimateSek,
        feesEstimateSek: source.feesEstimateSek,
        availability: 'unknown',
        notes: source.notes ?? null,
        seenAt: now
      };
    })
    .filter(Boolean);
}
