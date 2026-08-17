import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_GROUPS,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  activeGroups,
  countSubqueries,
  ensureHotlistConfig,
  isGroupPollable,
  normalizeHotlistConfig,
  normalizeHotlistGroup,
  seedHotlistConfigFromSource,
} from '../src/services/hotlistConfig.js';

test('normalizeHotlistGroup coerces loose input into a stable shape', () => {
  const group = normalizeHotlistGroup({
    label: '  GPU flips  ',
    taxonomyNames: ['Grafikkort (GPU)', 'Grafikkort (GPU)', '  '],
    brands: 'Asus, MSI',
    keywords: ['RTX 5090', 'rtx 5090', 'RTX 5080'],
    minPriceSek: '1500',
    maxPriceSek: '',
  });

  assert.equal(group.label, 'GPU flips');
  assert.ok(group.id, 'gets an id so the UI can track it');
  assert.equal(group.enabled, true);
  // Deduped case-insensitively and stripped of blanks.
  assert.deepEqual(group.taxonomyNames, ['Grafikkort (GPU)']);
  // A comma-separated string is accepted as well as an array.
  assert.deepEqual(group.brands, ['Asus', 'MSI']);
  assert.deepEqual(group.keywords, ['RTX 5090', 'RTX 5080']);
  assert.equal(group.minPriceSek, 1500);
  // Blank means "no limit", which must stay null rather than becoming 0.
  assert.equal(group.maxPriceSek, null);
  assert.equal(group.minDiscountPct, null);
});

test('an unset threshold stays null so it can fall back to the global default', () => {
  // Regression guard: these were once coerced with Number(), turning an unset
  // threshold into 0 and silently disabling every discount/price filter.
  const group = normalizeHotlistGroup({ label: 'x', keywords: ['a'] });
  assert.equal(group.minDiscountPct, null);
  assert.equal(group.minPriceSek, null);
  assert.equal(group.maxPriceSek, null);
  assert.notEqual(group.minDiscountPct, 0);
});

test('isGroupPollable rejects a group that would match the whole catalogue', () => {
  assert.equal(isGroupPollable(normalizeHotlistGroup({ label: 'empty' })), false);
  assert.equal(isGroupPollable(normalizeHotlistGroup({ label: 'kw', keywords: ['iphone'] })), true);
  assert.equal(isGroupPollable(normalizeHotlistGroup({ label: 'cat', taxonomyNames: ['Laptop'] })), true);
  assert.equal(isGroupPollable(normalizeHotlistGroup({ label: 'id', taxonomyIds: ['PT263'] })), true);
  assert.equal(isGroupPollable(normalizeHotlistGroup({ label: 'brand', brands: ['Apple'] })), true);
});

test('normalizeHotlistConfig clamps the poll interval to a polite range', () => {
  assert.equal(normalizeHotlistConfig({ intervalSeconds: 1 }).intervalSeconds, MIN_INTERVAL_SECONDS);
  assert.equal(normalizeHotlistConfig({ intervalSeconds: 99999 }).intervalSeconds, MAX_INTERVAL_SECONDS);
  assert.equal(normalizeHotlistConfig({ intervalSeconds: 120 }).intervalSeconds, 120);
  // Garbage falls back to the default rather than producing NaN.
  assert.equal(normalizeHotlistConfig({ intervalSeconds: 'soon' }).intervalSeconds, 90);
});

test('normalizeHotlistConfig clamps jitter and caps the number of groups', () => {
  assert.equal(normalizeHotlistConfig({ jitterPct: 500 }).jitterPct, 50);
  assert.equal(normalizeHotlistConfig({ jitterPct: -5 }).jitterPct, 0);

  const many = Array.from({ length: MAX_GROUPS + 10 }, (_, i) => ({ label: `g${i}`, keywords: ['x'] }));
  assert.equal(normalizeHotlistConfig({ groups: many }).groups.length, MAX_GROUPS);
});

test('activeGroups and countSubqueries reflect the real cost of a poll', () => {
  const config = normalizeHotlistConfig({
    groups: [
      { label: 'Filters only', taxonomyNames: ['Grafikkort (GPU)'] },
      { label: 'Two keywords', taxonomyNames: ['Laptop'], keywords: ['MacBook Air', 'MacBook Pro'] },
      { label: 'Disabled', keywords: ['ignored'], enabled: false },
      { label: 'Unpollable' },
    ],
  });

  assert.deepEqual(activeGroups(config).map((g) => g.label), ['Filters only', 'Two keywords']);
  // A filter-only group is one query; each keyword adds another.
  assert.equal(countSubqueries(config), 3);
});

test('seedHotlistConfigFromSource carries the config/sources.json watch list over', () => {
  const config = seedHotlistConfigFromSource({
    enabled: true,
    minDiscountPct: 12,
    hitsPerGroup: 50,
    watchGroups: [
      { label: 'Grafikkort (GPU)', taxonomyIds: ['PT263'], minDiscountPct: 8 },
      { label: 'MacBook', taxonomyIds: ['PT254'], brands: ['Apple'] },
    ],
  });

  assert.equal(config.minDiscountPct, 12);
  assert.equal(config.hitsPerGroup, 50);
  assert.equal(config.groups.length, 2);
  assert.deepEqual(config.groups[0].taxonomyIds, ['PT263']);
  assert.equal(config.groups[0].minDiscountPct, 8);
  assert.deepEqual(config.groups[1].brands, ['Apple']);
});

test('a legacy single-query group is migrated to the keywords list', () => {
  const config = seedHotlistConfigFromSource({
    watchGroups: [{ label: 'Legacy', taxonomyIds: ['PT263'], query: 'RTX 4090' }],
  });
  assert.deepEqual(config.groups[0].keywords, ['RTX 4090']);
});

test('ensureHotlistConfig seeds once, then preserves the stored config', () => {
  const preferences = {};
  ensureHotlistConfig(preferences, { watchGroups: [{ label: 'Seeded', taxonomyIds: ['PT263'] }] });
  assert.equal(preferences.hotlist.groups.length, 1);
  assert.equal(preferences.hotlist.groups[0].label, 'Seeded');

  // A second call must not re-seed over the user's own edits.
  preferences.hotlist.groups = [normalizeHotlistGroup({ label: 'Mine', keywords: ['iphone'] })];
  ensureHotlistConfig(preferences, { watchGroups: [{ label: 'Seeded', taxonomyIds: ['PT263'] }] });
  assert.deepEqual(preferences.hotlist.groups.map((g) => g.label), ['Mine']);
});

test('an explicitly empty group list is respected instead of falling back to the seed', () => {
  // Clearing every watch is a legitimate way to pause the hotlist, so it must
  // not be mistaken for "unconfigured" and refilled from the defaults.
  const config = normalizeHotlistConfig({ groups: [] }, { groups: [{ label: 'Seed', keywords: ['x'] }] });
  assert.deepEqual(config.groups, []);
});
