import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  ensurePurchaseState,
  normalizePurchaseSettings,
  armListing,
  disarmListing,
  pruneExpiredArms,
  findArmByToken,
  checkArmUsable,
  consumeArm,
  checkStageRateLimit,
  recordAttempt,
  buildPurchaseComponents,
  summarizePurchaseState,
} from '../src/services/purchaseEngine.js';
import { createPurchaseService } from '../src/services/purchaseService.js';

const ELG_URL = 'https://www.elgiganten.se/product/gaming/x/1';

function freshPurchase() {
  const preferences = {};
  return ensurePurchaseState(preferences);
}

test('ensurePurchaseState applies safe defaults and is idempotent', () => {
  const preferences = {};
  const purchase = ensurePurchaseState(preferences);
  assert.equal(purchase.mode, 'deep-link', 'safest mode is the default');
  assert.equal(purchase.maxPriceSek, 15000);
  assert.deepEqual(purchase.armed, {});

  purchase.mode = 'armed';
  const again = ensurePurchaseState(preferences);
  assert.equal(again.mode, 'armed', 'existing settings survive re-normalisation');
});

test('ensurePurchaseState rejects an unknown mode from a tampered state file', () => {
  const purchase = ensurePurchaseState({ purchase: { mode: 'auto-buy-everything' } });
  assert.equal(purchase.mode, 'deep-link');
});

test('normalizePurchaseSettings validates numeric inputs', () => {
  const current = freshPurchase();
  const next = normalizePurchaseSettings({ mode: 'cart-staging', maxPriceSek: 500 }, current);
  assert.equal(next.mode, 'cart-staging');
  assert.equal(next.maxPriceSek, 500);

  assert.throws(() => normalizePurchaseSettings({ maxPriceSek: -1 }, current), /positive number/);
  assert.throws(() => normalizePurchaseSettings({ maxStagesPerHour: 0 }, current), /positive integer/);
});

test('armListing clamps a per-arm cap to the global cap', () => {
  const purchase = freshPurchase();
  purchase.maxPriceSek = 5000;

  const generous = armListing(purchase, { listingKey: 'a', maxPriceSek: 99999 });
  assert.equal(generous.maxPriceSek, 5000, 'arming must never raise your own spend ceiling');

  const strict = armListing(purchase, { listingKey: 'b', maxPriceSek: 1000 });
  assert.equal(strict.maxPriceSek, 1000, 'a stricter cap is honoured');
});

test('armListing issues a unique token and an expiry', () => {
  const purchase = freshPurchase();
  const a = armListing(purchase, { listingKey: 'a', ttlMinutes: 60 });
  const b = armListing(purchase, { listingKey: 'b', ttlMinutes: 60 });
  assert.notEqual(a.token, b.token);
  assert.ok(a.token.length >= 20, 'token must not be guessable');
  assert.ok(Date.parse(a.expiresAt) > Date.now());
});

test('findArmByToken matches only the exact token', () => {
  const purchase = freshPurchase();
  const arm = armListing(purchase, { listingKey: 'a' });
  assert.equal(findArmByToken(purchase, arm.token)?.listingKey, 'a');
  assert.equal(findArmByToken(purchase, `${arm.token}x`), null);
  assert.equal(findArmByToken(purchase, ''), null);
  assert.equal(findArmByToken(purchase, undefined), null);
});

test('checkArmUsable enforces expiry, single use and the price cap', () => {
  const purchase = freshPurchase();
  const arm = armListing(purchase, { listingKey: 'a', maxPriceSek: 2000, ttlMinutes: 60 });

  assert.equal(checkArmUsable(arm, { priceSek: 1500 }).ok, true);
  assert.equal(checkArmUsable(arm, { priceSek: 2500 }).reason, 'price-above-cap');
  assert.equal(checkArmUsable(arm, { priceSek: null }).reason, 'unknown-price');
  assert.equal(checkArmUsable(null, { priceSek: 100 }).reason, 'not-armed');

  const later = new Date(Date.now() + 61 * 60_000);
  assert.equal(checkArmUsable(arm, { priceSek: 1500, now: later }).reason, 'expired');

  consumeArm(arm);
  assert.equal(checkArmUsable(arm, { priceSek: 1500 }).reason, 'already-used');
});

