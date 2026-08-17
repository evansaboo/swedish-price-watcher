import test from 'node:test';
import assert from 'node:assert/strict';

import { itemMatchesRule } from '../src/services/notifier.js';

/**
 * The hotlist poller has no Discord routing of its own — a deal is only ever
 * announced if it matches one of the user's alert rules. That made it possible
 * for the poller to happily collect a category nobody was ever told about:
 * "Intern SSD" was the single largest hotlist group yet matched no rule, so
 * those deals were found, scored, shown on the dashboard — and never alerted.
 *
 * These cases pin the routing for the categories the hotlist actually watches.
 */

const WEBHOOK = 'https://discord.com/api/webhooks/1/x';

// Mirrors the deployed rule set.
const RULES = [
  {
    label: 'GPU',
    keywords: ['rtx 5070', 'rtx 5080', 'rtx 5060', 'rx 9070', 'rx 9060', 'rx 6700'],
    categories: [],
    filteredSources: ['tradera-sold'],
    sourceFilterMode: 'exclude',
    minDiscountPercent: 15
  },
  {
    label: 'Iphone',
    keywords: ['iphone'],
    categories: ['mobiltelefon'],
    filteredSources: ['blocket-electronics', 'tradera-sold'],
    sourceFilterMode: 'exclude',
    minDiscountPercent: 15
  },
  {
    label: 'Macbook',
    keywords: ['macbook'],
    categories: ['bärbar dator', 'datorer & kontor > datorer > laptop', 'laptop', 'macbook', 'apple'],
    filteredSources: ['blocket-electronics', 'tradera-sold'],
    sourceFilterMode: 'exclude',
    minDiscountPercent: 15
  },
  {
    label: 'RAM-minne',
    keywords: ['ddr5', 'ddr4'],
    categories: ['ram-minne'],
    filteredSources: [],
    sourceFilterMode: 'exclude',
    minDiscountPercent: 15
  },
  {
    label: 'Hotlist - Intern SSD',
    keywords: [],
    categories: ['intern ssd'],
    filteredSources: ['elgiganten-hotlist'],
    sourceFilterMode: 'include',
    minDiscountPercent: 15
  }
];

/** Real titles/categories taken from the live hotlist. */
function hotlistItem(title, category, { priceSek = 1000, referencePriceSek = 2000 } = {}) {
  return {
    sourceId: 'elgiganten-hotlist',
    listingKey: `elgiganten-hotlist:${title}`,
    title,
    category,
    priceSek,
    referencePriceSek
  };
}

function matchingRuleLabels(item) {
  return RULES.filter((rule) => itemMatchesRule(item, rule)).map((rule) => rule.label);
}

test('hotlist alert routing', async (t) => {
  await t.test('an Intern SSD deal is alerted (the gap this rule closes)', () => {
    const item = hotlistItem('Samsung 990 Pro The Ultimate SSD 1 TB', 'Intern SSD');
    assert.deepEqual(matchingRuleLabels(item), ['Hotlist - Intern SSD']);
  });

  await t.test('a DDR4 stick is alerted, not just DDR5', () => {
    const ddr4 = hotlistItem('KLEVV BOLT X DDR4 RAM 16GB (2x8GB) 3600MT/s CL18', 'RAM-minne');
    const ddr5 = hotlistItem('Corsair Vengeance DDR5 32GB 6000MT/s', 'RAM-minne');
    assert.deepEqual(matchingRuleLabels(ddr4), ['RAM-minne']);
    assert.deepEqual(matchingRuleLabels(ddr5), ['RAM-minne']);
  });

  await t.test('every watched hotlist category reaches exactly one rule', () => {
    // Dedupe is keyed per listing *per rule*, so two matching rules means the
    // user gets the same deal twice.
    const items = [
      hotlistItem('PNY GeForce RTX 5070 Ti 16GB ARGB 3X OC grafikkort', 'Grafikkort (GPU)'),
      hotlistItem('KLEVV BOLT X DDR4 RAM 16GB (2x8GB) 3600MT/s CL18', 'RAM-minne'),
      hotlistItem('Samsung 990 Pro The Ultimate SSD 1 TB', 'Intern SSD'),
      hotlistItem('Apple MacBook Air 13" M4 16GB 256GB', 'Laptop'),
      hotlistItem('iPhone Air 5G smartphone 1TB Light Gold', 'Mobiltelefon')
    ];
    for (const item of items) {
      assert.equal(matchingRuleLabels(item).length, 1, `${item.title} -> ${matchingRuleLabels(item)}`);
    }
  });

  await t.test('the SSD rule stays scoped to the hotlist source', () => {
    const otherStore = { ...hotlistItem('Samsung 990 Pro SSD 1 TB', 'Intern SSD'), sourceId: 'komplett-outlet-electronics' };
    assert.deepEqual(matchingRuleLabels(otherStore), []);
  });

  await t.test('a shallow discount is still filtered out', () => {
    const item = hotlistItem('Samsung 990 Pro The Ultimate SSD 1 TB', 'Intern SSD', {
      priceSek: 1900,
      referencePriceSek: 2000
    });
    assert.deepEqual(matchingRuleLabels(item), []);
  });
});
