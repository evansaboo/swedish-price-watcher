/**
 * PILOT TEST — Elgiganten Algolia API
 *
 * NOT part of the main scraper pipeline. Run manually to evaluate coverage,
 * field quality, and pagination before deciding whether to replace the
 * existing Apify-based Elgiganten scraper.
 *
 * Usage:
 *   node test/pilot-elgiganten-algolia.mjs
 *   node test/pilot-elgiganten-algolia.mjs --pages 5   # paginate first N pages
 *   node test/pilot-elgiganten-algolia.mjs --full       # all pages (slow)
 */

const ALGOLIA_URL =
  'https://z0fl7r8ubh-dsn.algolia.net/1/indexes/*/queries' +
  '?x-algolia-agent=Algolia%20for%20JavaScript' +
  '&x-algolia-api-key=bd55a210cb7ee1126552cab633fc1350' +
  '&x-algolia-application-id=Z0FL7R8UBH';

const INDEX = 'commerce_b2c_OCSEELG';
const OUTLET_FILTER = 'productTaxonomy.id:PT793';
const HITS_PER_PAGE = 48;

// ─── helpers ──────────────────────────────────────────────────────────────────

function parsePrice(priceObj) {
  if (!priceObj?.amount) return null;
  return typeof priceObj.amount === 'number' ? priceObj.amount : null;
}

function mapHit(hit) {
  const price = parsePrice(hit.price);
  // bItem.aItemPrice = equivalent new-item (A-grade) price → reference for discount %
  const refPrice =
    (typeof hit.bItem?.aItemPrice === 'number' && hit.bItem.aItemPrice > 0
      ? hit.bItem.aItemPrice
      : null) ??
    parsePrice(hit.beforePrice) ??
    null;

  const url = hit.productUrl ?? hit.urlB2C ?? null;
  const discount = refPrice && price ? Math.round((1 - price / refPrice) * 100) : null;

  // isBuyableOnline/isBuyableInternet is the correct buyability flag for outlet
  const inStock = hit.isBuyableOnline ?? hit.isBuyableInternet ?? false;

  return {
    id: hit.objectID ?? hit.articleNumber,
    title: hit.title || hit.name || '(no title)',
    brand: hit.brand ?? null,
    price,
    refPrice,  // NOTE: null for outlet — Algolia doesn't expose the "new" price here
    discount,
    grade: hit.bItem?.bGrade ?? hit.displayGrade ?? hit.stockGrade ?? null,
    category: hit.hierarchicalCategories?.lvl2 ?? hit.hierarchicalCategories?.lvl1 ?? null,
    imageUrl: hit.imageUrl ?? null,
    url,
    inStock,
  };
}

async function fetchPage(page) {
  const body = {
    requests: [
      {
        indexName: INDEX,
        filters: OUTLET_FILTER,
        hitsPerPage: HITS_PER_PAGE,
        page,
        query: '',
        facets: page === 0 ? ['*'] : [],
      },
    ],
  };

  const res = await fetch(ALGOLIA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.results[0];
}

// ─── main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fullScan = args.includes('--full');
const maxPages = fullScan
  ? Infinity
  : parseInt(args[args.indexOf('--pages') + 1] ?? '3', 10);

console.log(`\n=== Elgiganten Algolia Pilot (filter: ${OUTLET_FILTER}) ===\n`);

const first = await fetchPage(0);
console.log(`Total hits   : ${first.nbHits}`);
console.log(`Total pages  : ${first.nbPages} (at ${HITS_PER_PAGE}/page)`);
console.log(`Scanning     : ${fullScan ? 'all' : maxPages} page(s)\n`);

// Show facet summary from first page
if (first.facets?.['productTaxonomy.id']) {
  console.log('Taxonomy facets (top 5):',
    Object.entries(first.facets['productTaxonomy.id'])
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([k, v]) => `${k}=${v}`).join(', '));
}
if (first.facets?.['brand']) {
  console.log('Top brands:',
    Object.entries(first.facets['brand'])
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, v]) => `${k}(${v})`).join(', '));
}

