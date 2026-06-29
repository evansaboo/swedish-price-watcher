// ═══════════════════════════════════════════════════════════════
// resaleEngine — flip/resale opportunity detection
//
// Values buyable (outlet/deal) items against ACTUAL Blocket second-hand
// prices for the same product model, then ranks by real net profit.
//
// 1. extractResaleModel(title) — canonical "model" signature for high-demand
//    resale categories (Apple devices, GPUs, consoles, …). The signature is
//    deliberately coarse (model + key price-driving variant, ignoring board
//    partner / colour / cosmetic words) so a noisy Blocket title and a clean
//    retail title collapse to the same key.
// 2. buildResaleIndex(usedItems) — per-model price stats from Blocket comps.
// 3. computeFlips(candidates, index, opts) — net profit per buyable item.
// ═══════════════════════════════════════════════════════════════

import { median } from '../lib/utils.js';

const DEFAULT_RESALE_OPTIONS = {
  minSampleCount: 3,       // Blocket comps required before we trust a median
  resaleAdjustFactor: 0.95, // sell slightly under median to move quickly
  flatFeeSek: 60,          // shipping / packaging / Blocket fee allowance
  minNetProfitSek: 300,    // floor for surfacing a flip
  minRoiPercent: 8         // floor ROI (profit / buy price)
};

