import crypto from 'node:crypto';

/**
 * Purchase engine — the shared brain behind the three checkout models.
 *
 *   deep-link     Alert carries a plain URL button to the product page.
 *                 Zero automation, zero risk. Default.
 *
 *   armed         You "arm" a listing in advance. Matching alerts gain a Discord
 *                 button; one tap stages the cart on demand and replies with a
 *                 checkout link. The tap is the human authorisation.
 *
 *   cart-staging  Staging runs proactively the moment an armed listing alerts,
 *                 so the alert already contains a checkout link. Fastest path.
 *
 * SAFETY: no mode in this engine ever submits a payment. Staging stops at the
 * checkout page; the card step is always completed by a human. This is a
 * deliberate design constraint (PSD2/SCA step-up, fraud-detection and
 * irreversible-spend risk), not an unfinished feature.
 */

export const PURCHASE_MODES = Object.freeze(['deep-link', 'armed', 'cart-staging']);

const DEFAULT_MAX_PRICE_SEK = 15000;
const DEFAULT_TTL_MINUTES = 24 * 60;
const DEFAULT_MAX_USES = 1;
const MAX_ATTEMPT_LOG = 100;
const DEFAULT_MAX_STAGES_PER_HOUR = 10;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizePurchaseMode(value, fallback = 'deep-link') {
  const raw = String(value ?? '').trim();
  return PURCHASE_MODES.includes(raw) ? raw : fallback;
}

function normalizeArm(raw, now) {
  if (!isPlainObject(raw) || typeof raw.listingKey !== 'string' || !raw.listingKey) return null;
  const armedAt = typeof raw.armedAt === 'string' ? raw.armedAt : now;
  return {
    listingKey: raw.listingKey,
    mode: normalizePurchaseMode(raw.mode, 'armed'),
    token: typeof raw.token === 'string' && raw.token ? raw.token : crypto.randomBytes(18).toString('base64url'),
    maxPriceSek: Number.isFinite(Number(raw.maxPriceSek)) && Number(raw.maxPriceSek) > 0
      ? Number(raw.maxPriceSek)
      : null,
    armedAt,
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
    maxUses: positiveInt(raw.maxUses, DEFAULT_MAX_USES),
    uses: Number.isFinite(Number(raw.uses)) && Number(raw.uses) >= 0 ? Number(raw.uses) : 0,
    lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : null,
    label: typeof raw.label === 'string' ? raw.label : null,
  };
}

/**
 * Attach (and normalize) the purchase slice of preferences, mirroring
 * ensureRevenueState so old state files upgrade cleanly.
 */
export function ensurePurchaseState(preferences = {}, now = new Date().toISOString()) {
  const raw = isPlainObject(preferences.purchase) ? preferences.purchase : {};

  const armed = {};
  if (isPlainObject(raw.armed)) {
    for (const [key, value] of Object.entries(raw.armed)) {
      const arm = normalizeArm({ ...value, listingKey: value?.listingKey ?? key }, now);
      if (arm) armed[arm.listingKey] = arm;
    }
  }

  preferences.purchase = {
    mode: normalizePurchaseMode(raw.mode, 'deep-link'),
    maxPriceSek: Number.isFinite(Number(raw.maxPriceSek)) && Number(raw.maxPriceSek) > 0
      ? Number(raw.maxPriceSek)
      : DEFAULT_MAX_PRICE_SEK,
    defaultTtlMinutes: positiveInt(raw.defaultTtlMinutes, DEFAULT_TTL_MINUTES),
    maxStagesPerHour: positiveInt(raw.maxStagesPerHour, DEFAULT_MAX_STAGES_PER_HOUR),
    armed,
    attempts: Array.isArray(raw.attempts) ? raw.attempts.slice(0, MAX_ATTEMPT_LOG) : [],
  };
  return preferences.purchase;
}

export function normalizePurchaseSettings(input = {}, current = {}) {
  const next = { ...current };
  if (input.mode !== undefined) next.mode = normalizePurchaseMode(input.mode, current.mode ?? 'deep-link');
  if (input.maxPriceSek !== undefined) {
    const value = Number(input.maxPriceSek);
    if (!Number.isFinite(value) || value <= 0) throw new Error('maxPriceSek must be a positive number.');
    next.maxPriceSek = value;
  }
  if (input.defaultTtlMinutes !== undefined) {
    const value = Number.parseInt(String(input.defaultTtlMinutes), 10);
    if (!Number.isFinite(value) || value <= 0) throw new Error('defaultTtlMinutes must be a positive integer.');
    next.defaultTtlMinutes = value;
  }
  if (input.maxStagesPerHour !== undefined) {
    const value = Number.parseInt(String(input.maxStagesPerHour), 10);
    if (!Number.isFinite(value) || value <= 0) throw new Error('maxStagesPerHour must be a positive integer.');
    next.maxStagesPerHour = value;
  }
  return next;
}

export function armListing(purchase, input = {}, now = new Date()) {
  const listingKey = String(input.listingKey ?? '').trim();
  if (!listingKey) throw new Error('listingKey is required.');

  const ttlMinutes = positiveInt(input.ttlMinutes, purchase.defaultTtlMinutes ?? DEFAULT_TTL_MINUTES);
  const timestamp = now.toISOString();

  // A per-arm cap can only ever be *stricter* than the global cap — arming must
  // never be a way to raise your own spend ceiling.
  const globalCap = Number(purchase.maxPriceSek) || DEFAULT_MAX_PRICE_SEK;
  const requested = Number(input.maxPriceSek);
  const maxPriceSek = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, globalCap)
    : globalCap;

  const arm = {
    listingKey,
    mode: normalizePurchaseMode(input.mode, purchase.mode === 'deep-link' ? 'armed' : purchase.mode),
    token: crypto.randomBytes(18).toString('base64url'),
    maxPriceSek,
    armedAt: timestamp,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    maxUses: positiveInt(input.maxUses, DEFAULT_MAX_USES),
    uses: 0,
    lastUsedAt: null,
    label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : null,
  };

  purchase.armed[listingKey] = arm;
  return arm;
}

