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
 * Note that spoofing the `sec-ch-ua` *header* is not sufficient. Verified
 * against the live site: with correct headers going out, page JavaScript could
 * still read `navigator.userAgentData.brands` and get back
 * `HeadlessChrome/147`. Client-side fingerprinting reads that object directly,
 * so it has to be patched in the page as well as on the wire.
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
  const brandList = [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not.A/Brand', version: '24' }
  ];
  const secChUa = brandList.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');

  return {
    browserVersion: String(browserVersion ?? ''),
    brands: brandList,
    platform,
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
function stealthScript(fingerprint) {
  const ua = JSON.stringify(fingerprint?.userAgent ?? '');
  const brands = JSON.stringify(fingerprint?.brands ?? []);
  const platform = JSON.stringify(fingerprint?.platform ?? 'Linux');

  return `
  // navigator.userAgentData reports the real automation brand even when the
  // sec-ch-ua header is overridden, so align it with the headers we send.
  // getHighEntropyValues() is the deeper API and leaks the same brand list.
  // (Careful: this script is injected into the page, so it must not itself
  // contain the brand name it is hiding.)
  if (navigator.userAgentData) {
    const brands = ${brands};
    const platform = ${platform};
    const data = {
      brands,
      mobile: false,
      platform,
      toJSON: () => ({ brands, mobile: false, platform }),
      getHighEntropyValues: (hints) => {
        const full = {
          architecture: 'x86',
          bitness: '64',
          brands,
          fullVersionList: brands,
          mobile: false,
          model: '',
          platform,
          platformVersion: '6.1.0',
          uaFullVersion: ${JSON.stringify(String(fingerprint?.browserVersion ?? ''))}
        };
        const out = { brands, mobile: false, platform };
        for (const hint of hints ?? []) {
          if (hint in full) out[hint] = full[hint];
        }
        return Promise.resolve(out);
      }
    };
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => data,
      configurable: true
    });
  }

  // Workers and some checks re-read navigator.userAgent; keep it identical to
  // the header rather than letting the real build's own value show up.
  Object.defineProperty(Navigator.prototype, 'userAgent', {
    get: () => ${ua},
    configurable: true
  });

  // navigator.webdriver is true under automation and false in a real browser.
  Object.defineProperty(Navigator.prototype, 'webdriver', {
    get: () => false,
    configurable: true
  });

  // Automated Chromium reports zero plugins; real Chrome ships a few. Build a
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

  // Automated builds expose no chrome runtime object.
  if (!window.chrome) {
    window.chrome = { runtime: {}, app: { isInstalled: false } };
  }
`;
}

/**
 * Page script that hides the automation traces for a given identity. Runs
 * before any site script, so the site never observes the originals.
 */
export function buildStealthScript(fingerprint) {
  return stealthScript(fingerprint);
}

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
