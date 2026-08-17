import {
  ensurePurchaseState,
  checkStageRateLimit,
  recordAttempt,
  consumeArm,
} from './purchaseEngine.js';
import { stageElgigantenCart } from './elgigantenCheckout.js';

/**
 * Wraps the staging guard rails so the dashboard, the Discord button and the
 * proactive cart-staging alert path all share exactly one implementation.
 * Duplicating these checks would risk one caller silently losing a spend cap.
 */
export function createPurchaseService({ config, getPreferences, findItem, save, stage = stageElgigantenCart }) {
  function purchaseState() {
    return ensurePurchaseState(getPreferences());
  }

  function itemPrice(item) {
    return Number(item?.latestPriceSek ?? item?.priceSek) || null;
  }

  async function stageListing({ listingKey, arm = null, via = 'api' }) {
    const purchase = purchaseState();
    const item = findItem(listingKey);
    const now = new Date();

    // If the listing is armed, that arm governs no matter which path triggered
    // staging — otherwise a dashboard click would silently bypass a strict cap.
    const effectiveArm = arm ?? purchase.armed?.[listingKey] ?? null;

    const fail = (reason, message) => {
      recordAttempt(purchase, {
        action: 'stage', listingKey, title: item?.title, status: 'refused',
        reason, via, priceSek: itemPrice(item),
      }, now);
      return { ok: false, reason, message };
    };

    if (!item) return fail('unknown-listing', 'That listing is no longer tracked.');

    const url = item.url ?? item.buyUrl;
    if (!/^https:\/\/www\.elgiganten\.se\//.test(String(url ?? ''))) {
      return fail('unsupported-source', 'Cart staging is only supported for Elgiganten listings.');
    }

    const price = itemPrice(item);
    if (!price) return fail('unknown-price', 'No current price is known for this listing.');

    // The per-arm cap is already clamped to the global cap at arm time, so the
    // stricter of the two always wins here.
    const cap = effectiveArm?.maxPriceSek ?? purchase.maxPriceSek;
    if (price > cap) return fail('price-above-cap', `Price ${price} kr exceeds your cap of ${cap} kr.`);

    const rate = checkStageRateLimit(purchase, now);
    if (!rate.ok) return fail('rate-limited', `Staging rate limit reached (${rate.limit}/hour).`);

    try {
      const result = await stage({
        productUrl: url,
        credentials: {
          email: config.purchase?.elgigantenEmail,
          password: config.purchase?.elgigantenPassword,
        },
        sessionPath: config.purchase?.sessionPath,
      });
      if (effectiveArm) consumeArm(effectiveArm, now);
      recordAttempt(purchase, {
        action: 'stage', listingKey, title: item.title, status: 'staged',
        mode: effectiveArm?.mode ?? purchase.mode, priceSek: price,
        checkoutUrl: result.checkoutUrl, via,
      }, now);
      if (save) await save();
      return { ok: true, item, price, ...result };
    } catch (error) {
      recordAttempt(purchase, {
        action: 'stage', listingKey, title: item.title, status: 'failed',
        reason: error.message, priceSek: price, via,
      }, now);
      if (save) await save();
      return { ok: false, reason: 'stage-failed', message: error.message };
    }
  }

  return { purchaseState, stageListing, itemPrice };
}
