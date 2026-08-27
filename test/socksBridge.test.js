import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { parseSocksUrl, needsSocksBridge, startSocksHttpBridge } from '../src/services/socksBridge.js';

test('socks url parsing', async (t) => {
  await t.test('extracts credentials from a NordVPN-style url', () => {
    const p = parseSocksUrl('socks5://myuser:mypass@se.socks.nordhold.net:1080');
    assert.deepEqual(p, {
      host: 'se.socks.nordhold.net',
      port: 1080,
      type: 5,
      userId: 'myuser',
      password: 'mypass'
    });
  });

  await t.test('defaults to port 1080', () => {
    assert.equal(parseSocksUrl('socks5://host.example').port, 1080);
  });

  await t.test('url-decodes credentials containing special characters', () => {
    const p = parseSocksUrl('socks5://user%40mail:p%40ss%3Aword@h:1080');
    assert.equal(p.userId, 'user@mail');
    assert.equal(p.password, 'p@ss:word');
  });

  await t.test('rejects non-socks and malformed urls', () => {
    assert.equal(parseSocksUrl('http://h:8080'), null);
    assert.equal(parseSocksUrl('not a url'), null);
    assert.equal(parseSocksUrl(''), null);
    assert.equal(parseSocksUrl(undefined), null);
  });
});

test('bridge is only needed for credentialed socks', () => {
  // Chromium handles these natively.
  assert.equal(needsSocksBridge('http://user:pass@h:8080'), false);
  assert.equal(needsSocksBridge('socks5://h:1080'), false);
  // Chromium silently drops SOCKS credentials, so these need the bridge.
  assert.equal(needsSocksBridge('socks5://u:p@h:1080'), true);
  assert.equal(needsSocksBridge(''), false);
});

/**
 * Exercises the real CONNECT path against a minimal SOCKS5 server, so the
 * handshake, authentication and tunnelling are all covered rather than mocked.
 */
test('bridge tunnels CONNECT through an authenticated socks5 upstream', async (t) => {
  const seen = { user: null, pass: null, target: null };

  const socksServer = net.createServer((sock) => {
    let stage = 'greeting';
    sock.on('data', (buf) => {
      if (stage === 'greeting') {
        // Offer username/password auth (method 0x02).
        sock.write(Buffer.from([0x05, 0x02]));
        stage = 'auth';
        return;
      }
      if (stage === 'auth') {
        const ulen = buf[1];
        seen.user = buf.slice(2, 2 + ulen).toString();
        const plen = buf[2 + ulen];
        seen.pass = buf.slice(3 + ulen, 3 + ulen + plen).toString();
        sock.write(Buffer.from([0x01, 0x00])); // success
        stage = 'request';
        return;
      }
      if (stage === 'request') {
        const len = buf[4];
        seen.target = `${buf.slice(5, 5 + len).toString()}:${buf.readUInt16BE(5 + len)}`;
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        stage = 'tunnel';
        // Echo a marker so the client can prove the tunnel carries data.
        sock.write('TUNNEL-OK');
        return;
      }
    });
    sock.on('error', () => {});
  });

  await new Promise((r) => socksServer.listen(0, '127.0.0.1', r));
  const socksPort = socksServer.address().port;
  t.after(() => new Promise((r) => socksServer.close(r)));

  const bridge = await startSocksHttpBridge(
    `socks5://alice:s3cret@127.0.0.1:${socksPort}`,
    { logger: { log() {}, warn() {} } }
  );
  t.after(() => bridge.close());

  const received = await new Promise((resolve, reject) => {
    const client = net.connect(bridge.port, '127.0.0.1', () => {
      client.write('CONNECT www.elgiganten.se:443 HTTP/1.1\r\nHost: www.elgiganten.se:443\r\n\r\n');
    });
    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('TUNNEL-OK')) { client.end(); resolve(data); }
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('timed out')), 5000);
  });

  assert.match(received, /^HTTP\/1\.1 200 Connection Established/);
  assert.match(received, /TUNNEL-OK/, 'bytes flow through the tunnel');
  assert.equal(seen.user, 'alice', 'credentials reach the upstream');
  assert.equal(seen.pass, 's3cret');
  assert.equal(seen.target, 'www.elgiganten.se:443', 'destination is forwarded intact');
});

test('bridge refuses plain HTTP and bad input', async (t) => {
  const bridge = await startSocksHttpBridge('socks5://u:p@127.0.0.1:1', { logger: { log() {}, warn() {} } });
  t.after(() => bridge.close());

  const res = await fetch(`${bridge.url}/`).catch((e) => e);
  assert.equal(res.status, 405, 'non-CONNECT is rejected explicitly rather than hanging');
});
