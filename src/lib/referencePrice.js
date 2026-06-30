// ═══════════════════════════════════════════════════════════════
// Reference-price validation
// Source-provided "before"/original/struck-through prices are the
// single largest source of false discounts: marketing inflation in
// campaign feeds, mismatched SKUs, and ören/krona scaling errors.
// Before trusting a source reference, validate it against independent
// signals (genuine cross-store peers, plausibility bounds) and label
// the resulting confidence so the UI can distinguish corroborated
// discounts from single-source claims.
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_REFERENCE_OPTIONS = {
  // Implied discount above this almost always means bad data (10x scaling
  // errors, mismatched products). Kept generous so genuine deep clearance
  // (e.g. open-box, end-of-life stock) is preserved.
  maxPlausibleDiscountPercent: 90,
  // A source reference more than this multiple of the genuine cross-store
  // median price is treated as inflated (campaign "before" price) and dropped.
  maxReferenceToMedianRatio: 2.5,
  // Genuine cross-store peers required before peer-based checks apply.
  minPeersForCorroboration: 2,
  // Tolerance band around the peer median for a reference to count as
  // independently corroborated (verified rather than merely claimed).
  peerSupportLow: 0.7,
  peerSupportHigh: 1.3
};

// Validate a source-provided reference ("was"/original) price.
//
// Returns { trustedReference, confidence } where:
//   trustedReference — the reference to use for discount math, or null when
//                      the source reference is missing or rejected.
//   confidence:
//     'verified' — accepted and independently corroborated (catalog match,
//                  cross-store peers in range, or item at its historical low)
//     'claimed'  — accepted but only the source vouches for it
//     'none'     — no usable / trustworthy source reference
export function validateReferencePrice(input, options = {}) {
  const opts = { ...DEFAULT_REFERENCE_OPTIONS, ...options };
  const {
    sourceReference,
    currentPriceSek,
    peerMedian = null,
    peerCount = 0,
    hasCatalogMatch = false,
    atHistoricalLow = false
  } = input;

  const current = Number(currentPriceSek);
  const ref = Number(sourceReference);

  // A reference is only meaningful when it sits above the current price.
  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(ref) || ref <= current) {
    return { trustedReference: null, confidence: 'none' };
  }

  const hasPeers =
    Number.isFinite(peerMedian) && peerMedian > 0 && peerCount >= opts.minPeersForCorroboration;
  const impliedDiscount = ((ref - current) / ref) * 100;
  const grossOutlier = hasPeers && ref > peerMedian * opts.maxReferenceToMedianRatio;

  // Reject implausible references: data errors (scaling/mismatch) or campaign
  // "before" prices that tower over what the same product costs elsewhere.
  if (impliedDiscount > opts.maxPlausibleDiscountPercent || grossOutlier) {
    return { trustedReference: null, confidence: 'none' };
  }

  const peerSupports =
    hasPeers && ref >= peerMedian * opts.peerSupportLow && ref <= peerMedian * opts.peerSupportHigh;
  const confidence = hasCatalogMatch || peerSupports || atHistoricalLow ? 'verified' : 'claimed';

  return { trustedReference: ref, confidence };
}
