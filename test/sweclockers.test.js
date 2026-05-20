import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';

// ─── inline the parsing logic to test in isolation ───────────────────────────

function parseSekValue(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/\s/g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const val = parseFloat(cleaned);
  return Number.isFinite(val) && val > 0 ? val : null;
}

function mapSwecCategory(swecCat) {
  const cat = swecCat.toLowerCase().trim();
  if (cat.includes('grafik') || cat.includes('gpu')) return 'Grafikkort (GPU)';
  if (cat.includes('processor') || cat.includes('cpu')) return 'Processorer';
  if (cat.includes('moderkort')) return 'Moderkort';
  if (cat.includes('minne') || cat.includes('ram')) return 'Minne';
  if (cat.includes('lagring') || cat.includes('ssd') || cat.includes('hdd')) return 'Lagring';
  if (cat.includes('chassi') || cat.includes('case')) return 'Chassin';
  if (cat.includes('nätverk') || cat.includes('router')) return 'Nätverk';
  if (cat.includes('dator') || cat.includes('laptop') || cat.includes('bärbar')) return 'Datorer';
  if (cat.includes('skärm') || cat.includes('monitor')) return 'Skärmar';
  if (cat.includes('headset') || cat.includes('hörlurar') || cat.includes('ljud')) return 'Ljud & Hörlurar';
  if (cat.includes('tangentbord') || cat.includes('mus')) return 'Periferi';
  if (cat.includes('kyla') || cat.includes('kylning')) return 'Kylning';
  if (cat.includes('strömförsörjning') || cat.includes('psu')) return 'Strömförsörjning';
  if (cat.includes('tv') || cat.includes('bild')) return 'TV & Bild';
  if (cat.includes('mobil') || cat.includes('telefon')) return 'Mobiler';
  if (cat.includes('konsol') || cat.includes('gaming')) return 'Gaming';
  return swecCat || 'Övrigt';
}

function parseSweclockersPage(html, source, now) {
  const $ = load(html);
  const observations = [];
  const seen = new Set();

  $('div.tips-row').each((_, row) => {
    const productLink = $(row).find('a.cell-product').first();
    const userLink = $(row).find('a.cell-user').first();

    const productUrl = productLink.attr('href') || '';
    const title = productLink.find('.col-product-inner-wrapper').text().trim();
    const category = productLink.find('.col-category').text().trim() || 'Övrigt';
    const vendor = productLink.find('.col-vendor').text().trim();
    const priceText = productLink.find('.col-price').text().trim();

    const postHref = userLink.attr('href') || '';
    const postIdMatch = postHref.match(/\/forum\/post\/(\d+)/);
    const postId = postIdMatch ? postIdMatch[1] : '';
    const scoreText = userLink.find('.col-score .label').text().trim();
    const score = parseInt(scoreText.replace(/[^0-9-]/g, ''), 10) || 0;

    if (!title || !productUrl) return;
    const price = parseSekValue(priceText);
    if (price == null) return;

    const externalId = postId || `swec-${title.slice(0, 20)}`;
    if (seen.has(externalId)) return;
    seen.add(externalId);

    observations.push({
      sourceId: source.id,
      externalId,
      title,
      url: productUrl.startsWith('http') ? productUrl : `https://www.sweclockers.com${productUrl}`,
      priceSek: price,
      referencePriceSek: null,
      category: mapSwecCategory(category),
      condition: 'deal',
      conditionLabel: 'Dagens Fynd',
      vendor: vendor || null,
      communityScore: score,
      seenAt: now,
    });
  });

  return observations;
}

// ─── fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_HTML = `
<html><body>
<div class="tips-row">
  <a class="col-wrapper cell-product link--secondary" href="https://www.elgiganten.se/product/grafikkort/rtx-4070" rel="nofollow" target="_blank">
    <div class="cell-col col-product">
      <div class="col-product-inner-wrapper">MSI GeForce RTX 4070 Ti SUPER VENTUS 3X OC 16GB</div>
    </div>
    <div class="cell-col col-category">Grafikkort (GPU)</div>
    <div class="cell-col col-vendor">Elgiganten</div>
    <div class="cell-col col-price">8 990  kr</div>
  </a>
  <a class="col-wrapper cell-pj col-prisjakt" href="https://www.prisjakt.nu/produkt.php?p=123" rel="nofollow" target="_blank">
    <img class="cell-pj-logo" src="//www.sweclockers.com/ext/tipsportal/prisjakt.png">
  </a>
  <a class="col-wrapper cell-user link--tertiary" href="/forum/post/21200768">
    <div class="cell-col col-user">@edson</div>
    <div class="cell-col col-score"><span class="label">+24</span></div>
  </a>
</div>
<div class="tips-row">
  <a class="col-wrapper cell-product link--secondary" href="https://www.komplett.se/product/999/asus-rog-strix-scope" rel="nofollow" target="_blank">
    <div class="cell-col col-product">
      <div class="col-product-inner-wrapper">Asus ROG Strix Scope II X Gaming Keyboard</div>
    </div>
    <div class="cell-col col-category">Övrigt</div>
    <div class="cell-col col-vendor">Komplett</div>
    <div class="cell-col col-price">999  kr</div>
  </a>
  <div class="col-wrapper cell-pj col-prisjakt"></div>
  <a class="col-wrapper cell-user" href="/forum/post/21200750">
    <div class="cell-col col-user link--tertiary">@Johnnymann</div>
    <div class="cell-col col-score"><span class="label">+8</span></div>
  </a>
