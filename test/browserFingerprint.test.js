import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFingerprint, buildLaunchArgs, STEALTH_INIT_SCRIPT } from '../src/sources/browserFingerprint.js';

/**
 * These assertions encode the exact mismatches that were observed leaking from
 * the Pi before the fix — a macOS Chrome 131 user agent riding on a Linux
 * Chromium 147 build, with `sec-ch-ua` announcing "HeadlessChrome".
 */
test('browser fingerprint is self-consistent', async (t) => {
  await t.test('user agent version matches the client hints version', () => {
    const fp = buildFingerprint('147.0.7727.0');
    const uaMajor = fp.userAgent.match(/Chrome\/(\d+)/)[1];
    const hintMajor = fp.secChUa.match(/"Chromium";v="(\d+)"/)[1];
    assert.equal(uaMajor, hintMajor);
    assert.equal(uaMajor, '147');
  });

  await t.test('never advertises HeadlessChrome', () => {
    const fp = buildFingerprint('147.0.7727.0');
    const everything = JSON.stringify(fp);
    assert.ok(!/headless/i.test(everything), 'no headless marker anywhere in the identity');
    assert.match(fp.secChUa, /"Google Chrome"/);
  });

  await t.test('platform agrees between user agent and client hints', () => {
    const fp = buildFingerprint('147.0.7727.0');
    assert.match(fp.userAgent, /X11; Linux x86_64/);
    assert.equal(fp.secChUaPlatform, '"Linux"');
    assert.equal(fp.headers['sec-ch-ua-platform'], '"Linux"');
    // The old code claimed macOS from a Linux host — the exact contradiction
    // that made the traffic stand out.
    assert.ok(!/Macintosh/.test(fp.userAgent));
  });

  await t.test('tracks whatever build is actually running', () => {
    const fp = buildFingerprint('152.0.1.0');
    assert.match(fp.userAgent, /Chrome\/152\.0\.1\.0/);
    assert.match(fp.secChUa, /v="152"/);
  });

  await t.test('sends the full client-hint header set', () => {
    const { headers } = buildFingerprint('147.0.7727.0');
    assert.deepEqual(Object.keys(headers).sort(), ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);
    assert.equal(headers['sec-ch-ua-mobile'], '?0');
  });

  await t.test('launch args disable the automation flag', () => {
    const args = buildLaunchArgs();
    assert.ok(args.includes('--disable-blink-features=AutomationControlled'));
    assert.ok(args.includes('--no-sandbox'), 'still required to run as root in the container');
  });

  await t.test('stealth script masks webdriver and is syntactically valid', () => {
    assert.match(STEALTH_INIT_SCRIPT, /webdriver/);
    assert.match(STEALTH_INIT_SCRIPT, /get: \(\) => false/);
    // Guards against shipping a script that throws inside the page, which
    // would break every key fetch. An earlier revision did exactly that by
    // assigning to PluginArray's getter-only length.
    assert.doesNotThrow(() => new Function(STEALTH_INIT_SCRIPT));
    assert.ok(!/PluginArray\.prototype\)/.test(STEALTH_INIT_SCRIPT));
  });
});

test('key renewal timing is randomised', async () => {
  const { _renewalMarginMs } = await import('../src/sources/elgigantenAuth.js');

  // A fixed margin puts the browser visit on an exact quarter-hour tick every
  // time; the spread is what breaks that metronomic pattern.
  assert.equal(_renewalMarginMs(() => 0), 60_000, 'never renews later than 1 min before expiry');
  assert.equal(_renewalMarginMs(() => 0.999999), 299_999, 'and never earlier than 5 min before');

  const samples = new Set(Array.from({ length: 200 }, () => _renewalMarginMs()));
  assert.ok(samples.size > 100, `expected a wide spread, got ${samples.size} distinct values`);
  for (const v of samples) {
    assert.ok(v >= 60_000 && v < 300_000, `${v} out of range`);
  }
});
