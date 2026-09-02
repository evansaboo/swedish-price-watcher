import http from 'node:http';
import tls from 'node:tls';
import http2 from 'node:http2';
import { slugify } from '../lib/utils.js';
import { needsSocksBridge, startSocksHttpBridge } from '../services/socksBridge.js';

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

let nvidiaBridgePromise = null;
let nvidiaBridgeUrl = null;

async function getSharedNvidiaBridge(rawUrl) {
  if (nvidiaBridgePromise && nvidiaBridgeUrl === rawUrl) {
    return nvidiaBridgePromise;
  }
  nvidiaBridgeUrl = rawUrl;
  nvidiaBridgePromise = startSocksHttpBridge(rawUrl).catch((err) => {
    console.warn(`[nvidia] could not start SOCKS bridge: ${err.message}`);
    nvidiaBridgePromise = null;
    return null;
  });
  return nvidiaBridgePromise;
}

export async function createNvidiaHttp2Client(targetHost = 'api.store.nvidia.com', targetPort = 443) {
  const rawProxy = process.env.NVIDIA_PROXY_URL || process.env.ELGIGANTEN_PROXY_URL || null;
  if (!rawProxy || !String(rawProxy).trim()) {
    return http2.connect(`https://${targetHost}`);
  }

  let httpProxyUrl = rawProxy;
  if (needsSocksBridge(rawProxy)) {
    const bridge = await getSharedNvidiaBridge(rawProxy);
    if (bridge) {
      httpProxyUrl = bridge.url;
    }
  }

  let proxyParsed;
  try {
    proxyParsed = new URL(httpProxyUrl);
  } catch {
    return http2.connect(`https://${targetHost}`);
  }

  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: proxyParsed.hostname,
      port: Number(proxyParsed.port) || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: proxyParsed.username ? {
        'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxyParsed.username)}:${decodeURIComponent(proxyParsed.password)}`).toString('base64')}`
      } : {}
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
      }

      const tlsSocket = tls.connect({
        socket,
        servername: targetHost,
        ALPNProtocols: ['h2']
      }, () => {
        const client = http2.connect(`https://${targetHost}`, {
          createConnection: () => tlsSocket
        });
        resolve(client);
      });

      tlsSocket.on('error', reject);
    });

    connectReq.on('error', reject);
    connectReq.setTimeout(10000, () => {
      connectReq.destroy(new Error('Proxy CONNECT timed out'));
    });
    connectReq.end();
  });
}

/**
 * Queries the NVIDIA Store API for inventory status using HTTP/2.
 * Akamai requires HTTP/2 with browser headers and handles bot-manager cookies.
 * Routes through NVIDIA_PROXY_URL / ELGIGANTEN_PROXY_URL when configured.
 */
export async function queryNvidiaFeInventory(skus, locale = 'sv-se', { timeoutMs = 15000 } = {}) {
  const normLocale = String(locale).toLowerCase();
  const skuList = Array.isArray(skus) ? skus : [skus];

  let client;
  try {
    client = await createNvidiaHttp2Client();
    client.on('error', () => {
      // Handled: catch session-level errors without throwing unhandled exceptions
    });
  } catch (err) {
    return { ok: false, error: err.message, results: {} };
  }

  return new Promise((resolve) => {

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
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-site',
          'origin': 'https://marketplace.nvidia.com',
          'referer': 'https://marketplace.nvidia.com/'
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

        let statusCode = 200;
        stream.on('response', (resHeaders) => {
          statusCode = Number(resHeaders[':status']) || 200;
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
            const json = JSON.parse(data);
            if (statusCode >= 400) {
              resReq({ error: `http_${statusCode}`, raw: data.slice(0, 100), success: false });
            } else {
              resReq(json);
            }
          } catch {
            resReq({ error: statusCode >= 400 ? `http_${statusCode}` : 'parse_failed', raw: data.slice(0, 100) });
          }
        });
        stream.on('error', (err) => resReq({ error: err.message }));
        stream.end();
      });
    }

    async function fetchSkuWithRetry(sku) {
      if (isDone) return;
      let resp = await requestPath(`/partner/v1/feinventory?skus=${sku}&locale=${normLocale}`);
      if (resp?.error && !isDone) {
        await new Promise((r) => setTimeout(r, 200));
        resp = await requestPath(`/partner/v1/feinventory?skus=${sku}&locale=${normLocale}`);
      }
      results[sku] = resp;
    }

    async function execute() {
      try {
        // Step 1: Warmup request to harvest Akamai bot-manager cookies
        await requestPath(`/partner/v1/feinventory?skus=NVGFT590&locale=${normLocale}`);

        // Step 2: Query all requested SKUs concurrently using HTTP/2 multiplexing
        await Promise.all(skuList.map((sku) => fetchSkuWithRetry(sku)));

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
        try { client.destroy(); } catch {}
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
