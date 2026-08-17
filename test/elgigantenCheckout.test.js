import test from 'node:test';
import assert from 'node:assert/strict';

import { CHECKOUT_CONSTANTS, hasAuthCookies } from '../src/services/elgigantenCheckout.js';

// These guard the details that were verified against the live site. Elgiganten
// delegates login to an Azure AD B2C tenant with its own field ids, so generic
// email/username selectors silently match nothing.
test('login targets the real sign-in entry point', () => {
  assert.equal(CHECKOUT_CONSTANTS.LOGIN_URL, 'https://www.elgiganten.se/login');
});

test('login selectors cover the B2C field ids', () => {
  assert.ok(CHECKOUT_CONSTANTS.LOGIN_EMAIL_SELECTORS.includes('#signInName'));
  assert.ok(CHECKOUT_CONSTANTS.LOGIN_PASSWORD_SELECTORS.includes('#password'));
  assert.ok(CHECKOUT_CONSTANTS.LOGIN_SUBMIT_SELECTORS.includes('#next'));
});

test('the buy-box button is preferred over accessory upsells', () => {
  // Accessory upsells share the "Lägg i kundvagn" label, so the specific
  // buy-box test id must be tried first.
  const selectors = CHECKOUT_CONSTANTS.ADD_TO_CART_SELECTORS;
  assert.equal(selectors[0], '[data-testid="addToCart-buyBox"]');
  assert.ok(selectors.indexOf('[data-testid="addToCart-buyBox"]') < selectors.indexOf('button:has-text("Lägg i kundvagn")'));
});

const fakeContext = (cookies) => ({ cookies: async () => cookies });

test('sign-in is detected from first-party auth cookies', async () => {
  assert.equal(await hasAuthCookies(fakeContext([{ name: 'se_access_token', value: 'abc' }])), true);
  assert.equal(await hasAuthCookies(fakeContext([{ name: 'se_id_token', value: 'abc' }])), true);
});

test('analytics cookies are never mistaken for a session', async () => {
  // The anonymous session carries 40+ tracking cookies; none of them mean
  // "signed in". This was a real false positive.
  const anonymous = ['anonymous-id', 'cart-id-se', 'statsig-uid', 'MUID', '_scid', 'FPID']
    .map(name => ({ name, value: 'x' }));
  assert.equal(await hasAuthCookies(fakeContext(anonymous)), false);
});

test('an empty auth cookie does not count as signed in', async () => {
  assert.equal(await hasAuthCookies(fakeContext([{ name: 'se_access_token', value: '' }])), false);
});

test('a context that cannot report cookies is treated as signed out', async () => {
  const broken = { cookies: async () => { throw new Error('context closed'); } };
  assert.equal(await hasAuthCookies(broken), false);
});