</div>
<div class="tips-row">
  <a class="col-wrapper cell-product link--secondary" href="https://www.inet.se/produkt/12345/headset" rel="nofollow" target="_blank">
    <div class="cell-col col-product">
      <div class="col-product-inner-wrapper">Sony WH-1000XM5 Hörlurar</div>
    </div>
    <div class="cell-col col-category">Ljud</div>
    <div class="cell-col col-vendor">Inet</div>
    <div class="cell-col col-price">1 990  kr</div>
  </a>
  <div class="col-wrapper cell-pj col-prisjakt"></div>
  <a class="col-wrapper cell-user" href="/forum/post/21200999">
    <div class="cell-col col-user link--tertiary">@testuser</div>
    <div class="cell-col col-score"><span class="label">+15</span></div>
  </a>
</div>
</body></html>
`;

const SOURCE = { id: 'sweclockers-dagensfynd', label: 'SweClockers Dagens Fynd', type: 'sweclockers-dagensfynd' };
const NOW = new Date().toISOString();

describe('parseSweclockersPage', () => {
  it('returns one observation per tips-row', () => {
    const obs = parseSweclockersPage(SAMPLE_HTML, SOURCE, NOW);
    assert.equal(obs.length, 3);
  });

  it('extracts title correctly', () => {
    const [first] = parseSweclockersPage(SAMPLE_HTML, SOURCE, NOW);
    assert.equal(first.title, 'MSI GeForce RTX 4070 Ti SUPER VENTUS 3X OC 16GB');
  });

  it('extracts price correctly', () => {
    const [first] = parseSweclockersPage(SAMPLE_HTML, SOURCE, NOW);
    assert.equal(first.priceSek, 8990);
  });

  it('extracts second item price (three-digit)', () => {
    const obs = parseSweclockersPage(SAMPLE_HTML, SOURCE, NOW);
    assert.equal(obs[1].priceSek, 999);
  });

  it('uses forum post ID as externalId', () => {
    const obs = parseSweclockersPage(SAMPLE_HTML, SOURCE, NOW);
    assert.equal(obs[0].externalId, '21200768');
    assert.equal(obs[1].externalId, '21200750');
  });

  it('extracts community score', () => {
    const obs = parseSweclockersPage(SAMPLE_HTML, SOURCE, NOW);
    assert.equal(obs[0].communityScore, 24);
    assert.equal(obs[1].communityScore, 8);
  });

  it('extracts vendor', () => {
    const obs = parseSweclockersPage(SAMPLE_HTML, SOURCE, NOW);
    assert.equal(obs[0].vendor, 'Elgiganten');
    assert.equal(obs[1].vendor, 'Komplett');
  });

  it('sets condition to deal', () => {
    const [first] = parseSweclockersPage(SAMPLE_HTML, SOURCE, NOW);
    assert.equal(first.condition, 'deal');
    assert.equal(first.conditionLabel, 'Dagens Fynd');
  });

  it('maps category GPU correctly', () => {
    const [first] = parseSweclockersPage(SAMPLE_HTML, SOURCE, NOW);
    assert.equal(first.category, 'Grafikkort (GPU)');
  });

  it('maps category Ljud to Ljud & Hörlurar', () => {
    const obs = parseSweclockersPage(SAMPLE_HTML, SOURCE, NOW);
    assert.equal(obs[2].category, 'Ljud & Hörlurar');
  });

  it('deduplicates rows with same post ID', () => {
    // Add a duplicate row
    const dupeHtml = SAMPLE_HTML.replace(
      '</body>',
      `<div class="tips-row">
        <a class="col-wrapper cell-product link--secondary" href="https://www.elgiganten.se/product/1" rel="nofollow">
          <div class="cell-col col-product"><div class="col-product-inner-wrapper">Duplicate Item</div></div>
          <div class="cell-col col-category">Övrigt</div>
          <div class="cell-col col-vendor">Elgiganten</div>
          <div class="cell-col col-price">100 kr</div>
        </a>
        <a class="col-wrapper cell-user" href="/forum/post/21200768">
          <div class="cell-col col-score"><span class="label">+1</span></div>
        </a>
      </div></body>`
    );
    const obs = parseSweclockersPage(dupeHtml, SOURCE, NOW);
    assert.equal(obs.length, 3); // duplicate is skipped
  });

  it('skips rows with missing title', () => {
    const noTitleHtml = SAMPLE_HTML.replace('MSI GeForce RTX 4070 Ti SUPER VENTUS 3X OC 16GB', '');
    const obs = parseSweclockersPage(noTitleHtml, SOURCE, NOW);
    assert.equal(obs.length, 2);
  });

  it('skips rows with invalid price', () => {
    const noPriceHtml = SAMPLE_HTML.replace('>8 990  kr<', '>-<');
    const obs = parseSweclockersPage(noPriceHtml, SOURCE, NOW);
    assert.equal(obs.length, 2);
  });
});

describe('mapSwecCategory', () => {
  it('maps grafikkort to GPU', () => assert.equal(mapSwecCategory('Grafikkort (GPU)'), 'Grafikkort (GPU)'));
  it('maps moderkort', () => assert.equal(mapSwecCategory('Moderkort'), 'Moderkort'));
  it('maps chassi', () => assert.equal(mapSwecCategory('Chassin'), 'Chassin'));
  it('maps nätverk', () => assert.equal(mapSwecCategory('Nätverk'), 'Nätverk'));
  it('maps dator to Datorer', () => assert.equal(mapSwecCategory('Datorer'), 'Datorer'));
  it('passes through unknown category', () => assert.equal(mapSwecCategory('Övrigt'), 'Övrigt'));
  it('returns Övrigt for empty string', () => assert.equal(mapSwecCategory(''), 'Övrigt'));
});
