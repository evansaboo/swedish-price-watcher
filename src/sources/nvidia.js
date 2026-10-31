import { slugify } from '../lib/utils.js';

/**
 * NVIDIA Founders Edition card catalogue and the `nvidia` scan source.
 *
 * Stock data comes from the Notify-FE live feed consumed by
 * services/nvidiaPoller.js; NVIDIA's own store API blocks this host. The scan
 * source reads the poller's latest state through a registered provider and
 * makes no network calls of its own.
 */

// Only the cards the live feed tracks. The 40-series FE cards are discontinued.
export const GPU_DISPLAY_ORDER = ['5090', '5080', '5070'];

export const CARD_METADATA = {
  '5090': {
    name: 'NVIDIA GeForce RTX 5090 Founders Edition',
    shortName: 'RTX 5090 FE',
    msrpSek: 25990,
    imageUrl: '/images/gpu/5090.svg',
    storeSlug: 'nvidia-geforce-rtx-5090',
    defaultUrl: 'https://marketplace.nvidia.com/sv-se/consumer/graphics-cards/nvidia-geforce-rtx-5090/'
  },
  '5080': {
    name: 'NVIDIA GeForce RTX 5080 Founders Edition',
    shortName: 'RTX 5080 FE',
    msrpSek: 13990,
    imageUrl: '/images/gpu/5080.svg',
    storeSlug: 'nvidia-geforce-rtx-5080',
    defaultUrl: 'https://marketplace.nvidia.com/sv-se/consumer/graphics-cards/nvidia-geforce-rtx-5080/'
  },
  '5070': {
    name: 'NVIDIA GeForce RTX 5070 Founders Edition',
    shortName: 'RTX 5070 FE',
    msrpSek: 7990,
    imageUrl: '/images/gpu/5070.svg',
    storeSlug: 'nvidia-geforce-rtx-5070',
    defaultUrl: 'https://marketplace.nvidia.com/sv-se/consumer/graphics-cards/nvidia-geforce-rtx-5070/'
  }
};

export function isSupportedCard(cardKey) {
  return Object.prototype.hasOwnProperty.call(CARD_METADATA, String(cardKey));
}

/** NVIDIA marketplace page for a card in the given locale. */
export function storeUrlFor(cardKey, locale = 'sv-se') {
  const meta = CARD_METADATA[cardKey];
  const loc = String(locale || 'sv-se').toLowerCase();
  if (!meta) return `https://marketplace.nvidia.com/${loc}/consumer/graphics-cards/`;
  return `https://marketplace.nvidia.com/${loc}/consumer/graphics-cards/${meta.storeSlug}/`;
}

// ── Live state provider (registered by src/index.js) ─────────────
let liveStatusProvider = null;

/** Register a function returning the NVIDIA poller's getStatus() result. */
export function setNvidiaLiveStatusProvider(provider) {
  liveStatusProvider = typeof provider === 'function' ? provider : null;
}

/**
 * Maps one poller card summary (status.cards[] entry) into a scan observation.
 */
export function mapNvidiaCard({ card, source, now }) {
  const cardKey = card.cardKey;
  const locale = String(card.locale || 'sv-se').toLowerCase();
  const meta = CARD_METADATA[cardKey] || {
    name: `NVIDIA GeForce RTX ${cardKey} Founders Edition`,
    msrpSek: 10000,
    imageUrl: null
  };
  const storeUrl = card.store_url || storeUrlFor(cardKey, locale);
  const inStock = card.available === true;

  return {
    sourceId: source.id,
    sourceLabel: source.label ?? 'NVIDIA Store',
    sourceType: source.type,
    externalId: `nvidia-fe-${String(cardKey).toLowerCase()}-${locale}`,
    productKey: slugify(`nvidia-geforce-rtx-${cardKey}-founders-edition`),
    title: meta.name,
    url: inStock && card.product_url ? card.product_url : storeUrl,
    category: 'GPU',
    condition: 'new',
    conditionLabel: 'Founders Edition',
    priceSek: meta.msrpSek,
    marketValueSek: meta.msrpSek,
    referencePriceSek: meta.msrpSek,
    referenceUrl: storeUrl,
    referenceTitle: meta.name,
    referenceSourceLabel: 'NVIDIA MSRP',
    availability: inStock ? 'in_stock' : 'out_of_stock',
    imageUrl: meta.imageUrl,
    notes: `SKU: ${card.sku || 'unknown'} • Status: ${inStock ? 'In Stock 🚀' : 'Out of stock'} • Locale: ${locale} • via Notify-FE live feed`,
    seenAt: now
  };
}

/**
 * Scan source handler for type 'nvidia'. Reads the live feed's latest state;
 * throws when there is no trustworthy data so the scan records an error
 * instead of reporting every card as out of stock.
 */
export async function collectFromNvidia({ source, sourceState, now }) {
  const status = liveStatusProvider ? liveStatusProvider() : null;
  if (!status) {
    throw new Error('NVIDIA live feed is not initialised.');
  }
  if (!status.enabled) {
    throw new Error('NVIDIA FE tracker is disabled; enable it in the NVIDIA FE panel to feed this source.');
  }

  const included = Array.isArray(source.includedCards) && source.includedCards.length > 0
    ? new Set(source.includedCards.map(String))
    : null;
  const cards = (status.cards ?? []).filter((card) => !included || included.has(card.cardKey));
  const reachable = cards.filter((card) => card.api_reachable);

  if (reachable.length === 0) {
    throw new Error(`NVIDIA live feed has no fresh data: ${status.lastError || 'no healthy card status yet'}`);
  }

  if (sourceState) {
    sourceState.lastScanPartial = reachable.length < cards.length;
  }

  return reachable.map((card) => mapNvidiaCard({ card, source, now }));
}