export function disarmListing(purchase, listingKey) {
  const key = String(listingKey ?? '');
  if (!purchase.armed[key]) return false;
  delete purchase.armed[key];
  return true;
}

export function pruneExpiredArms(purchase, now = new Date()) {
  let removed = 0;
  for (const [key, arm] of Object.entries(purchase.armed)) {
    if (arm.expiresAt && Date.parse(arm.expiresAt) <= now.getTime()) {
      delete purchase.armed[key];
      removed += 1;
    }
  }
  return removed;
}

export function findArmByToken(purchase, token) {
  const candidate = String(token ?? '');
  if (!candidate) return null;
  const candidateBuffer = Buffer.from(candidate);
  for (const arm of Object.values(purchase.armed ?? {})) {
    const known = Buffer.from(String(arm.token ?? ''));
    if (known.length === candidateBuffer.length && crypto.timingSafeEqual(known, candidateBuffer)) {
      return arm;
    }
  }
  return null;
}

/**
 * Gate every staging request. Returns `{ ok: false, reason }` rather than
 * throwing so callers can surface a precise, user-facing refusal in Discord.
 */
export function checkArmUsable(arm, { priceSek, now = new Date() } = {}) {
  if (!arm) return { ok: false, reason: 'not-armed' };
  if (arm.expiresAt && Date.parse(arm.expiresAt) <= now.getTime()) return { ok: false, reason: 'expired' };
  if (arm.uses >= arm.maxUses) return { ok: false, reason: 'already-used' };

  const price = Number(priceSek);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: 'unknown-price' };
  if (arm.maxPriceSek && price > arm.maxPriceSek) {
    return { ok: false, reason: 'price-above-cap', cap: arm.maxPriceSek, priceSek: price };
  }
  return { ok: true };
}

export function consumeArm(arm, now = new Date()) {
  arm.uses += 1;
  arm.lastUsedAt = now.toISOString();
  return arm;
}

/** Sliding-window rate limit so a bad alert storm cannot drive a staging loop. */
export function checkStageRateLimit(purchase, now = new Date()) {
  const limit = positiveInt(purchase.maxStagesPerHour, DEFAULT_MAX_STAGES_PER_HOUR);
  const cutoff = now.getTime() - 3_600_000;
  const recent = (purchase.attempts ?? []).filter(
    (attempt) => attempt.action === 'stage' && Date.parse(attempt.at ?? '') > cutoff,
  ).length;
  return recent < limit
    ? { ok: true, remaining: limit - recent }
    : { ok: false, reason: 'rate-limited', limit };
}

export function recordAttempt(purchase, attempt = {}, now = new Date()) {
  const entry = {
    id: crypto.randomUUID(),
    at: now.toISOString(),
    action: String(attempt.action ?? 'stage'),
    listingKey: attempt.listingKey ?? null,
    title: attempt.title ?? null,
    mode: attempt.mode ?? null,
    status: String(attempt.status ?? 'unknown'),
    reason: attempt.reason ?? null,
    priceSek: attempt.priceSek == null || !Number.isFinite(Number(attempt.priceSek))
      ? null
      : Number(attempt.priceSek),
    checkoutUrl: attempt.checkoutUrl ?? null,
    via: attempt.via ?? null,
  };
  purchase.attempts = [entry, ...(purchase.attempts ?? [])].slice(0, MAX_ATTEMPT_LOG);
  return entry;
}

/**
 * Build the Discord message components for an alert.
 *
 * `deep-link` yields a URL button only. `armed` adds an interaction button whose
 * custom_id carries the single-use arm token. `cart-staging` surfaces the
 * already-staged checkout URL when one exists, and degrades to `armed`
 * behaviour when staging failed or has not run yet.
 */
export function buildPurchaseComponents({ item, arm, mode, checkoutUrl } = {}) {
  const url = item?.buyUrl ?? item?.url ?? null;
  const buttons = [];

  if (url) {
    buttons.push({ type: 2, style: 5, label: 'Open product', url });
  }

  const effectiveMode = normalizePurchaseMode(mode, 'deep-link');

  if (effectiveMode === 'cart-staging' && checkoutUrl) {
    buttons.push({ type: 2, style: 5, label: '🛒 Complete payment', url: checkoutUrl });
  } else if (arm?.token && effectiveMode !== 'deep-link') {
    const usable = checkArmUsable(arm, { priceSek: item?.latestPriceSek ?? item?.priceSek });
    buttons.push({
      type: 2,
      style: 1,
      label: usable.ok ? '⚡ Stage checkout' : `Unavailable (${usable.reason})`,
      custom_id: `buy:${arm.token}`,
      disabled: !usable.ok,
    });
  }

  return buttons.length ? [{ type: 1, components: buttons }] : [];
}

export function summarizePurchaseState(purchase) {
  return {
    mode: purchase.mode,
    maxPriceSek: purchase.maxPriceSek,
    defaultTtlMinutes: purchase.defaultTtlMinutes,
    maxStagesPerHour: purchase.maxStagesPerHour,
    // Tokens are secrets — they authorise staging from Discord. Never expose them.
    armed: Object.values(purchase.armed ?? {}).map(({ token: _token, ...rest }) => rest),
    attempts: purchase.attempts ?? [],
  };
}
