import http2 from 'node:http2';
import { slugify } from '../lib/utils.js';

export const SKUS_URL = 'https://r2.jlplen.io/skus.json';
export const NVIDIA_STORE_API_HOST = 'https://api.store.nvidia.com';
export const NVIDIA_STORE_API_BASE = 'https://api.store.nvidia.com/partner/v1/feinventory?skus=';

export const GPU_DISPLAY_ORDER = ['5090', '5080', '5070', '4090', '4080S', '4070S'];

export const DEFAULT_SKUS = {
  '5090': 'NVGFT590',
  '5080': 'NVGFT580',
  '5070': 'NVGFT570',
  '4090': 'NVGFT490',
  '4080S': 'NVGFT480S',
  '4070S': 'NVGFT470S'
};

export const SKU_PATTERNS = {
  '5090': {
    'sv-se': 'PROFESHOP5090',
    'de-de': 'PROFESHOP5090',
    'de-at': 'PROFESHOP5090',
    'da-dk': 'PROFESHOP5090',
    'nb-no': 'PROFESHOP5090',
    'fi-fi': 'PROFESHOP5090',
    'nl-nl': 'PROFESHOP5090',
    'en-gb': 'SCANNVGFFE5090',
    'fr-fr': 'LCFEGF50LD90',
    'es-es': 'LCFEGF50LD90',
    'it-it': 'LCFEGF50LD90',
    'pl-pl': 'XKNVFT590OM',
    'en-us': 'NVGFT590'
  },
  '5080': {
    'sv-se': 'PRO5080FESHOP',
    'de-de': 'PRO5080FESHOP',
    'de-at': 'PRO5080FESHOP',
    'da-dk': 'PRO5080FESHOP',
    'nb-no': 'PRO5080FESHOP',
    'fi-fi': 'PRO5080FESHOP',
    'nl-nl': 'PRO5080FESHOP',
    'en-gb': '5080SCANNVGFFE',
    'fr-fr': '50LD80LCFEGF',
    'es-es': '50LD80LCFEGF',
    'it-it': '50LD80LCFEGF',
    'pl-pl': 'XKNVFT580OM',
    'en-us': 'NVGFT580'
  },
  '5070': {
    'sv-se': 'PRONVGFT570SHOP',
    'de-de': 'PRONVGFT570SHOP',
    'de-at': 'NVGFT570',
    'da-dk': 'PRONVGFT570SHOP',
    'nb-no': 'PRONVGFT570SHOP',
    'fi-fi': 'PRONVGFT570SHOP',
    'nl-nl': 'PRONVGFT570SHOP',
    'en-gb': 'SCNVGFT570AN',
    'fr-fr': 'NVGFT570',
    'es-es': 'NVGFT570',
    'it-it': 'NVGFT570',
    'pl-pl': 'NVGFT570',
    'en-us': 'NVGFT570'
  },
  '4090': {
    'en-us': '5750917900',
    default: 'NVGFT490'
  },
  '4080S': {
    'en-us': '5845716300',
    default: 'NVGFT480S'
  },
  '4070S': {
    'en-us': '5845716400',
    default: 'NVGFT470S'
  }
};

export const CARD_METADATA = {
  '5090': {
    name: 'NVIDIA GeForce RTX 5090 Founders Edition',
    shortName: 'RTX 5090 FE',
    msrpSek: 25990,
    imageUrl: '/images/gpu/5090.svg',
    defaultUrl: 'https://marketplace.nvidia.com/sv-se/consumer/graphics-cards/nvidia-geforce-rtx-5090/'
  },
  '5080': {
    name: 'NVIDIA GeForce RTX 5080 Founders Edition',
    shortName: 'RTX 5080 FE',
    msrpSek: 13990,
    imageUrl: '/images/gpu/5080.svg',
    defaultUrl: 'https://marketplace.nvidia.com/sv-se/consumer/graphics-cards/nvidia-geforce-rtx-5080/'
  },
  '5070': {
    name: 'NVIDIA GeForce RTX 5070 Founders Edition',
    shortName: 'RTX 5070 FE',
    msrpSek: 7990,
    imageUrl: '/images/gpu/5070.svg',
    defaultUrl: 'https://marketplace.nvidia.com/sv-se/consumer/graphics-cards/nvidia-geforce-rtx-5070/'
  },
  '4090': {
    name: 'NVIDIA GeForce RTX 4090 Founders Edition',
    shortName: 'RTX 4090 FE',
    msrpSek: 21990,
    imageUrl: '/images/gpu/4090.svg',
    defaultUrl: 'https://marketplace.nvidia.com/sv-se/consumer/graphics-cards/nvidia-geforce-rtx-4090/'
  },
  '4080S': {
    name: 'NVIDIA GeForce RTX 4080 SUPER Founders Edition',
    shortName: 'RTX 4080 SUPER FE',
    msrpSek: 12490,
    imageUrl: '/images/gpu/4080s.svg',
    defaultUrl: 'https://marketplace.nvidia.com/sv-se/consumer/graphics-cards/nvidia-geforce-rtx-4080-super/'
  },
  '4070S': {
    name: 'NVIDIA GeForce RTX 4070 SUPER Founders Edition',
    shortName: 'RTX 4070 SUPER FE',
    msrpSek: 7490,
    imageUrl: '/images/gpu/4070s.svg',
    defaultUrl: 'https://marketplace.nvidia.com/sv-se/consumer/graphics-cards/nvidia-geforce-rtx-4070-super/'
  }
};

