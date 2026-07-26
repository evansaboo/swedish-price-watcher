function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function buildAffiliateUrl(destinationUrl, source) {
  const destination = safeHttpUrl(destinationUrl);
  if (!destination) return { buyUrl: destinationUrl ?? null, affiliate: false };

  const template = String(source?.affiliateProgram?.linkTemplate ?? '').trim();
  if (!template || !template.includes('{url}')) {
    return { buyUrl: destination, affiliate: false };
  }

  const candidate = template
    .replaceAll('{url}', encodeURIComponent(destination))
    .replaceAll('{rawUrl}', destination);
  const buyUrl = safeHttpUrl(candidate);
  if (!buyUrl) return { buyUrl: destination, affiliate: false };

  return {
    buyUrl,
    affiliate: true,
    affiliateNetwork: source.affiliateProgram?.network ?? null
  };
}

export function decorateAffiliateLink(item, sourceById) {
  const source = sourceById instanceof Map ? sourceById.get(item?.sourceId) : null;
  return { ...item, ...buildAffiliateUrl(item?.url, source) };
}

export function decorateAffiliatePayload(payload, sourceById) {
  if (Array.isArray(payload)) {
    return payload.map((item) => decorateAffiliateLink(item, sourceById));
  }
  if (payload && Array.isArray(payload.items)) {
    return {
      ...payload,
      items: payload.items.map((item) => decorateAffiliateLink(item, sourceById))
    };
  }
  return payload;
}
