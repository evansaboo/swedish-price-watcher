/**
 * Consistent, non-headless-looking browser fingerprints.
 *
 * The previous approach hard-coded a macOS Chrome 131 user agent onto a Linux
 * Chromium 147 build. That is worse than not spoofing at all, because the
 * override only changes the `user-agent` header — every other signal keeps
 * telling the truth, and the disagreement is itself the giveaway. Measured on
 * the Pi, a request went out as:
 *
 *   user-agent          Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ... Chrome/131.0.0.0
 *   sec-ch-ua           "HeadlessChrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"
 *   sec-ch-ua-platform  "macOS"
 *
 * so the server saw a browser claiming to be Chrome 131 on macOS while its own
 * client hints announced HeadlessChrome 147. On top of that
 * `navigator.webdriver` was `true`.
 *
 * This module derives every signal from the real browser build instead, so the
 * user agent, client hints, platform and JS-visible properties all agree. The
 * only fiction is replacing "HeadlessChrome" with "Chrome".
 */

/** Chromium exposes the build as e.g. "147.0.7727.0"; hints use the major. */
function majorVersion(version) {
  return String(version ?? '').split('.')[0] || '';
}

/**
 * Build a coherent identity from the browser's own version string.
 * `platform` mirrors what the binary actually runs on — claiming macOS from a
 * Linux host contradicts navigator.platform, WebGL strings and font metrics.
 */
export function buildFingerprint(browserVersion, { platform = 'Linux' } = {}) {
  const major = majorVersion(browserVersion);
  const uaPlatform = platform === 'Linux'
    ? 'X11; Linux x86_64'
    : 'Macintosh; Intel Mac OS X 10_15_7';

  const userAgent =
    `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) `
    + `Chrome/${browserVersion} Safari/537.36`;

  // Mirrors Chrome's GREASE ordering; "Google Chrome" replaces the
  // "HeadlessChrome" brand that Chromium would otherwise advertise.
  const secChUa = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not.A/Brand";v="24"`;

  return {
    userAgent,
    secChUa,
    secChUaPlatform: `"${platform}"`,
    headers: {
      'sec-ch-ua': secChUa,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': `"${platform}"`
    }
  };
}

/**
 * Removes the automation traces Chromium leaves in the page. Runs before any
 * site script, so the site never observes the originals.
 */
export const STEALTH_INIT_SCRIPT = `
  // navigator.webdriver is true under automation and false in a real browser.
  Object.defineProperty(Navigator.prototype, 'webdriver', {
    get: () => false,
    configurable: true
  });

  // Headless Chromium reports zero plugins; real Chrome ships a few. Build a
  // plain array-like rather than mutating PluginArray.prototype, whose length
  // is getter-only and throws on assignment.
  if (navigator.plugins && navigator.plugins.length === 0) {
    const names = [
      ['PDF Viewer', 'internal-pdf-viewer'],
      ['Chrome PDF Viewer', 'internal-pdf-viewer'],
      ['Chromium PDF Viewer', 'internal-pdf-viewer']
    ];
    const list = names.map(([name, filename]) => ({ name, filename, description: 'Portable Document Format' }));
    list.item = (i) => list[i] ?? null;
    list.namedItem = (n) => list.find((p) => p.name === n) ?? null;
    Object.defineProperty(Navigator.prototype, 'plugins', {
      get: () => list,
      configurable: true
    });
  }

  // Headless exposes no chrome runtime object.
  if (!window.chrome) {
    window.chrome = { runtime: {}, app: { isInstalled: false } };
  }
`;

/**
 * Launch flags. AutomationControlled is the blink feature that sets
 * navigator.webdriver and related hints; disabling it removes the signal at
 * source rather than patching it afterwards.
 */
export function buildLaunchArgs(extra = []) {
  return [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    ...extra
  ];
}
