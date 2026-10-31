/**
 * ARCHIVED 2026-10-31 — the `nvidia` scan source (id `nvidia-fe`). It copied
 * the NVIDIA FE tracker's live-feed state into the main listing on each scan
 * and made no network calls itself. The tracker (src/services/nvidiaPoller.js)
 * and its dashboard panel do not need it. Split out of src/sources/nvidia.js,
 * so its history is `git log -- src/sources/nvidia.js`.
 * See archive/scrapers/README.md.
 */
import { slugify } from '../../src/lib/utils.js';
import { CARD_METADATA, storeUrlFor } from '../../src/sources/nvidia.js';

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