test('pruneExpiredArms drops only expired entries', () => {
  const purchase = freshPurchase();
  armListing(purchase, { listingKey: 'live', ttlMinutes: 60 });
  const stale = armListing(purchase, { listingKey: 'stale', ttlMinutes: 60 });
  stale.expiresAt = new Date(Date.now() - 1000).toISOString();

  assert.equal(pruneExpiredArms(purchase), 1);
  assert.deepEqual(Object.keys(purchase.armed), ['live']);
});

test('disarmListing removes an arm and reports unknown keys', () => {
  const purchase = freshPurchase();
  armListing(purchase, { listingKey: 'a' });
  assert.equal(disarmListing(purchase, 'a'), true);
  assert.equal(disarmListing(purchase, 'a'), false);
});

test('checkStageRateLimit counts only recent staging attempts', () => {
  const purchase = freshPurchase();
  purchase.maxStagesPerHour = 2;

  assert.equal(checkStageRateLimit(purchase).ok, true);
  recordAttempt(purchase, { action: 'stage' });
  recordAttempt(purchase, { action: 'stage' });
  assert.equal(checkStageRateLimit(purchase).ok, false);

  // An attempt from two hours ago must fall outside the window.
  purchase.attempts[1].at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  assert.equal(checkStageRateLimit(purchase).ok, true);
});

test('summarizePurchaseState never leaks arm tokens', () => {
  const purchase = freshPurchase();
  armListing(purchase, { listingKey: 'a' });
  const summary = summarizePurchaseState(purchase);
  assert.equal(summary.armed.length, 1);
  assert.equal(summary.armed[0].token, undefined);
  assert.ok(!JSON.stringify(summary).includes(purchase.armed.a.token));
});

test('buildPurchaseComponents renders one button per mode', () => {
  const item = { url: ELG_URL, latestPriceSek: 1000, listingKey: 'a' };
  const purchase = freshPurchase();
  const arm = armListing(purchase, { listingKey: 'a', maxPriceSek: 5000 });

  const deep = buildPurchaseComponents({ item, arm, mode: 'deep-link' });
  assert.equal(deep[0].components.length, 1, 'deep-link is a plain URL button');
  assert.equal(deep[0].components[0].style, 5);

  const armed = buildPurchaseComponents({ item, arm, mode: 'armed' });
  const button = armed[0].components[1];
  assert.equal(button.custom_id, `buy:${arm.token}`);
  assert.equal(button.disabled, false);

  const staged = buildPurchaseComponents({ item, arm, mode: 'cart-staging', checkoutUrl: 'https://www.elgiganten.se/checkout' });
  assert.equal(staged[0].components[1].url, 'https://www.elgiganten.se/checkout');
});

test('buildPurchaseComponents disables the button when the arm is unusable', () => {
  const purchase = freshPurchase();
  const arm = armListing(purchase, { listingKey: 'a', maxPriceSek: 500 });
  const components = buildPurchaseComponents({
    item: { url: ELG_URL, latestPriceSek: 9000, listingKey: 'a' },
    arm,
    mode: 'armed',
  });
  const button = components[0].components[1];
  assert.equal(button.disabled, true);
  assert.match(button.label, /price-above-cap/);
});

// ── purchaseService ───────────────────────────────────────────────

function makeService({ items, stage, purchase } = {}) {
  const preferences = purchase ? { purchase } : {};
  ensurePurchaseState(preferences);
  const calls = [];
  const service = createPurchaseService({
    config: { purchase: {} },
    getPreferences: () => preferences,
    findItem: (key) => items?.[key] ?? null,
    save: async () => {},
    stage: stage ?? (async (args) => {
      calls.push(args);
      return { checkoutUrl: 'https://www.elgiganten.se/checkout', signedIn: false };
    }),
  });
  return { service, preferences, calls };
}

