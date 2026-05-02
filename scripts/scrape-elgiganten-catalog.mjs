#!/usr/bin/env node
/**
 * Temp scraper: fetch ALL products from Elgiganten's main Algolia catalog index.
 * Paginates commerce_b2c_OCSEELG until all pages are collected.
 * Saves results to /tmp/elgiganten-catalog.json
 *
 * Usage:
 *   node scripts/scrape-elgiganten-catalog.mjs
 *   node scripts/scrape-elgiganten-catalog.mjs --max-pages 5
 *   node scripts/scrape-elgiganten-catalog.mjs --filter "productTaxonomy.id:PT793"
 *   node scripts/scrape-elgiganten-catalog.mjs --out /tmp/my-output.json
 */

import { writeFileSync } from 'fs';

const ALGOLIA_URL =
  'https://z0fl7r8ubh-dsn.algolia.net/1/indexes/*/queries' +
  '?x-algolia-agent=Algolia%20for%20JavaScript%20(5.49.1)%3B%20Browser' +
  '&x-algolia-api-key=bd55a210cb7ee1126552cab633fc1350' +
  '&x-algolia-application-id=Z0FL7R8UBH';

const INDEX = 'commerce_b2c_OCSEELG';
const HITS_PER_PAGE = 100;
const PAGE_DELAY_MS = 200;

// Parse CLI args
const args = process.argv.slice(2);
const maxPagesArg = args.indexOf('--max-pages');
const maxPages = maxPagesArg >= 0 ? parseInt(args[maxPagesArg + 1], 10) : Infinity;
const filterArg = args.indexOf('--filter');
const extraFilter = filterArg >= 0 ? args[filterArg + 1] : null;
const outArg = args.indexOf('--out');
const outFile = outArg >= 0 ? args[outArg + 1] : '/tmp/elgiganten-catalog.json';

console.log(`Index:    ${INDEX}`);
console.log(`Hits/pg:  ${HITS_PER_PAGE}`);
console.log(`Filter:   ${extraFilter ?? 'none (full catalog)'}`);
console.log(`Max pgs:  ${maxPages === Infinity ? 'all' : maxPages}`);
console.log(`Output:   ${outFile}\n`);

async function fetchPage(page, filter) {
  const req = {
    indexName: INDEX,
    hitsPerPage: HITS_PER_PAGE,
    page,
    query: '',
    facets: [],
    attributesToRetrieve: [
      'articleNumber',
      'name',
      'brand',
      'price',
      'bItem',
      'hierarchicalCategories',
      'productTaxonomy',
      'images',
      'url',
      'cgm',
      'availability',
      'isAvailable',
    ],
  };
  if (filter) req.filters = filter;

  const res = await fetch(ALGOLIA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-algolia-api-key': 'bd55a210cb7ee1126552cab633fc1350',
      'x-algolia-application-id': 'Z0FL7R8UBH',
    },
    body: JSON.stringify({ requests: [req] }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`Algolia HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.results?.[0] ?? {};
}

async function main() {
  const allHits = [];
  let page = 0;
  let nbPages = null;
  const startMs = Date.now();

  while (true) {
    if (page >= maxPages) {
      console.log(`Reached --max-pages limit (${maxPages}), stopping.`);
      break;
    }

    const label = nbPages != null ? `page ${page + 1}/${nbPages}` : `page ${page + 1}`;
    process.stdout.write(`  Fetching ${label}…`);
    const result = await fetchPage(page, extraFilter);

    const hits = result.hits ?? [];
    allHits.push(...hits);

    if (nbPages == null) {
      nbPages = result.nbPages ?? 1;
      const total = result.nbHits ?? '?';
      console.log(` ✓  nbHits=${total}  nbPages=${nbPages}  (~${HITS_PER_PAGE}/page)`);
      if (nbPages > 100) {
        console.log(`  ⚠  Large result set — Algolia caps at 1500 hits (page 0-14 of 100/pg).`);
        console.log(`     Use --filter to narrow, or the outlet source uses brand-splitting.\n`);
      }
    } else {
      console.log(` ✓  ${hits.length} hits  (running total: ${allHits.length})`);
    }

    if (hits.length === 0 || page >= nbPages - 1) break;

    page++;
    await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s — ${allHits.length} products collected`);

  writeFileSync(outFile, JSON.stringify(allHits, null, 2));
  console.log(`💾 Saved to ${outFile}`);

  // Summary
  const brands = new Set(allHits.map(h => h.brand).filter(Boolean));
  const cats = {};
  for (const h of allHits) {
    const c = h.hierarchicalCategories?.lvl0 ?? h.hierarchicalCategories?.lvl1 ?? 'Unknown';
    cats[c] = (cats[c] ?? 0) + 1;
  }
  console.log(`\nBrands: ${brands.size}`);
  console.log('Top-level categories:');
  Object.entries(cats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([cat, count]) => console.log(`  ${count.toString().padStart(5)}  ${cat}`));
}

main().catch(err => { console.error(err.message); process.exit(1); });
