import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SqliteStore } from '../src/lib/store.js';

async function tmpDbPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spw-store-test-'));
  return path.join(dir, 'store.db');
}

test('SqliteStore persists preferences in the SQLite DB (not a sidecar file)', async () => {
  const dbPath = await tmpDbPath();
  const store = new SqliteStore(dbPath);
  await store.load();

  store.getState().preferences.scheduler = { enabled: true, intervalMinutes: 45, activeWindow: { enabled: false, startTime: '07:00', endTime: '23:00', timeZone: 'Europe/Stockholm' } };
  await store.savePreferences();

  // No sidecar file should be written for a fresh SqliteStore-only preference save.
  const prefFilePath = dbPath.replace(/(\.[^.]+)?$/, '.preferences.json');
  await assert.rejects(() => fs.access(prefFilePath));

  // Re-loading a fresh store instance against the same DB should recover the setting.
  const reloaded = new SqliteStore(dbPath);
  await reloaded.load();
  assert.equal(reloaded.getState().preferences.scheduler.intervalMinutes, 45);
});

test('SqliteStore migrates a legacy preferences sidecar file into the DB on first load', async () => {
  const dbPath = await tmpDbPath();
  const prefFilePath = dbPath.replace(/(\.[^.]+)?$/, '.preferences.json');

  await fs.writeFile(prefFilePath, JSON.stringify({
    favoriteCategories: ['Grafikkort (GPU)'],
    scheduler: { enabled: true, intervalMinutes: 15, activeWindow: { enabled: true, startTime: '07:00', endTime: '00:00', timeZone: 'Europe/Stockholm' } },
    notificationSettings: { notificationsEnabled: true, alertRules: [{ id: 'r1', label: 'GPU', enabled: true, keywords: ['rtx'], categories: [], webhooks: ['https://discord.com/api/webhooks/x'] }] }
  }));

  const store = new SqliteStore(dbPath);
  await store.load();

  assert.equal(store.getState().preferences.scheduler.intervalMinutes, 15);
  assert.deepEqual(store.getState().preferences.favoriteCategories, ['Grafikkort (GPU)']);
  assert.equal(store.getState().preferences.notificationSettings.alertRules[0].label, 'GPU');

  // Sidecar should be renamed to a backup, not left in place / re-read.
  await assert.rejects(() => fs.access(prefFilePath));
  await assert.doesNotReject(() => fs.access(`${prefFilePath}.migrated`));

  // A second load (fresh instance) should read from SQLite, not the (now-gone) sidecar.
  const reloaded = new SqliteStore(dbPath);
  await reloaded.load();
  assert.equal(reloaded.getState().preferences.scheduler.intervalMinutes, 15);
});