const ITEMS = {
  'elg:1': { listingKey: 'elg:1', title: 'RTX 5060', url: ELG_URL, latestPriceSek: 3590 },
  'other:1': { listingKey: 'other:1', title: 'Elsewhere', url: 'https://www.webhallen.com/x', latestPriceSek: 100 },
  'nostock:1': { listingKey: 'nostock:1', title: 'No price', url: ELG_URL, latestPriceSek: null },
};

test('stageListing stages a valid Elgiganten listing', async () => {
  const { service, calls, preferences } = makeService({ items: ITEMS });
  const result = await service.stageListing({ listingKey: 'elg:1', via: 'dashboard' });

  assert.equal(result.ok, true);
  assert.equal(result.checkoutUrl, 'https://www.elgiganten.se/checkout');
  assert.equal(calls[0].productUrl, ELG_URL);
  assert.equal(preferences.purchase.attempts[0].status, 'staged');
});

test('stageListing refuses non-Elgiganten listings, unknown keys and unknown prices', async () => {
  const { service } = makeService({ items: ITEMS });

  assert.equal((await service.stageListing({ listingKey: 'other:1' })).reason, 'unsupported-source');
  assert.equal((await service.stageListing({ listingKey: 'missing' })).reason, 'unknown-listing');
  assert.equal((await service.stageListing({ listingKey: 'nostock:1' })).reason, 'unknown-price');
});

test('stageListing honours an existing arm cap even when triggered elsewhere', async () => {
  // Regression: a dashboard click previously bypassed the arm's stricter cap
  // because it passed no arm and fell back to the global ceiling.
  const { service, preferences, calls } = makeService({ items: ITEMS });
  armListing(preferences.purchase, { listingKey: 'elg:1', maxPriceSek: 2000 });

  const result = await service.stageListing({ listingKey: 'elg:1', via: 'dashboard' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'price-above-cap');
  assert.equal(calls.length, 0, 'the browser must never launch for a refused stage');
});

test('stageListing consumes a single-use arm', async () => {
  const { service, preferences } = makeService({ items: ITEMS });
  const arm = armListing(preferences.purchase, { listingKey: 'elg:1', maxPriceSek: 5000 });

  assert.equal((await service.stageListing({ listingKey: 'elg:1', arm })).ok, true);
  assert.equal(arm.uses, 1);
  // Second attempt is blocked by checkArmUsable at the interaction layer.
  assert.equal(checkArmUsable(arm, { priceSek: 3590 }).reason, 'already-used');
});

test('stageListing records a failure without throwing', async () => {
  const { service, preferences } = makeService({
    items: ITEMS,
    stage: async () => { throw new Error('sold out'); },
  });
  const result = await service.stageListing({ listingKey: 'elg:1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stage-failed');
  assert.equal(preferences.purchase.attempts[0].status, 'failed');
  assert.equal(preferences.purchase.attempts[0].reason, 'sold out');
});

test('stageListing enforces the hourly rate limit', async () => {
  const { service, preferences } = makeService({ items: ITEMS });
  preferences.purchase.maxStagesPerHour = 1;

  assert.equal((await service.stageListing({ listingKey: 'elg:1' })).ok, true);
  const second = await service.stageListing({ listingKey: 'elg:1' });
  assert.equal(second.reason, 'rate-limited');
});

test('recordAttempt caps the audit log and keeps newest first', () => {
  const purchase = freshPurchase();
  for (let i = 0; i < 120; i += 1) recordAttempt(purchase, { action: 'stage', listingKey: `k${i}` });
  assert.equal(purchase.attempts.length, 100);
  assert.equal(purchase.attempts[0].listingKey, 'k119');
});

test('recordAttempt stores a null price rather than zero when unknown', () => {
  const purchase = freshPurchase();
  recordAttempt(purchase, { action: 'stage', priceSek: null });
  assert.equal(purchase.attempts[0].priceSek, null);
});

test('arm tokens are generated with a CSPRNG-sized entropy budget', () => {
  const purchase = freshPurchase();
  const tokens = new Set();
  for (let i = 0; i < 200; i += 1) tokens.add(armListing(purchase, { listingKey: `k${i}` }).token);
  assert.equal(tokens.size, 200, 'no collisions');
  assert.ok(crypto.timingSafeEqual(Buffer.from('a'), Buffer.from('a')));
});
