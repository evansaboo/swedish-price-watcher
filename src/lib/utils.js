const sekFormatter = new Intl.NumberFormat('sv-SE', {
  style: 'currency',
  currency: 'SEK',
  maximumFractionDigits: 0
});

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function stripText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(value) {
  return stripText(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

export function parseSekValue(input) {
  if (input == null) {
    return null;
  }

  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.round(input);
  }

  const text = stripText(input);
  const match = text.match(/-?\d[\d\s.,:-]*/);

  if (!match) {
    return null;
  }

  let numeric = match[0]
    .replace(/:-/g, '')
    .replace(/[^\d,.-]/g, '');

  if (!numeric) {
    return null;
  }

  const hasComma = numeric.includes(',');
  const hasDot = numeric.includes('.');
  const lastCommaIndex = numeric.lastIndexOf(',');
  const lastDotIndex = numeric.lastIndexOf('.');

  if (hasComma && hasDot) {
    if (lastCommaIndex > lastDotIndex) {
      numeric = numeric.replace(/\./g, '').replace(',', '.');
    } else {
      numeric = numeric.replace(/,/g, '');
    }
  } else if (hasComma) {
    numeric = /,\d{2}$/.test(numeric) ? numeric.replace(/\./g, '').replace(',', '.') : numeric.replace(/,/g, '');
  } else if (hasDot) {
    numeric = /\.\d{2}$/.test(numeric) ? numeric.replace(/,/g, '') : numeric.replace(/\./g, '');
  }

  const parsed = Number.parseFloat(numeric);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

export function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function median(values) {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);

  if (!numbers.length) {
    return null;
  }

  const middleIndex = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 0
    ? Math.round((numbers[middleIndex - 1] + numbers[middleIndex]) / 2)
    : numbers[middleIndex];
}

export function absoluteUrl(baseUrl, maybeRelativeUrl) {
  try {
    return new URL(maybeRelativeUrl, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

export function formatSek(value) {
  return value == null || !Number.isFinite(value) ? 'n/a' : sekFormatter.format(Math.round(value));
}

export function buildListingKey(sourceId, externalId) {
  return `${sourceId}:${externalId}`;
}

export function firstFinite(...values) {
  return values.find((value) => Number.isFinite(value)) ?? null;
}

export function normalizeProductIdentity(value) {
  return slugify(value)
    .replace(/(^|-)b-grade(?=-|$)/g, '$1')
    .replace(/(^|-)(demo|outlet|used|begagnad|refurbished|open-box)(?=-|$)/g, '$1')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

export function getUrlPathSegments(urlString) {
  try {
    return new URL(urlString).pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return [];
  }
}

export function parseIsoDate(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

// Returns effective enabled state — runtime store override takes precedence over config file
export function isSourceEnabled(source, storeState) {
  const overrides = storeState?.preferences?.sourceOverrides ?? {};
  if (Object.prototype.hasOwnProperty.call(overrides, source.id)) {
    return Boolean(overrides[source.id]);
  }
  return source.enabled;
}
