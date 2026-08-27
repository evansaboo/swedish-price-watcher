#!/usr/bin/env node
/**
 * Verify ELGIGANTEN_PROXY_URL actually works before relying on it.
 *
 * A misconfigured proxy fails silently in the worst possible way: requests
 * still succeed, but they leave from the host's own IP, so you believe you are
 * protected while the address you were trying to hide is the one being used.
 * This checks the exit IP through the proxy and compares it against the
 * unproxied one, then confirms Elgiganten is reachable over that path.
 *
 *   node scripts/check-proxy.mjs
 */

import 'dotenv/config';
import { needsSocksBridge, startSocksHttpBridge } from '../src/services/socksBridge.js';

const IP_ENDPOINT = 'https://api.ipify.org?format=json';
const TARGET = 'https://www.elgiganten.se/';

function line(label, value) {
  console.log(`  ${label.padEnd(18)} ${value}`);
}

async function directIp() {
  const res = await fetch(IP_ENDPOINT, { signal: AbortSignal.timeout(15000) });
  return (await res.json()).ip;
}

async function main() {
  const raw = process.env.ELGIGANTEN_PROXY_URL?.trim();

  console.log('\nElgiganten proxy check\n');

  if (!raw) {
    console.log('  ELGIGANTEN_PROXY_URL is not set — traffic uses this host\'s IP.');
    console.log('  That is fine while the IP is unblocked. To route via NordVPN:');
    console.log('    ELGIGANTEN_PROXY_URL=socks5://<service-user>:<service-pass>@se.socks.nordhold.net:1080');
    console.log('  Use the *service* credentials from Nord Account -> "Set up NordVPN');
    console.log('  manually", not your account login.\n');
    process.exit(1);
  }

  // Never print the credentials themselves.
  const redacted = raw.replace(/\/\/[^@]*@/, '//***:***@');
  line('configured', redacted);

  let bridge = null;
  let agentUrl = raw;

  if (needsSocksBridge(raw)) {
    line('mode', 'credentialed SOCKS5 -> local HTTP bridge');
    bridge = await startSocksHttpBridge(raw, { logger: { warn() {}, info() {} } });
    agentUrl = bridge.url;
    line('bridge', bridge.url);
  } else {
    line('mode', raw.startsWith('socks') ? 'SOCKS (no credentials)' : 'HTTP proxy');
  }

  const { ProxyAgent } = await import('undici');
  const dispatcher = new ProxyAgent(agentUrl);

  try {
    const before = await directIp().catch(() => 'unknown');
    line('IP without proxy', before);

    const res = await fetch(IP_ENDPOINT, { dispatcher, signal: AbortSignal.timeout(25000) });
    const after = (await res.json()).ip;
    line('IP via proxy', after);

    if (after === before) {
      console.log('\n  FAIL: the proxy exits from the same IP as this host.');
      console.log('  Traffic is not being rerouted — check the credentials and hostname.\n');
      process.exitCode = 1;
      return;
    }
    console.log('\n  Exit IP changed — the proxy is carrying traffic.\n');

    const target = await fetch(TARGET, {
      dispatcher,
      headers: { 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30000)
    });
    const mitigated = target.headers.get('x-vercel-mitigated');
    line('elgiganten.se', `${target.status}${mitigated ? ` (mitigated: ${mitigated})` : ''}`);

    if (mitigated === 'deny') {
      console.log('\n  This proxy IP is itself firewall-denied. Try another endpoint,');
      console.log('  e.g. stockholm.se.socks.nordhold.net.\n');
      process.exitCode = 1;
    } else {
      // 403 without a deny header, and 429, are the normal bot-challenge
      // responses to a plain fetch; the real scraper solves them in a browser.
      console.log('\n  Proxy path is usable.\n');
    }
  } catch (err) {
    // `fetch failed` on its own is useless for diagnosis; the real reason is
    // almost always one level down in `cause`.
    const cause = err.cause?.message ?? err.cause?.code;
    console.log(`\n  FAIL: ${err.message}${cause ? ` (${cause})` : ''}\n`);
    console.log('  Common causes: wrong service credentials (they are not your Nord');
    console.log('  account password), or a hostname that no longer offers SOCKS5.\n');
    process.exitCode = 1;
  } finally {
    await bridge?.close?.();
  }
}

main();
