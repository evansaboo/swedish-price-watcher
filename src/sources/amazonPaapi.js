/**
 * Amazon Product Advertising API (PA-API v5) client for Amazon Sweden (amazon.se).
 * Uses native node:crypto for AWS Signature Version 4 signing (zero external dependencies).
 */

import crypto from 'node:crypto';

const DEFAULT_HOST = 'webservices.amazon.se';
const DEFAULT_REGION = 'eu-west-1';
const SERVICE = 'ProductAdvertisingAPI';
const TARGET = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems';

/**
 * Computes AWS SigV4 HMAC-SHA256 hash.
 */
function hmacSha256(key, string) {
  return crypto.createHmac('sha256', key).update(string, 'utf8').digest();
}

/**
 * Computes SHA256 hex digest.
 */
function sha256Hex(string) {
  return crypto.createHash('sha256').update(string, 'utf8').digest('hex');
}

/**
 * Derives AWS SigV4 signing key.
 */
function getSigningKey(secretKey, dateStamp, region, service) {
  const kSecret = 'AWS4' + secretKey;
  const kDate = hmacSha256(kSecret, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

/**
 * Generates AWS Signature Version 4 headers for PA-API v5.
 */
export function buildPaapiHeaders({
  accessKey,
  secretKey,
  host = DEFAULT_HOST,
  region = DEFAULT_REGION,
  payload = '{}',
  now = new Date(),
}) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = '/paapi5/searchitems';
  const canonicalQuery = '';
  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:application/json; charset=utf-8\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:${TARGET}\n`;
  const signedHeaders = 'content-encoding;content-type;host;x-amz-date;x-amz-target';
  const payloadHash = sha256Hex(payload);

  const canonicalRequest =
    `POST\n` +
    `${canonicalUri}\n` +
    `${canonicalQuery}\n` +
    `${canonicalHeaders}\n` +
    `${signedHeaders}\n` +
    `${payloadHash}`;

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign =
    `${algorithm}\n` +
    `${amzDate}\n` +
    `${credentialScope}\n` +
    `${sha256Hex(canonicalRequest)}`;

  const signingKey = getSigningKey(secretKey, dateStamp, region, SERVICE);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const authorizationHeader =
    `${algorithm} Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'host': host,
    'content-type': 'application/json; charset=utf-8',
    'content-encoding': 'amz-1.0',
    'x-amz-target': TARGET,
    'x-amz-date': amzDate,
    'Authorization': authorizationHeader,
  };
}

/**
 * Normalizes PA-API v5 item into standard observation shape.
 */
export function normalizePaapiItem(item, { source, group, now = new Date().toISOString() } = {}) {
  if (!item || !item.ASIN) return null;

  const asin = item.ASIN;
  const title = item.ItemInfo?.Title?.DisplayValue?.trim() || '';
  const brand = item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue?.trim() || null;
  const productGroup = item.ItemInfo?.Classifications?.ProductGroup?.DisplayValue?.trim() || 'Electronics';
  const url = item.DetailPageURL || `https://www.amazon.se/dp/${asin}`;
  const imageUrl = item.Images?.Primary?.Large?.URL || item.Images?.Primary?.Medium?.URL || null;

  const offer = item.Offers?.Listings?.[0];
  const priceSek = offer?.Price?.Amount != null ? Math.round(offer.Price.Amount) : null;
  const referencePriceSek =
    offer?.SavingBasis?.Amount != null
      ? Math.round(offer.SavingBasis.Amount)
      : (offer?.Price?.Savings?.Amount != null && priceSek != null
          ? Math.round(priceSek + offer.Price.Savings.Amount)
          : null);

  if (priceSek == null || priceSek <= 0) return null;

  const discountPct =
    referencePriceSek && referencePriceSek > priceSek
      ? Math.round(((referencePriceSek - priceSek) / referencePriceSek) * 100)
      : (offer?.Price?.Savings?.Percentage != null ? Math.round(offer.Price.Savings.Percentage) : 0);

  return {
    id: `${source?.id || 'amazon-hotlist'}:${asin}`,
    sourceId: source?.id || 'amazon-hotlist',
    sourceLabel: source?.label || 'Amazon.se Hotlist',
    externalId: asin,
    sku: asin,
    title,
    brand,
    category: group?.label || productGroup,
    priceSek,
    referencePriceSek: referencePriceSek || null,
    discountPct,
    condition: 'deal',
    url,
    imageUrl,
    inStock: true,
    observedAt: now,
    hotlistGroup: group?.label || null,
  };
}

/**
 * Searches Amazon.se via PA-API v5 SearchItems.
 */
export async function searchPaapi({
  keywords,
  brand,
  minDiscountPct = 10,
  minPriceSek = null,
  maxPriceSek = null,
  accessKey,
  secretKey,
  partnerTag = 'zpeedx-21',
  marketplace = 'www.amazon.se',
  host = DEFAULT_HOST,
  region = DEFAULT_REGION,
  fetcher = null,
}) {
  if (!accessKey || !secretKey || !partnerTag) {
    throw new Error('PA-API credentials (accessKey, secretKey, partnerTag) are required');
  }

  const payloadObj = {
    Keywords: keywords,
    PartnerTag: partnerTag,
    PartnerType: 'Associates',
    Marketplace: marketplace,
    ItemCount: 10,
    Resources: [
      'ItemInfo.Title',
      'ItemInfo.ByLineInfo',
      'ItemInfo.Classifications',
      'Offers.Listings.Price',
      'Offers.Listings.SavingBasis',
      'Images.Primary.Medium',
      'Images.Primary.Large',
      'DetailPageURL',
    ],
  };

  if (brand) payloadObj.Brand = brand;
  if (minDiscountPct > 0) payloadObj.MinSavingPercent = minDiscountPct;
  if (minPriceSek != null && minPriceSek > 0) payloadObj.MinPrice = Math.round(minPriceSek * 100);
  if (maxPriceSek != null && maxPriceSek > 0) payloadObj.MaxPrice = Math.round(maxPriceSek * 100);

  const payload = JSON.stringify(payloadObj);
  const headers = buildPaapiHeaders({
    accessKey,
    secretKey,
    host,
    region,
    payload,
  });

  const url = `https://${host}/paapi5/searchitems`;
  let data;
  if (fetcher?.fetchJsonApi) {
    data = await fetcher.fetchJsonApi(url, {
      method: 'POST',
      headers,
      body: payload,
      skipHostDelay: true,
    });
  } else {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: payload,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`PA-API error ${res.status}: ${errText}`);
    }
    data = await res.json();
  }

  const items = data?.SearchResult?.Items || [];
  return items;
}
