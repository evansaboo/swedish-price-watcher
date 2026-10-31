/**
 * NVIDIA Founders Edition card catalogue.
 *
 * Stock data comes from the Notify-FE live feed consumed by
 * services/nvidiaPoller.js; NVIDIA's own store API blocks this host. The
 * `nvidia` scan source that mirrored the feed into the main listing is
 * archived in archive/scrapers/nvidiaScanSource.js.
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