function normalize(title) {
  return String(title ?? '')
    // Drop trademark/registered/copyright marks FIRST: NFKD expands ™ → "TM",
    // which would glue onto the preceding token (e.g. "RTX™" → "rtxtm") and
    // break word-boundary matching. Replace with a space, not nothing.
    .replace(/[\u2122\u00ae\u00a9]/g, ' ')
    .normalize('NFKD')
    // strip combining diacritics so "ö" → "o" for robust token matching
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Storage size (GB/TB) — a major price driver for phones/tablets/laptops.
function extractStorage(norm) {
  const tb = norm.match(/(\d+)\s*tb\b/);
  if (tb) return `${Number(tb[1]) * 1024}gb`;
  const gb = norm.match(/(\d+)\s*gb\b/);
  if (gb && Number(gb[1]) >= 32) return `${gb[1]}gb`;
  return null;
}

// Accessory / peripheral indicators. A "MacBook Pro 14 fodral" (case) or an
// "iPhone 15 silikonskal" must NEVER be priced against the actual device — that
// produces absurd "flips" (a 300 kr case vs a 21 000 kr laptop). If a title is
// clearly an accessory FOR a device rather than the device itself, reject it.
// Tokens are matched against the normalized (diacritic-stripped) title. In
// Swedish the accessory noun is the LAST element of a compound ("silikonskal",
// "läderfodral", "skärmskydd", "väggfäste", "billaddare"), so we suffix-match
// (optional leading compound letters) rather than require a standalone word.
const ACCESSORY_PATTERN = new RegExp('\\b[a-z]*(?:' + [
  // cases / covers / protection
  'fodral', 'skal', 'etui', 'skarmskydd', 'skyddsglas', 'skyddsfilm', 'skydd',
  'protector', 'case', 'cover', 'sleeve', 'pouch', 'grip', 'skin',
  'klistermarke', 'dekal', 'vaska', 'ryggsack',
  // power / cabling / connectivity
  'laddare', 'kabel', 'adapter', 'dongle', 'dockningsstation', 'docka', 'hubb',
  // mounts / stands / peripherals
  'stativ', 'hallare', 'faste', 'tangentbord', 'fjarrkontroll', 'pencil',
  // wallet / folio cases ("mobilplånbok", "plånboksfodral")
  'planbok', 'holster', 'korthallare',
  // wearables straps (Apple Watch etc.)
  'armband', 'sportband', 'milanese'
].join('|') + ')\\b');

// Repair/refurb SERVICES, spare PARTS, and broken / for-parts listings. These
// are not the sellable device: "Byt skärm på din iPhone 11" (a screen-swap
// service) or "Skärm till iPhone 11" (a part) must never be priced as a phone.
// Tuned to be high-precision — a genuine phone described as having a "ny skärm
// och nytt batteri" stays IN (we only match service verbs, "X till <device>"
// part phrasing, and explicit broken/for-parts wording).
const REPAIR_OR_PARTS_PATTERN = new RegExp([
  '\\bbyt(?:er|a)?\\s+(?:skarm|batteri|glas|baksida|laddport)',
  '\\bskarmbyte\\b', '\\bbatteribyte\\b', '\\bbyte av\\b',
  '\\brepar(?:ation|ationer|era|erar|eras)\\b',
  '\\bvi (?:lagar|byter|fixar|reparerar)\\b', '\\blagar din\\b', '\\bservice av\\b',
  '\\b(?:skarm|batteri|baksida|baksideglas|laddport|moderkort|kretskort|flexkabel|laddkontakt)\\s+till\\b',
  '\\breservdel', '\\btrasig\\b', '\\bdefekt\\b', '\\bfor delar\\b', '\\btill delar\\b',
  '\\bfungerar ej\\b', '\\bspracka?d\\b'
].join('|'));

// ── Per-category extractors ────────────────────────────────────
// Each returns { resaleKey, modelLabel } or null. demandCategory is attached
// by the dispatcher below.

// Indicators that a listing is a COMPLETE system / laptop rather than a bare
// component. A bare GPU/CPU names only the part; a build/laptop names a chassis,
// a CPU+GPU together, or a known laptop product line. Pricing a bare RTX 5070
// against a whole gaming PC or a Lenovo Legion laptop produces large phantom
// "profit", so such titles must NOT be keyed as the bare component.
// NOTE: deliberately EXCLUDES 'rog'/'tuf'/'strix' etc. because those are also
// desktop GPU board-partner lines (e.g. "ASUS TUF Gaming RTX 5070 Ti" is a card).
// `norm` is already diacritic-stripped, so use stripped forms (stationar, barbar).
// Swedish puts the noun LAST in compounds, so 'dator'/'bygg' must suffix-match
// (gamingdator, speldator, stationardator, nybyggd, hemmabygge) — a plain word
// boundary would miss them.
const SYSTEM_OR_LAPTOP_PATTERN = new RegExp(
  '\\b[a-z]*dator\\b' +       // *dator: gamingdator, speldator, stationardator…
  '|\\b[a-z]*bygg[a-z]*\\b' + // *bygg*: bygge, bygget, byggd, nybyggd, hemmabygge
  '|\\b(?:' + [
    // complete desktops / builds
    'pc', 'stationar', 'barebone', 'prebuilt', 'workstation', 'rig', 'komplett',
    'moderkort', 'chassi',
    // laptops (generic)
    'laptop', 'barbar', 'notebook', 'ultrabook',
    // laptop product lines (laptop-only — safe to reject)
    'legion', 'predator', 'zephyrus', 'katana', 'raider', 'cyborg', 'thinkpad',
    'ideapad', 'victus', 'omen', 'vivobook', 'zenbook', 'aspire', 'inspiron',
    'latitude', 'probook', 'elitebook', 'pavilion', 'thinkbook', 'macbook'
  ].join('|') + ')\\b'
);

// Lightweight presence detectors (no model parsing) used to spot CPU+GPU bundles.
// No trailing \b so model suffixes (i5-11400F, 7800X3D) still match.
const HAS_GPU_TOKEN = /\b(?:rtx|gtx)\s*\d{3,4}|\brx\s*\d{3,4}|\barc\s*[ab]\d{3}/;
const HAS_CPU_TOKEN = /\bryzen\s*[3579]\s*\d{3,4}|\bi[3579]-?\s*\d{4,5}|\bcore\s*ultra\b/;

// A bare component listing must not also look like a system/laptop, and must not
// pair a CPU with a GPU (that is a build/bundle, not the bare part).
function looksLikeBareComponent(norm, { partType }) {
  if (SYSTEM_OR_LAPTOP_PATTERN.test(norm)) return false;
  if (partType === 'gpu' && HAS_CPU_TOKEN.test(norm)) return false; // GPU + CPU → build
  if (partType === 'cpu' && HAS_GPU_TOKEN.test(norm)) return false; // CPU + GPU → build
  return true;
}

function matchIphone(norm) {
  if (!/\biphone\b/.test(norm)) return null;
  // Strip storage first so "128"/"256" can't be read as a model number, then
  // find the model number anywhere after "iphone" (Blocket titles interleave
  // colour/condition words, e.g. "iphone svart 14"). Range 11–29 avoids the
  // common storage sizes (32/64/128/256/512).
  const storage = extractStorage(norm);
  const withoutStorage = norm.replace(/\b\d+\s*(?:gb|tb)\b/g, ' ');
  const after = withoutStorage.slice(withoutStorage.indexOf('iphone'));
  const numMatch = after.match(/\b(1[1-9]|2[0-9])\b/);
  if (!numMatch) return null;
  const num = numMatch[1];
  const variantMatch = after.match(/\b(pro\s*max|pro|plus|mini)\b/);
  const variant = (variantMatch?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const variantKey = variant ? variant.replace(/\s+/g, '-') : 'base';
  const resaleKey = `iphone-${num}-${variantKey}${storage ? `-${storage}` : ''}`;
  const label = `iPhone ${num}${variant ? ' ' + variant.replace(/\b\w/g, c => c.toUpperCase()) : ''}${storage ? ' ' + storage.toUpperCase() : ''}`;
  return { resaleKey, modelLabel: label };
}

function matchIpad(norm) {
  if (!/\bipad\b/.test(norm)) return null;
  const variant = norm.match(/ipad\s*(pro|air|mini)?/);
  const v = (variant?.[1] ?? '').trim();
  const gen = norm.match(/\b(\d{1,2})(?:\s*(?:th|nd|rd|st)?\s*gen|\s*generation)?\b/);
  const storage = extractStorage(norm);
  const parts = ['ipad', v || null].filter(Boolean);
  const key = parts.join('-') + (storage ? `-${storage}` : '');
  const label = `iPad${v ? ' ' + v.replace(/\b\w/g, c => c.toUpperCase()) : ''}${storage ? ' ' + storage.toUpperCase() : ''}`;
  return { resaleKey: key, modelLabel: label };
}

function matchMacbook(norm) {
  if (!/\bmacbook\b/.test(norm)) return null;
  const line = norm.match(/macbook\s*(air|pro)?/);
  const l = (line?.[1] ?? '').trim();
  // Apple silicon chip is the dominant price driver.
  const chip = norm.match(/\bm([1-4])\s*(pro|max|ultra)?\b/);
  const chipKey = chip ? `m${chip[1]}${chip[2] ? '-' + chip[2] : ''}` : null;
  const size = norm.match(/\b(13|14|15|16)\b/);
  const parts = ['macbook', l || null, chipKey].filter(Boolean);
  const key = parts.join('-');
  const label = `MacBook${l ? ' ' + l.replace(/\b\w/g, c => c.toUpperCase()) : ''}${chip ? ' M' + chip[1] + (chip[2] ? ' ' + chip[2].toUpperCase() : '') : ''}${size ? ' ' + size[1] + '"' : ''}`;
  return { resaleKey: key, modelLabel: label };
}

function matchAirpods(norm) {
  if (!/\bairpods\b/.test(norm)) return null;
  if (/\bmax\b/.test(norm)) return { resaleKey: 'airpods-max', modelLabel: 'AirPods Max' };
  if (/\bpro\b/.test(norm)) {
    const gen = /\b2\b|2nd|gen\s*2|usb\s*c/.test(norm) ? '2' : '1';
    return { resaleKey: `airpods-pro-${gen}`, modelLabel: `AirPods Pro ${gen}` };
  }
  const gen = norm.match(/airpods\s*(\d)/);
  const g = gen?.[1] ?? '';
  return { resaleKey: `airpods${g ? '-' + g : ''}`, modelLabel: `AirPods${g ? ' ' + g : ''}` };
}

function matchAppleWatch(norm) {
  if (!/apple\s*watch/.test(norm)) return null;
  if (/\bultra\b/.test(norm)) {
    const gen = /\b2\b/.test(norm) ? '2' : '1';
    return { resaleKey: `apple-watch-ultra-${gen}`, modelLabel: `Apple Watch Ultra ${gen}` };
  }
  if (/\bse\b/.test(norm)) return { resaleKey: 'apple-watch-se', modelLabel: 'Apple Watch SE' };
  const series = norm.match(/series\s*(\d{1,2})/);
  if (series) return { resaleKey: `apple-watch-series-${series[1]}`, modelLabel: `Apple Watch Series ${series[1]}` };
  return null;
}

function matchGpu(norm) {
  // A bare graphics card only; reject whole PCs/laptops and CPU+GPU builds so a
  // card is never priced against a complete system.
  if (!looksLikeBareComponent(norm, { partType: 'gpu' })) return null;
  // NVIDIA GeForce RTX/GTX
  const rtx = norm.match(/\b(?:rtx|gtx)\s*(\d{3,4})\s*(ti\s*super|super|ti)?/);
  if (rtx) {
    const variant = (rtx[2] ?? '').replace(/\s+/g, ' ').trim();
    const prefix = norm.includes('gtx') ? 'gtx' : 'rtx';
    const vKey = variant ? '-' + variant.replace(/\s+/g, '-') : '';
    return { resaleKey: `${prefix}-${rtx[1]}${vKey}`, modelLabel: `${prefix.toUpperCase()} ${rtx[1]}${variant ? ' ' + variant.toUpperCase() : ''}` };
  }
  // AMD Radeon RX
  const rx = norm.match(/\brx\s*(\d{3,4})\s*(xtx|xt|gre)?/);
  if (rx) {
    const variant = (rx[2] ?? '').trim();
    return { resaleKey: `rx-${rx[1]}${variant ? '-' + variant : ''}`, modelLabel: `RX ${rx[1]}${variant ? ' ' + variant.toUpperCase() : ''}` };
  }
  // Intel Arc
  const arc = norm.match(/\barc\s*([ab]\d{3})\b/);
  if (arc) return { resaleKey: `arc-${arc[1]}`, modelLabel: `Arc ${arc[1].toUpperCase()}` };
  return null;
}

function matchConsole(norm) {
  if (/playstation\s*5|\bps5\b/.test(norm)) {
    if (/\bpro\b/.test(norm)) return { resaleKey: 'ps5-pro', modelLabel: 'PlayStation 5 Pro' };
    if (/digital/.test(norm)) return { resaleKey: 'ps5-digital', modelLabel: 'PlayStation 5 Digital' };
    if (/\bslim\b/.test(norm)) return { resaleKey: 'ps5-slim', modelLabel: 'PlayStation 5 Slim' };
    return { resaleKey: 'ps5', modelLabel: 'PlayStation 5' };
  }
  if (/xbox\s*series\s*x/.test(norm)) return { resaleKey: 'xbox-series-x', modelLabel: 'Xbox Series X' };
  if (/xbox\s*series\s*s/.test(norm)) return { resaleKey: 'xbox-series-s', modelLabel: 'Xbox Series S' };
  return null;
}

function matchHandheld(norm) {
  if (/nintendo\s*switch|\bswitch\b/.test(norm)) {
    if (/\b2\b/.test(norm) && /switch\s*2/.test(norm)) return { resaleKey: 'nintendo-switch-2', modelLabel: 'Nintendo Switch 2' };
    if (/oled/.test(norm)) return { resaleKey: 'nintendo-switch-oled', modelLabel: 'Nintendo Switch OLED' };
    if (/lite/.test(norm)) return { resaleKey: 'nintendo-switch-lite', modelLabel: 'Nintendo Switch Lite' };
    return { resaleKey: 'nintendo-switch', modelLabel: 'Nintendo Switch' };
  }
  if (/steam\s*deck/.test(norm)) {
    if (/oled/.test(norm)) return { resaleKey: 'steam-deck-oled', modelLabel: 'Steam Deck OLED' };
    return { resaleKey: 'steam-deck', modelLabel: 'Steam Deck' };
  }
  if (/rog\s*ally/.test(norm)) return { resaleKey: 'rog-ally', modelLabel: 'ROG Ally' };
  return null;
}

function matchCpu(norm) {
  // A bare processor only; reject whole PCs/laptops and CPU+GPU builds.
  if (!looksLikeBareComponent(norm, { partType: 'cpu' })) return null;
  // AMD Ryzen — model number + optional X3D/X suffix is the price driver
  const ryzen = norm.match(/ryzen\s*([3579])\s*(\d{4})\s*(x3d|xt|x|g)?/);
  if (ryzen) {
    const suffix = (ryzen[3] ?? '').trim();
    return {
      resaleKey: `ryzen-${ryzen[1]}-${ryzen[2]}${suffix ? suffix : ''}`,
      modelLabel: `Ryzen ${ryzen[1]} ${ryzen[2]}${suffix ? suffix.toUpperCase() : ''}`
    };
  }
  // Intel Core iX-NNNNN[K/KF/F]
  const intel = norm.match(/\bi([3579])\s*(\d{4,5})\s*(kf|ks|k|f)?/);
  if (intel) {
    const suffix = (intel[3] ?? '').trim();
    return {
      resaleKey: `intel-i${intel[1]}-${intel[2]}${suffix ? suffix : ''}`,
      modelLabel: `Intel i${intel[1]}-${intel[2]}${suffix ? suffix.toUpperCase() : ''}`
    };
  }
  return null;
}

// Ordered dispatch — most specific / least ambiguous first.
const EXTRACTORS = [
  ['Apple — iPhone', matchIphone],
  ['Apple — iPad', matchIpad],
  ['Apple — MacBook', matchMacbook],
  ['Apple — AirPods', matchAirpods],
  ['Apple — Watch', matchAppleWatch],
  ['Graphics cards', matchGpu],
  ['Game consoles', matchConsole],
  ['Handhelds', matchHandheld],
  ['Processors (CPU)', matchCpu]
];

/**
 * Extract a canonical resale model signature from a product title.
 * @returns {{ resaleKey: string, modelLabel: string, demandCategory: string } | null}
 */
export function extractResaleModel(title) {
  const norm = normalize(title);
  if (!norm) return null;
  // Reject accessories outright so a case/charger/strap is never priced as the device.
  if (ACCESSORY_PATTERN.test(norm)) return null;
  // Reject repair services, spare parts, and broken / for-parts listings.
  if (REPAIR_OR_PARTS_PATTERN.test(norm)) return null;
  for (const [demandCategory, extractor] of EXTRACTORS) {
    const result = extractor(norm);
    if (result?.resaleKey) {
      return { ...result, demandCategory };
    }
  }
  return null;
}

/**
 * Build a Blocket resale price index keyed by resaleKey.
 * @param {Array} usedItems items with condition 'used' (Blocket comps)
 * @returns {Map<string, object>}
 */
/**
 * Robust price bounds for a comp bucket using the median absolute deviation
 * (MAD) — resists contamination from a whole-system / mispriced comp that slips
 * past the structural (keyword) filters, so a bare-part median is not skewed.
 * Returns [lo, hi]; a conservative 3.5·MAD window keeps normal variation intact.
 */
function robustPriceBounds(prices) {
  if (prices.length < 4) return [-Infinity, Infinity]; // too few to estimate spread
  const sorted = prices.slice().sort((a, b) => a - b);
  const med = median(sorted);
  const mad = median(sorted.map(p => Math.abs(p - med)).sort((a, b) => a - b));
  if (!mad) return [-Infinity, Infinity]; // identical-ish prices → nothing to trim
  const limit = 3.5 * mad;
  return [med - limit, med + limit];
}

export function buildResaleIndex(usedItems, { resolveModel = extractResaleModel } = {}) {
  const buckets = new Map();

  for (const item of usedItems ?? []) {
    const price = Number(item.latestPriceSek);
    if (!Number.isFinite(price) || price <= 0) continue;
    const model = resolveModel(item.title);
    if (!model) continue;

    let bucket = buckets.get(model.resaleKey);
    if (!bucket) {
      bucket = {
        resaleKey: model.resaleKey,
        modelLabel: model.modelLabel,
        demandCategory: model.demandCategory,
        entries: [] // { price, title, url }
      };
      buckets.set(model.resaleKey, bucket);
    }
    bucket.entries.push({ price, title: item.title, url: item.url ?? null });
  }

  const index = new Map();
  for (const bucket of buckets.values()) {
    const allPrices = bucket.entries.map(e => e.price);
    let [lo, hi] = robustPriceBounds(allPrices);
    let kept = bucket.entries.filter(e => e.price >= lo && e.price <= hi);
    if (kept.length < 3) kept = bucket.entries; // never trim below a usable sample size

    const sorted = kept.map(e => e.price).sort((a, b) => a - b);
    const p25 = sorted[Math.floor((sorted.length - 1) * 0.25)];
    const samples = kept
      .slice()
      .sort((a, b) => a.price - b.price)
      .slice(0, 6)
      .map(e => ({ title: e.title, url: e.url, priceSek: Math.round(e.price) }));

    index.set(bucket.resaleKey, {
      resaleKey: bucket.resaleKey,
      modelLabel: bucket.modelLabel,
      demandCategory: bucket.demandCategory,
      medianSek: median(sorted),
      p25Sek: Math.round(p25),
      minSek: Math.round(sorted[0]),
      maxSek: Math.round(sorted[sorted.length - 1]),
      sampleCount: sorted.length,
      samples
    });
  }
  return index;
}

function blocketSearchUrl(modelLabel) {
  return `https://www.blocket.se/recommerce/forsale/search?q=${encodeURIComponent(modelLabel)}`;
}

/**
 * Compute flip opportunities: buyable items priced below their Blocket median.
 * @param {Array} candidateItems buyable items (e.g. outlet/deal, NOT 'used')
 * @param {Map} index resale index from buildResaleIndex
 * @param {object} options thresholds/fees
 * @returns {Array} flip objects sorted by net profit desc
 */
export function computeFlips(candidateItems, index, options = {}) {
  const opts = { ...DEFAULT_RESALE_OPTIONS, ...options };
  const resolveModel = options.resolveModel ?? extractResaleModel;
  const flips = [];

  for (const item of candidateItems ?? []) {
    const buyPriceSek = Number(item.latestPriceSek);
    if (!Number.isFinite(buyPriceSek) || buyPriceSek <= 0) continue;

    const model = resolveModel(item.title);
    if (!model) continue;
    const market = index.get(model.resaleKey);
    if (!market || market.sampleCount < opts.minSampleCount) continue;
    if (!Number.isFinite(market.medianSek) || market.medianSek <= 0) continue;

    const expectedResaleSek = Math.round(market.medianSek * opts.resaleAdjustFactor);
    const netProfitSek = expectedResaleSek - buyPriceSek - opts.flatFeeSek;
    const roiPercent = Math.round((netProfitSek / buyPriceSek) * 100);

    if (netProfitSek < opts.minNetProfitSek) continue;
    if (roiPercent < opts.minRoiPercent) continue;

    flips.push({
      listingKey: item.listingKey,
      title: item.title,
      url: item.url ?? null,
      imageUrl: item.imageUrl ?? null,
      category: item.category ?? null,
      condition: item.condition ?? null,
      conditionLabel: item.conditionLabel ?? null,
      sourceId: item.sourceId ?? null,
      sourceLabel: item.sourceLabel ?? item.sourceId ?? null,
      availability: item.availability ?? 'unknown',
      firstSeenAt: item.firstSeenAt ?? null,
      lastSeenAt: item.lastSeenAt ?? null,
      resaleKey: model.resaleKey,
      modelLabel: model.modelLabel,
      demandCategory: model.demandCategory,
      buyPriceSek: Math.round(buyPriceSek),
      resaleMedianSek: market.medianSek,
      resaleP25Sek: market.p25Sek,
      expectedResaleSek,
      feesSek: opts.flatFeeSek,
      netProfitSek,
      roiPercent,
      sampleCount: market.sampleCount,
      comps: market.samples,
      blocketSearchUrl: blocketSearchUrl(model.modelLabel)
    });
  }

  return flips.sort((a, b) => {
    if (b.netProfitSek !== a.netProfitSek) return b.netProfitSek - a.netProfitSek;
    return b.roiPercent - a.roiPercent;
  });
}

export { DEFAULT_RESALE_OPTIONS };
