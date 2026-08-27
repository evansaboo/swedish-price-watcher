/**
 * A local HTTP proxy that forwards to an authenticated SOCKS5 upstream.
 *
 * Chromium cannot authenticate to a SOCKS proxy — credentials passed through
 * Playwright's `proxy` option are silently dropped and the connection fails
 * with no useful error. That rules out using NordVPN's SOCKS5 endpoints (or
 * any credentialed SOCKS provider) directly.
 *
 * This bridge closes the gap: it listens on localhost as a plain HTTP proxy,
 * which Chromium *can* use without credentials, and performs the authenticated
 * SOCKS5 handshake itself. Only CONNECT is implemented, which is all that is
 * needed since every target here is HTTPS.
 *
 * Preferred over routing the whole host through a VPN, because it moves only
 * the traffic that needs a different exit IP and leaves everything else — in
 * particular the inbound Cloudflare tunnel — untouched.
 */

import net from 'node:net';
import http from 'node:http';
import { SocksClient } from 'socks';

/**
 * @param {string} raw e.g. socks5://user:pass@se.socks.nordhold.net:1080
 */
export function parseSocksUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!url.protocol.startsWith('socks')) return null;
  if (!url.hostname) return null;

  return {
    host: url.hostname,
    port: Number(url.port) || 1080,
    type: url.protocol === 'socks4:' ? 4 : 5,
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined
  };
}

/**
 * Start the bridge. Resolves with `{ url, port, close() }`; `url` is what to
 * hand to Chromium or undici.
 *
 * Binds to 127.0.0.1 only — the upstream credentials must not be reachable
 * from the LAN.
 */
export async function startSocksHttpBridge(socksUrl, { port = 0, logger = console } = {}) {
  const proxy = parseSocksUrl(socksUrl);
  if (!proxy) throw new Error(`Invalid SOCKS URL: ${String(socksUrl).slice(0, 40)}`);

  const server = http.createServer((req, res) => {
    // Plain HTTP forwarding is intentionally unsupported: every target is
    // HTTPS, and silently failing would be harder to diagnose than saying so.
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('Only CONNECT (HTTPS) is supported by this bridge.\n');
  });

  server.on('connect', (req, clientSocket, head) => {
    const [host, rawPort] = String(req.url ?? '').split(':');
    const port_ = Number(rawPort) || 443;
    if (!host) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    SocksClient.createConnection({
      proxy: { host: proxy.host, port: proxy.port, type: proxy.type, userId: proxy.userId, password: proxy.password },
      command: 'connect',
      destination: { host, port: port_ },
      timeout: 20_000
    }).then(({ socket }) => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) socket.write(head);
      socket.pipe(clientSocket);
      clientSocket.pipe(socket);

      const teardown = () => { socket.destroy(); clientSocket.destroy(); };
      socket.on('error', teardown);
      clientSocket.on('error', teardown);
      socket.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => socket.destroy());
    }).catch((err) => {
      logger.warn?.(`[socks-bridge] upstream connect failed for ${host}:${port_}: ${err.message}`);
      // Credentials must never reach the client.
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
  });

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}`;
  logger.log?.(`[socks-bridge] listening on ${url} -> socks${proxy.type}://${proxy.host}:${proxy.port}`);

  return {
    url,
    port: actualPort,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/** Exported for tests: whether a URL needs the bridge to be usable. */
export function needsSocksBridge(raw) {
  const value = String(raw ?? '').trim();
  if (!value.startsWith('socks')) return false;
  const parsed = parseSocksUrl(value);
  // Credential-free SOCKS works natively in Chromium, so no bridge needed.
  return Boolean(parsed && (parsed.userId || parsed.password));
}

/** Keep the raw socket module referenced for bundlers/type clarity. */
export const _net = net;
