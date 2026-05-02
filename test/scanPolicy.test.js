import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { PoliteFetcher } from '../src/lib/fetcher.js';
import { shouldSkipDiscordNotifications } from '../src/services/scanPolicy.js';

test('first successful run skips discord notifications', () => {
  assert.equal(
    shouldSkipDiscordNotifications({
      sourceState: {},
      scanState: { cancelling: false, abortController: { signal: { aborted: false } } }
    }),
    true
  );

  assert.equal(
    shouldSkipDiscordNotifications({
      sourceState: { lastSuccessAt: '2026-05-01T10:00:00.000Z' },
      scanState: { cancelling: false, abortController: { signal: { aborted: false } } }
    }),
    false
  );

  assert.equal(
    shouldSkipDiscordNotifications({
      sourceState: { lastSuccessAt: '2026-05-01T10:00:00.000Z' },
      scanState: { cancelling: true, abortController: { signal: { aborted: false } } }
    }),
    true
  );
});

test('polite fetcher respects external abort signal', async () => {
  const server = http.createServer((_, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }, 200);
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const controller = new AbortController();
  const fetcher = new PoliteFetcher({
    userAgent: 'test-agent',
    hostDelayMs: 0,
    requestTimeoutMs: 2000,
    disableHoursOnBlock: 0
  });
  fetcher.setAbortSignal(controller.signal);

  const request = fetcher.fetchText(
    { id: 'test-source', label: 'Test source' },
    {},
    `http://127.0.0.1:${port}/slow`,
    { skipRobotsCheck: true, skipHostDelay: true, accept: 'text/plain' }
  );

  setTimeout(() => controller.abort(), 20);

  await assert.rejects(request, /Aborted/);
  server.close();
});