let skuCache = {
  data: null,
  fetchedAt: 0
};
const SKU_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Fetches current dynamic SKU mappings published by Notify-FE on Cloudflare R2.
 */
export async function fetchDynamicSkus(skuUrl = SKUS_URL) {
  const now = Date.now();
  if (skuCache.data && now - skuCache.fetchedAt < SKU_CACHE_TTL_MS) {
    return skuCache.data;
  }

  try {
    const res = await fetch(`${skuUrl}?nocache=${now}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const json = await res.json();
      skuCache = { data: json, fetchedAt: now };
      return json;
    }
  } catch (err) {
    // If fetching fails, fall back to null (patterns will be used)
  }

  return skuCache.data;
}

/**
 * Resolves the SKU for a specific GPU card model and locale.
 */
export function resolveCardSku(cardKey, locale = 'sv-se', dynamicSkus = null) {
  const normLocale = String(locale).toLowerCase();
  
  if (dynamicSkus?.[normLocale]?.[cardKey]?.sku) {
    return dynamicSkus[normLocale][cardKey].sku;
  }

  const pattern = SKU_PATTERNS[cardKey];
  if (pattern) {
    if (pattern[normLocale]) return pattern[normLocale];
    if (pattern.default) return pattern.default;
  }

  return DEFAULT_SKUS[cardKey] || `NVGFT${cardKey}`;
}

/**
 * Queries the NVIDIA Store API for inventory status using HTTP/2.
 * Akamai requires HTTP/2 with browser headers and handles bot-manager cookies.
 */
export async function queryNvidiaFeInventory(skus, locale = 'sv-se', { timeoutMs = 12000 } = {}) {
  const normLocale = String(locale).toLowerCase();
  const skuList = Array.isArray(skus) ? skus : [skus];

  return new Promise((resolve) => {
    let client;
    try {
      client = http2.connect(NVIDIA_STORE_API_HOST);
    } catch (err) {
      return resolve({ ok: false, error: err.message, results: {} });
    }

    let cookieJar = new Map();
    const results = {};
    let isDone = false;

    const timer = setTimeout(() => {
      if (!isDone) {
        isDone = true;
        try { client.destroy(); } catch {}
        resolve({ ok: false, error: 'timeout', results });
      }
    }, timeoutMs);

    function requestPath(path) {
      return new Promise((resReq) => {
        if (isDone) return resReq(null);

        const headers = {
          ':path': path,
          ':method': 'GET',
          ':authority': 'api.store.nvidia.com',
          ':scheme': 'https',
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'cross-site',
          'origin': 'https://notify-fe.plen.io',
          'referer': 'https://notify-fe.plen.io/'
        };

        if (cookieJar.size > 0) {
          headers['cookie'] = Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
        }

        let stream;
        try {
          stream = client.request(headers);
        } catch (streamErr) {
          return resReq({ error: streamErr.message });
        }

        stream.on('response', (resHeaders) => {
          const sc = resHeaders['set-cookie'];
          if (sc) {
            const arr = Array.isArray(sc) ? sc : [sc];
            for (const c of arr) {
              const [nameVal] = c.split(';');
              const [k, ...v] = nameVal.split('=');
              if (k) cookieJar.set(k.trim(), v.join('=').trim());
            }
          }
        });

        let data = '';
        stream.on('data', (chunk) => { data += chunk; });
        stream.on('end', () => {
          try {
            resReq(JSON.parse(data));
          } catch {
            resReq({ error: 'parse_failed', raw: data.slice(0, 100) });
          }
        });
        stream.on('error', (err) => resReq({ error: err.message }));
        stream.end();
      });
    }

    async function execute() {
      try {
        // Initial warmup request to seed Akamai cookies (bm_sz, bm_s)
        await requestPath(`/partner/v1/feinventory?skus=NVGFT590&locale=${normLocale}`);
        await new Promise((r) => setTimeout(r, 100));

        for (const sku of skuList) {
          if (isDone) break;
          const resp = await requestPath(`/partner/v1/feinventory?skus=${sku}&locale=${normLocale}`);
          results[sku] = resp;
          await new Promise((r) => setTimeout(r, 100));
        }

        if (!isDone) {
          isDone = true;
          clearTimeout(timer);
          try { client.close(); } catch {}
          resolve({ ok: true, results });
        }
      } catch (execErr) {
        if (!isDone) {
          isDone = true;
          clearTimeout(timer);
          try { client.destroy(); } catch {}
          resolve({ ok: false, error: execErr.message, results });
        }
      }
    }

    client.on('error', (err) => {
      if (!isDone) {
        isDone = true;
        clearTimeout(timer);
        resolve({ ok: false, error: err.message, results });
      }
    });

    execute();
  });
}

/**
 * Maps NVIDIA FE inventory response into an observation.
 */
export function mapNvidiaCard({ cardKey, sku, item, source, now, locale }) {
  const meta = CARD_METADATA[cardKey] || {
    name: `NVIDIA GeForce RTX ${cardKey} Founders Edition`,
    shortName: `RTX ${cardKey} FE`,
    msrpSek: 10000,
    imageUrl: null,
    defaultUrl: `https://marketplace.nvidia.com/${locale}/consumer/graphics-cards/`
  };

  const isActive = item?.is_active === 'true' || item?.is_active === true;
  const productUrl = item?.product_url ? String(item.product_url).trim() : '';
  const parsedPrice = item?.price ? Number(item.price) : NaN;
  // NVIDIA FE API returns 1000000 placeholder when inactive
  const isRealPrice = Number.isFinite(parsedPrice) && parsedPrice > 0 && parsedPrice < 900000;

  const currentPriceSek = isActive && isRealPrice ? parsedPrice : meta.msrpSek;
  const inStock = isActive;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? 'NVIDIA Store',
    sourceType: source.type,
    externalId: `nvidia-fe-${cardKey.toLowerCase()}-${locale.toLowerCase()}`,
    productKey: slugify(`nvidia-geforce-rtx-${cardKey}-founders-edition`),
    title: meta.name,
    url: inStock && productUrl ? productUrl : meta.defaultUrl,
    category: 'GPU',
    condition: 'new',
    conditionLabel: 'Founders Edition',
    priceSek: currentPriceSek,
    marketValueSek: meta.msrpSek,
    referencePriceSek: meta.msrpSek,
    referenceUrl: meta.defaultUrl,
    referenceTitle: meta.name,
    referenceSourceLabel: 'NVIDIA MSRP',
    availability: inStock ? 'in_stock' : 'out_of_stock',
    imageUrl: meta.imageUrl,
    notes: `SKU: ${sku} • Status: ${inStock ? 'In Stock 🚀' : 'Out of stock'} • Locale: ${locale}`,
    seenAt: now
  };
}

/**
 * Main source collection handler for 'nvidia'.
 */
export async function collectFromNvidia({ source, sourceState, now }) {
  const locale = source.locale ?? 'sv-se';
  const cardKeys = Array.isArray(source.includedCards) && source.includedCards.length > 0
    ? source.includedCards
    : GPU_DISPLAY_ORDER;

  const dynamicSkus = await fetchDynamicSkus(source.skuUrl ?? SKUS_URL);

  const cardSkus = cardKeys.map((cardKey) => ({
    cardKey,
    sku: resolveCardSku(cardKey, locale, dynamicSkus)
  }));

  const uniqueSkus = Array.from(new Set(cardSkus.map((c) => c.sku)));
  const inventoryResult = await queryNvidiaFeInventory(uniqueSkus, locale);

  const observations = [];

  for (const { cardKey, sku } of cardSkus) {
    const rawData = inventoryResult.results?.[sku];
    const item = rawData?.listMap?.[0] ?? null;
    const obs = mapNvidiaCard({ cardKey, sku, item, source, now, locale });
    if (obs) observations.push(obs);
  }

  if (sourceState) {
    sourceState.lastScanPartial = !inventoryResult.ok;
  }

  return observations;
}
