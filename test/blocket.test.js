import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Re-implement the private helpers here so we can test them in isolation
// without importing the full scraper (which has side-effect imports).
function normalizeForMatch(str) {
  return String(str ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function titleMatchesKeyword(title, keyword) {
  const normTitle = normalizeForMatch(title);
  const tokens = normalizeForMatch(keyword).split(/\s+/).filter(Boolean);
  return tokens.every(token => normTitle.includes(token));
}

describe('titleMatchesKeyword', () => {
  it('matches exact single word', () => {
    assert.ok(titleMatchesKeyword('iPhone 14 Pro Max', 'iphone'));
  });

  it('matches with interleaved words (iphone pink 14 should match iphone 14)', () => {
    assert.ok(titleMatchesKeyword('iPhone pink 14', 'iphone 14'));
  });

  it('rejects unrelated title', () => {
    assert.ok(!titleMatchesKeyword('Kabel för laddning', 'iphone'));
  });

  it('handles Swedish diacritics – hörlurar', () => {
    assert.ok(titleMatchesKeyword('Hörlurar Sony WH-1000XM5', 'hörlurar'));
  });

  it('handles Swedish diacritics in both keyword and title', () => {
    assert.ok(titleMatchesKeyword('Bildskärm 27 tum 4K', 'bildskärm'));
  });

  it('multi-token keyword – gaming laptop', () => {
    assert.ok(titleMatchesKeyword('Asus ROG gaming laptop 17"', 'gaming laptop'));
  });

  it('multi-token keyword fails when only one token present', () => {
    assert.ok(!titleMatchesKeyword('Asus gaming headset', 'gaming laptop'));
  });

  it('case-insensitive match', () => {
    assert.ok(titleMatchesKeyword('GRAFIKKORT RTX 4090', 'grafikkort'));
  });

  it('single-word keyword cpu does not match generic "dator"', () => {
    assert.ok(!titleMatchesKeyword('komplett speldator', 'cpu'));
  });

  it('cpu matches title containing "cpu"', () => {
    assert.ok(titleMatchesKeyword('Intel CPU i9-13900K nyskick', 'cpu'));
  });

  it('samsung galaxy matches title', () => {
    assert.ok(titleMatchesKeyword('Samsung Galaxy S24 Ultra 256GB svart', 'samsung galaxy'));
  });

  it('empty keyword returns true (no tokens to require)', () => {
    assert.ok(titleMatchesKeyword('Some product', ''));
  });

  it('empty title returns false for non-empty keyword', () => {
    assert.ok(!titleMatchesKeyword('', 'iphone'));
  });
});