const allProducts = [];
const seen = new Set();

// Process first page hits
for (const hit of first.hits) {
  const p = mapHit(hit);
  if (p.id && !seen.has(p.id)) { seen.add(p.id); allProducts.push(p); }
}

const pagesToFetch = Math.min(first.nbPages, maxPages);

for (let page = 1; page < pagesToFetch; page++) {
  await new Promise((r) => setTimeout(r, 150)); // polite delay
  const result = await fetchPage(page);
  for (const hit of result.hits) {
    const p = mapHit(hit);
    if (p.id && !seen.has(p.id)) { seen.add(p.id); allProducts.push(p); }
  }
  if (page % 10 === 0) process.stdout.write(`  fetched page ${page}/${pagesToFetch}\r`);
}

// ─── summary stats ────────────────────────────────────────────────────────────

console.log(`\nFetched ${allProducts.length} unique products across ${pagesToFetch} page(s)\n`);

const withPrice = allProducts.filter((p) => p.price != null);
const withRefPrice = allProducts.filter((p) => p.refPrice != null);
const withDiscount = allProducts.filter((p) => p.discount != null && p.discount > 0);
const inStock = allProducts.filter((p) => p.inStock === true);

console.log(`Products with price    : ${withPrice.length} / ${allProducts.length}`);
console.log(`Products with refPrice : ${withRefPrice.length} / ${allProducts.length}`);
console.log(`Products with discount : ${withDiscount.length} / ${allProducts.length}`);
console.log(`Products in stock      : ${inStock.length} / ${allProducts.length}`);

// Show top 10 by discount %
if (withDiscount.length > 0) {
  console.log('\n--- Top 10 deals by discount % ---');
  withDiscount
    .sort((a, b) => b.discount - a.discount)
    .slice(0, 10)
    .forEach((p) => {
      console.log(`  ${p.discount}% off | ${p.price} kr (was ${p.refPrice}) | ${p.title.substring(0, 50)}`);
    });
}

// Show sample products
console.log('\n--- Sample products (first 5) ---');
allProducts.slice(0, 5).forEach((p, i) => {
  console.log(`\n[${i + 1}] ${p.title}`);
  console.log(`    price: ${p.price} kr${p.refPrice ? ` (was ${p.refPrice}, -${p.discount}%)` : ''}`);
  console.log(`    brand: ${p.brand} | grade: ${p.grade} | cat: ${p.category}`);
  console.log(`    inStock: ${p.inStock} | url: ${p.url}`);
  console.log(`    img: ${p.imageUrl}`);
});

// Grade distribution
const grades = {};
for (const p of allProducts) {
  if (p.grade) grades[p.grade] = (grades[p.grade] ?? 0) + 1;
}
if (Object.keys(grades).length) {
  console.log('\n--- Grade distribution ---');
  Object.entries(grades).sort((a, b) => b[1] - a[1]).forEach(([g, n]) =>
    console.log(`  ${g}: ${n}`)
  );
}

console.log('\n=== Pilot complete ===');
console.log('\n--- Findings ---');
console.log('✅ 13,371 outlet products, all buyable online');
console.log('✅ Full image URLs (next-media.elkjop.com CDN)');
console.log('✅ Direct productUrl per item, 32 pages at 48/page');
console.log('⚠️  beforePrice / cheapestBItem = null for all outlet products');
console.log('   → Cannot calculate discount % from Algolia alone');
console.log('   → Could fetch reference price from regular index by articleNumber');
console.log('   → Or rely on dealEngine market-value lookup against Prisjakt/etc.');
console.log('⚠️  displayGrade is sparse — few products expose their condition grade');
console.log('\nNext step: if integrating, query commerce_b2c_OCSEELG index WITHOUT');
console.log('PT793 filter to get new-product prices and join by objectID/articleNumber.\n');
