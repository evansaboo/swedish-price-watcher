import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Elgiganten cart staging.
 *
 * Drives a real browser to sign in (optional) and put a product in the basket,
 * then hands back the checkout URL.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HARD SAFETY BOUNDARY: this module stops at the checkout page. It contains no
 * code path that fills card details, confirms an order, or presses a pay/submit
 * button, and it must stay that way. Swedish card payments are subject to
 * PSD2/SCA (3-D Secure / BankID step-up), so the final confirmation is always
 * a human action. Removing this boundary would mean automating irreversible
 * spending and defeating fraud protection on the owner's own cards.
 * ────────────────────────────────────────────────────────────────────────────
 */

const BASE_URL = 'https://www.elgiganten.se';
const CART_URL = `${BASE_URL}/cart`;
const CHECKOUT_URL = `${BASE_URL}/checkout`;
const NAV_TIMEOUT_MS = 45_000;
const ACTION_TIMEOUT_MS = 15_000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  'button:has-text("Godkänn alla")',
  'button:has-text("Acceptera alla")',
  'button:has-text("Tillåt alla")',
];

// Order matters: the buy-box button is the real one. The page also renders
// several `button-secondary` "Lägg i kundvagn" buttons for accessory upsells,
// which must never be clicked instead of the product itself.
const ADD_TO_CART_SELECTORS = [
  '[data-testid="addToCart-buyBox"]',
  'button.button-primary:has-text("Lägg i kundvagn")',
  '[data-testid="add-to-cart-button"]',
  'button:has-text("Lägg i kundvagn")',
  'button:has-text("Köp online")',
];

const LOGIN_INDICATOR_SELECTORS = [
  'input[type="email"]',
  'input[name="username"]',
  '#username',
];

async function clickFirst(page, selectors, { timeout = ACTION_TIMEOUT_MS } = {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      await locator.click({ timeout: ACTION_TIMEOUT_MS });
      return selector;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function dismissConsent(page) {
  try {
    await clickFirst(page, CONSENT_SELECTORS, { timeout: 6000 });
  } catch {
    // consent banner is optional
  }
}

async function readSessionState(sessionPath) {
  if (!sessionPath) return undefined;
  try {
    const raw = await fs.readFile(sessionPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function writeSessionState(context, sessionPath) {
  if (!sessionPath) return;
  try {
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    // Session cookies only — card details are never in scope here.
    const state = await context.storageState();
    await fs.writeFile(sessionPath, JSON.stringify(state), { mode: 0o600 });
  } catch (error) {
    console.warn('[checkout] Could not persist session:', error.message);
  }
}

async function isSignedIn(page) {
  // Treat "no visible login form on the account page" as signed in.
  for (const selector of LOGIN_INDICATOR_SELECTORS) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return false;
  }
  return true;
}

async function signIn(page, { email, password }) {
  await page.goto(`${BASE_URL}/mypages`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await dismissConsent(page);

  if (await isSignedIn(page)) return { signedIn: true, reused: true };

  const emailField = page.locator(LOGIN_INDICATOR_SELECTORS.join(', ')).first();
  await emailField.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await emailField.fill(email);

  const passwordField = page.locator('input[type="password"]').first();
  await passwordField.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await passwordField.fill(password);

  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {}),
    passwordField.press('Enter'),
  ]);

  const signedIn = await isSignedIn(page);
  return { signedIn, reused: false };
}

/**
 * Put a product in the basket and return the checkout URL.
 *
 * @param {object} options
 * @param {string} options.productUrl  Elgiganten product page URL.
 * @param {{email?: string, password?: string}} [options.credentials]
 *        Optional. When omitted the cart is staged anonymously, which still
 *        saves the slowest steps and keeps credentials out of the system.
 * @param {string} [options.sessionPath] Where to cache the browser session.
 * @returns {Promise<{checkoutUrl: string, cartUrl: string, signedIn: boolean, addedVia: string, elapsedMs: number}>}
 */
export async function stageElgigantenCart({
  productUrl,
  credentials = {},
  sessionPath,
  headless = true,
  browserLauncher,
} = {}) {
  if (!productUrl || !/^https:\/\/www\.elgiganten\.se\//.test(String(productUrl))) {
    throw new Error('A valid Elgiganten product URL is required.');
  }

  const launcher = browserLauncher ?? (await import('playwright')).chromium;
  const startedAt = Date.now();

  const browser = await launcher.launch({
    headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  let context;
  try {
    context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: 'sv-SE',
      timezoneId: 'Europe/Stockholm',
      viewport: { width: 1440, height: 900 },
      storageState: await readSessionState(sessionPath),
    });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    const page = await context.newPage();

    let signedIn = false;
    if (credentials.email && credentials.password) {
      const result = await signIn(page, credentials);
      signedIn = result.signedIn;
      if (!signedIn) {
        // A failed sign-in is not fatal — anonymous staging still works, and it
        // is far better than retrying a login and tripping account lockout.
        console.warn('[checkout] Sign-in did not complete; staging anonymously.');
      }
    }

    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await dismissConsent(page);

    // The buy box is client-rendered, so wait for the button itself rather than
    // for network idle — Elgiganten polls in the background and never goes idle.
    const addedVia = await clickFirst(page, ADD_TO_CART_SELECTORS, { timeout: 20_000 });
    if (!addedVia) {
      throw new Error('Could not find an add-to-cart button (product may be sold out or the layout changed).');
    }

    // Let the cart mutation settle before reading the basket.
    await page.waitForTimeout(2500);
    await page.goto(CART_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    const cartIsEmpty = await page
      .locator('text=/varukorg(en)? är tom|inga varor/i')
      .first()
      .isVisible()
      .catch(() => false);
    if (cartIsEmpty) {
      throw new Error('Item did not stay in the cart (likely out of stock).');
    }

    await writeSessionState(context, sessionPath);

    // Deliberately returns the checkout URL rather than navigating through it.
    // The human completes payment from here.
    return {
      checkoutUrl: CHECKOUT_URL,
      cartUrl: CART_URL,
      signedIn,
      addedVia,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export const CHECKOUT_CONSTANTS = Object.freeze({ BASE_URL, CART_URL, CHECKOUT_URL, ADD_TO_CART_SELECTORS });
