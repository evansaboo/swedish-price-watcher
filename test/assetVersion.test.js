import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIndexHtmlBuilder, hashContents, stampAssetUrls } from '../src/lib/assetVersion.js';

async function makePublicDir(appJs = 'console.log(1)') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assets-'));
  await fs.writeFile(
    path.join(dir, 'index.html'),
    '<link rel="stylesheet" href="/styles.css" /><script src="/app.js"></script>',
  );
  await fs.writeFile(path.join(dir, 'app.js'), appJs);
  await fs.writeFile(path.join(dir, 'styles.css'), 'body{}');
  return dir;
}

test('stamps a version onto the cacheable assets only', () => {
  const html = stampAssetUrls('<script src="/app.js"></script><a href="/api/hotlist">x</a>', 'abc123');
  assert.match(html, /src="\/app\.js\?v=abc123"/);
  assert.match(html, /href="\/api\/hotlist"/, 'non-asset URLs must be left alone');
});

test('the same contents hash to the same version', () => {
  assert.equal(hashContents([Buffer.from('a')]), hashContents([Buffer.from('a')]));
  assert.notEqual(hashContents([Buffer.from('a')]), hashContents([Buffer.from('b')]));
});

test('a changed script produces a new URL so caches cannot serve a stale build', async () => {
  const dir = await makePublicDir();
  const build = createIndexHtmlBuilder(dir);

  const before = await build();
  const versionBefore = before.match(/app\.js\?v=(\w+)/)[1];

  // Same content, second call: must be stable (and cached).
  assert.equal(await build(), before);

  await fs.writeFile(path.join(dir, 'app.js'), 'console.log(2)');
  const after = await build();
  const versionAfter = after.match(/app\.js\?v=(\w+)/)[1];

  assert.notEqual(versionAfter, versionBefore);
  assert.match(after, /styles\.css\?v=/);
  await fs.rm(dir, { recursive: true, force: true });
});
