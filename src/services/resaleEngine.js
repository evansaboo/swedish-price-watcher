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
  minRoiPercent: 8,        // floor ROI (profit / buy price)
  // Sanity floor: buying a product for less than this fraction of its used median
  // is implausible for the SAME product and almost always means a category
  // mismatch (a game/accessory/part keyed as the device). Guards against the last
  // noisy titles the structural matcher + LLM miss, with no dependence on the LLM.
  minBuyToResaleRatio: 0.12
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
  'stativ', 'hallare', 'faste', 'tangentbord', 'keyboard', 'fjarrkontroll', 'pencil',
  'gamepad', 'grepp', 'handkontroll', 'stylus', 'penna', 'crayon',
  // folio cases / watch bands ("Leather Folio", "Alpine Loop"/"Bergsloop", "Sportloop")
  'folio', 'loop',
  // wallet / folio cases ("mobilplånbok", "plånboksfodral")
  'planbok', 'holster', 'korthallare',
  // wearables straps (Apple Watch etc.)
  'armband', 'sportband', 'milanese'
].join('|') + ')\\b');

// Accessory-only HOUSE BRANDS. These makers sell ONLY cases, covers, chargers,
// screen protectors, stands, keyboards and similar add-ons — never the phone /
// tablet / laptop / GPU / console themselves. A title carrying one of these brands
// alongside a device name (e.g. "Linocell Slim Swivel iPad (A16)", which has no
// "case"/"fodral" word and would otherwise slip through ACCESSORY_PATTERN) is an
// accessory FOR that device and must never be priced as the device. High-precision:
// none of these brands manufacture the actual hardware, so this can't reject a real
// device. Matched as whole words against the normalized title.
const ACCESSORY_BRAND_PATTERN = new RegExp('\\b(?:' + [
  'linocell', 'dbramante', 'dbramante1928', 'zagg', 'belkin', 'onsala', 'deltaco',
  'otterbox', 'nudient', 'panzerglass', 'holdit', 'la vie', 'targus', 'gear4',
  'satechi', 'mophie', 'kensington', 'uag', 'spigen', 'twelve south', 'tech21',
  'pipetto', 'rhinoshield', 'dux ducis', 'cellularline', 'sandberg', 'estuff',
  'champion', 'puro', 'gripcase', 'speck'
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

// Console / handheld GAMES, accessories and peripherals share the platform name
// (PlayStation / Xbox / Switch / Steam Deck) with the actual hardware, so they
// would otherwise be mis-keyed as the console itself — pricing a 300 kr game or a
// 150 kr Joy-Con grip against a 5 000 kr console and inventing phantom profit.
// These signals are HIGH-PRECISION for "this is NOT the hardware" and are applied
// ONLY to the Game-console / Handheld categories (never to GPU / CPU / Apple), so a
// barcode or a "(PS5)" platform tag in an unrelated title cannot cause a false
// rejection elsewhere. Any genuine console wrongly caught here is recovered by the
// LLM gap-filler, which re-keys real hardware from its cleaned label.
const PAREN_PLATFORM_PATTERN = /\((?:ps[45]|playstation|xbox|switch|nintendo|pc|wii)\b[^)]*\)/i;
const EAN_CODE_PATTERN = /\b\d{12,13}\b/;
// Wanted-to-buy ("sökes" / "köpes") listings are requests, not real sale prices.
const WANTED_LISTING_PATTERN = /\bsokes\b|\bkopes\b/;
const GAME_WORD_PATTERN = /\bspel(?:et|en)?\b/;
const CONSOLE_GAME_OR_PERIPHERAL_PATTERN = new RegExp([
  // game wording — gated by konsol below so "spelkonsol" (game console) stays IN
  '\\bspel(?:et|en)?\\b',
  // peripheral / accessory nouns (Swedish noun is last → suffix-match where needed)
  '\\bhandkontroll', '\\bkontroll', '\\bcontroller\\b', '\\bgamepad',
  'joy ?con', '\\bdualsense\\b', '\\bdualshock\\b',
  '[a-z]*ratt\\b', '\\bwheel\\b', '[a-z]*grepp\\b', '[a-z]*headset\\b', '\\bhorlur',
  '\\bhogtalare\\b', '\\bmikrofon\\b', '\\bkamera\\b',
  'ladd(?:nings)?(?:station|stall|stativ)', '\\bbatteripack\\b',
  '[a-z]*forvaring\\b', '\\bremmar\\b', '\\btumspak\\b', 'arcade ?stick', '\\bhitbox\\b',
  'nitro deck', 'dock(?:nings)?(?:set|station)?\\b', 'leg strap',
  'microsd', '\\bminneskort\\b', 'minnes kort', '\\bexpress kort\\b',
  '\\bssd\\b', 'game drive', 'extern ssd', '\\bskruv', '\\bscrews\\b',
  'console cover', '[a-z]*holje', '\\bfaceplate\\b', 'vertical stand', '\\bstand\\b', '\\bstall\\b',
  // game-only editions / genres
  'day one edition', 'launch edition', '\\bcollector', '\\bgoty\\b', 'code in a box',
  '\\bsteelbook\\b', 'deluxe edition', 'premium edition', 'master edition', 'standard edition',
  '\\brpg\\b', '\\brollspel\\b', '\\bkampsport\\b',
  // peripheral-only brands (these makers sell accessories, never the console)
  '\\bpiranha\\b', '\\bpowera\\b', '\\bnacon\\b', '8bitdo', 'turtle beach', '\\bsteelseries\\b',
  '\\bdeltaco\\b', '\\bbionik\\b', '\\bhori\\b', 'kontrolfreek', 'king controller', '\\bcrkd\\b',
  '\\bfanatec\\b', '\\bkonix\\b', '\\bhyperkin\\b', '\\bpdp\\b', '\\brazer\\b', '\\bthrustmaster\\b',
  '\\btrust\\b', '\\bsnakebyte\\b', '\\bsubsonic\\b', '\\bgioteck\\b', '\\bvenom\\b', '\\bscuf\\b',
  '\\bvictrix\\b', '\\bgamesir\\b', '\\bipega\\b', '\\bseagate\\b', '\\bsandisk\\b',
  // game-only publishers (console makers — sony / microsoft / nintendo / asus / valve — excluded)
  '\\bubisoft\\b', '\\bplaion\\b', '\\bfromsoftware\\b', '\\bbethesda\\b', '\\bcapcom\\b',
  '\\bbandai\\b', '\\bnamco\\b', 'square enix', 'take two', '\\brockstar\\b', '\\bdevolver\\b',
  '\\bkoei\\b', '\\batlus\\b', 'deep silver', '\\bthq\\b'
].join('|'));

// True when a console/handheld title is actually a game, accessory or peripheral.
function looksLikeConsoleGameOrPeripheral(rawTitle, norm) {
  if (PAREN_PLATFORM_PATTERN.test(rawTitle)) return true;
  if (EAN_CODE_PATTERN.test(norm)) return true;
  if (WANTED_LISTING_PATTERN.test(norm)) return true;
  if (!CONSOLE_GAME_OR_PERIPHERAL_PATTERN.test(norm)) return false;
  // "spelkonsol" (game console) is real hardware: if the game-word is the only
  // signal AND the title also says "konsol", re-test without it before rejecting.
  if (GAME_WORD_PATTERN.test(norm) && /konsol/.test(norm)) {
    return CONSOLE_GAME_OR_PERIPHERAL_PATTERN.test(norm.replace(GAME_WORD_PATTERN, ' '));
  }
  return true;
}

// Title-only wrapper so the LLM layer can refuse to "recover" a console game /
// peripheral title into the bare console (e.g. "NBA 2K23 (Xbox Series X)" → the
// game name stripped to "Xbox Series X"). Mirrors looksLikeAccessoryOrRepair.
export function looksLikeConsoleGameOrPeripheralTitle(title) {
  const raw = String(title ?? '');
  const norm = normalize(raw);
  if (!norm) return false;
  return looksLikeConsoleGameOrPeripheral(raw, norm);
}

// Vocabulary that legitimately appears in a *bare console/handheld* listing:
// the platform name, configuration/condition/colour words, storage, packaging,
// bundled controllers/cables, and generic selling chatter. A REAL console title
// is essentially the console name plus only these filler words; a GAME or an
// ACCESSORY listing additionally carries a game name or product noun (e.g. "Evil
// Dead", "Mario Tennis", "Portal", "TMR"). So if any non-filler "content" token
// survives, the title is NOT the bare console and must not be priced as one. This
// is deterministic and high-precision — it does NOT depend on the (unreliable)
// LLM to tell a 99 kr game apart from a 5 000 kr console.
const CONSOLE_HARDWARE_FILLER = new Set([
  // platform identity
  'playstation', 'ps', 'ps5', 'ps4', 'xbox', 'series', 'nintendo', 'switch',
  'sony', 'microsoft', 'steam', 'deck', 'rog', 'ally', 'valve', 'asus', 'x', 's',
  'handhallen', 'handhall', 'handhallna', 'handheld', 'barbar',
  // variants / config
  'pro', 'slim', 'digital', 'disc', 'edition', 'standard', 'version', 'modell',
  'model', 'generation', 'gen', 'basenhet', 'basmodell', 'oled', 'lite', 'fat', 'v1', 'v2',
  // hardware nouns
  'konsol', 'spelkonsol', 'console', 'spelkonsoll',
  // colours
  'vit', 'svart', 'bla', 'gra', 'gron', 'rod', 'roda', 'rosa', 'lila', 'gul', 'beige',
  'white', 'black', 'blue', 'grey', 'gray', 'red', 'green', 'pink', 'farg', 'fargen', 'fargad',
  'korall', 'coral', 'turkos', 'orange', 'guld', 'gold', 'silver', 'lavendel', 'lavender', 'neon',
  // condition
  'ny', 'nytt', 'nya', 'nyskick', 'skick', 'fin', 'fint', 'fina', 'bra', 'toppskick',
  'topskick', 'mint', 'helt', 'hel', 'som', 'oanvand', 'oanvant', 'oppnad', 'oppen',
  'begagnad', 'begagnat', 'anvand', 'anvande', 'snygg', 'snyggt', 'prima', 'topp',
  'perfekt', 'perfekta', 'fungerar', 'fungerande', 'funkar', 'renoverad',
  // packaging / warranty
  'kvitto', 'kvitton', 'garanti', 'kartong', 'originalkartong', 'originalforpackning',
  'forpackning', 'forpackad', 'org', 'originalet', 'original', 'originalkartongen',
  'inplastad', 'forseglad', 'plomberad', 'plomb', 'lada', 'box', 'medfoljer', 'medfoljande',
  // bundle / accessory filler (a console may include these)
  'med', 'och', 'utan', 'inkl', 'inklusive', 'tillbehor', 'tillbehoren', 'komplett',
  'paket', 'bundle', 'extra', 'plus', 'samt', 'st', 'stycken', 'par', 'sett', 'set',
  'allt', 'alla', 'originalkablar', 'kablar', 'kabel', 'laddare', 'strom', 'stromkabel', 'hdmi',
  // controllers / cables included with a console
  'handkontroll', 'handkontroller', 'kontroll', 'kontroller', 'controller', 'controllers',
  'dualsense', 'dualshock', 'joycon', 'joy', 'con', 'tradlos', 'tradlosa',
  // generic selling chatter
  'saljes', 'saljs', 'salja', 'saljer', 'min', 'mitt', 'mina', 'fynd', 'fyndvara', 'rea',
  'billig', 'billigt', 'billigare', 'i', 'till', 'for', 'av', 'en', 'ett', 'den', 'det',
  'mycket', 'super', 'snabb', 'snabbt', 'affar', 'finns', 'kop', 'kopt', 'kopes', 'direkt',
  'privat', 'spel', 'spelet', 'samtliga', 'knappt', 'nastan', 'endast', 'bara', 'ovrigt',
  'm', 'gb', 'tb'
]);
const CONSOLE_STORAGE_TOKEN = /^\d+(?:gb|tb)$/;

// True when a console/handheld title is the BARE hardware (no leftover game/extra
// product tokens) — see CONSOLE_HARDWARE_FILLER. Used to keep games/accessories
// that merely mention the platform out of the console comp/candidate index.
function looksLikeConsoleHardware(norm) {
  for (const t of norm.split(/\s+/)) {
    if (t.length < 2) continue;                 // single letters (x, s, i) are platform/filler
    if (/^\d+$/.test(t)) continue;              // bare numbers (generation, year, count)
    if (CONSOLE_STORAGE_TOKEN.test(t)) continue; // 1tb / 512gb
    if (!CONSOLE_HARDWARE_FILLER.has(t)) return false; // a real content word → not bare hardware
  }
  return true;
}

// True when a title names a console/handheld PLATFORM at all (hardware, game or
// accessory). Such titles can only ever resolve to a console/handheld, which is
// now decided deterministically by the hardware gate above — so the (unreliable)
// LLM has nothing to add and they can be skipped during enrichment.
const LOW_PRECISION_PLATFORM_PATTERN =
  /\b(?:ps5|ps4|playstation|xbox|nintendo|steam\s*deck|rog\s*ally)\b|\bswitch\b/;
export function mentionsLowPrecisionPlatform(title) {
  const norm = normalize(title);
  return !!norm && LOW_PRECISION_PLATFORM_PATTERN.test(norm);
}

// ── Per-category extractors ────────────────────────────────────
// Each returns { resaleKey, modelLabel } or null. demandCategory is attached
// by the dispatcher below.
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
  // "switch" alone is dangerously generic — HDMI/network/KVM/dimmer/light/Scart
  // switches must NOT be keyed as a Nintendo Switch. Require Nintendo context or a
  // Switch-console qualifier (model/variant/Joy-Con) before treating it as the console.
  const isNintendoSwitch =
    /nintendo\s*switch/.test(norm) ||
    (/\bswitch\b/.test(norm) && (
      /nintendo/.test(norm) ||
      /switch\s*2\b|switch\s*(?:oled|lite)|\b(?:oled|lite)\s*switch|joy ?con|spelkonsol/.test(norm)
    ));
  if (isNintendoSwitch) {
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

// ── Additional high-demand resale categories ───────────────────
// All are HIGH-PRECISION (brand + model number are deterministic), so they
// bypass the LLM gap-filler like the Apple/GPU/CPU extractors. Accessories
// (cases, chargers, mounts, bands, screen protectors) are already rejected
// globally by ACCESSORY_PATTERN / ACCESSORY_BRAND_PATTERN / REPAIR_OR_PARTS_PATTERN
// before any extractor runs; a few category-specific peripherals (filters, straps)
// are guarded inline below.
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function matchSamsungGalaxyPhone(norm) {
  if (!/\bgalaxy\b/.test(norm)) return null;
  // A phone + watch bundle ("Galaxy S24 Ultra … med Galaxy Watch") is ambiguous and
  // priced higher than the bare phone — reject it (the watch matcher rejects it too).
  if (/galaxy\s*watch/.test(norm)) return null;
  const storage = extractStorage(norm);
  // Foldables: Galaxy Z Fold / Z Flip (optional generation).
  const z = norm.match(/\bz\s*(fold|flip)\s*(\d{1,2})?/);
  if (z) {
    const gen = z[2] ?? '';
    return {
      resaleKey: `galaxy-z-${z[1]}${gen ? '-' + gen : ''}${storage ? '-' + storage : ''}`,
      modelLabel: `Galaxy Z ${titleCase(z[1])}${gen ? ' ' + gen : ''}${storage ? ' ' + storage.toUpperCase() : ''}`
    };
  }
  // Note series (older flagships, still high demand).
  const note = norm.match(/\bnote\s*(\d{1,2})/);
  if (note) {
    const ultra = /\bultra\b/.test(norm) ? '-ultra' : '';
    return {
      resaleKey: `galaxy-note-${note[1]}${ultra}${storage ? '-' + storage : ''}`,
      modelLabel: `Galaxy Note ${note[1]}${ultra ? ' Ultra' : ''}${storage ? ' ' + storage.toUpperCase() : ''}`
    };
  }
  // S series: "galaxy s22", "galaxy s24 ultra", "galaxy s23 fe".
  const s = norm.match(/galaxy\s*s\s*(\d{1,2})\b/);
  if (s) {
    const num = s[1];
    const variant = /\bultra\b/.test(norm) ? 'ultra'
      : /\bfe\b/.test(norm) ? 'fe'
      : /\bplus\b/.test(norm) ? 'plus' : 'base';
    const vLabel = variant === 'base' ? '' : ' ' + titleCase(variant === 'fe' ? 'FE' : variant);
    return {
      resaleKey: `galaxy-s${num}-${variant}${storage ? '-' + storage : ''}`,
      modelLabel: `Galaxy S${num}${vLabel}${storage ? ' ' + storage.toUpperCase() : ''}`
    };
  }
  return null;
}

function matchSamsungGalaxyTab(norm) {
  const m = norm.match(/galaxy\s*tab\s*([sa])\s*(\d{1,2})\s*(ultra|plus|fe|lite)?/);
  if (!m) return null;
  const series = m[1].toUpperCase();
  const num = m[2];
  const variant = (m[3] ?? '').trim();
  const storage = extractStorage(norm);
  const vKey = variant ? '-' + variant : '';
  return {
    resaleKey: `galaxy-tab-${series.toLowerCase()}${num}${vKey}${storage ? '-' + storage : ''}`,
    modelLabel: `Galaxy Tab ${series}${num}${variant ? ' ' + titleCase(variant) : ''}${storage ? ' ' + storage.toUpperCase() : ''}`
  };
}

function matchSamsungGalaxyWatch(norm) {
  if (!/galaxy\s*watch/.test(norm)) return null;
  // A phone+watch bundle ("Galaxy S24 Ultra … med Galaxy Watch") is dominated by
  // the phone's price — never key it as the watch alone.
  if (/galaxy\s*(?:s\d|z\s*(?:flip|fold)|note)/.test(norm)) return null;
  const size = norm.match(/\b(40|42|43|44|45|46|47)\s*mm\b/);
  const sizeKey = size ? `-${size[1]}mm` : '';
  const sizeLabel = size ? ` ${size[1]}mm` : '';
  if (/\bultra\b/.test(norm)) {
    return { resaleKey: `galaxy-watch-ultra${sizeKey}`, modelLabel: `Galaxy Watch Ultra${sizeLabel}` };
  }
  const m = norm.match(/galaxy\s*watch\s*(\d{1,2})?\s*(classic|active\s*2|active|pro|fe)?/);
  const gen = m?.[1] ?? '';
  const variant = (m?.[2] ?? '').replace(/\s+/g, ' ').trim();
  const vKey = variant ? '-' + variant.replace(/\s+/g, '') : '';
  return {
    resaleKey: `galaxy-watch${gen ? '-' + gen : ''}${vKey}${sizeKey}`,
    modelLabel: `Galaxy Watch${gen ? ' ' + gen : ''}${variant ? ' ' + titleCase(variant) : ''}${sizeLabel}`
  };
}

function matchPixel(norm) {
  const m = norm.match(/\bpixel\s*(\d{1,2})\s*(pro\s*xl|pro|xl|a)?/);
  if (!m) return null;
  const num = m[1];
  const variant = (m[2] ?? '').replace(/\s+/g, ' ').trim();
  const storage = extractStorage(norm);
  const vKey = variant ? '-' + variant.replace(/\s+/g, '-') : '';
  return {
    resaleKey: `pixel-${num}${vKey}${storage ? '-' + storage : ''}`,
    modelLabel: `Pixel ${num}${variant ? ' ' + titleCase(variant) : ''}${storage ? ' ' + storage.toUpperCase() : ''}`
  };
}

function matchHeadphones(norm) {
  // Sony WH-1000XM / WF-1000XM (over-ear / in-ear premium ANC).
  const sony = norm.match(/\bw([hf])\s*1000\s*xm\s*(\d)\b/);
  if (sony) {
    const type = sony[1] === 'h' ? 'wh' : 'wf';
    return { resaleKey: `sony-${type}-1000xm${sony[2]}`, modelLabel: `Sony ${type.toUpperCase()}-1000XM${sony[2]}` };
  }
  // Bose QuietComfort Ultra (headphones vs earbuds) and numbered QuietComfort.
  if (/bose\s*(?:quietcomfort|qc)\s*ultra/.test(norm)) {
    const earbuds = /earbud|in.?ear|oortelefoon|proppar/.test(norm) ? '-earbuds' : '';
    return { resaleKey: `bose-qc-ultra${earbuds}`, modelLabel: `Bose QuietComfort Ultra${earbuds ? ' Earbuds' : ''}` };
  }
  const qc = norm.match(/bose\s*(?:quietcomfort|qc)\s*(\d{1,2})/);
  if (qc) return { resaleKey: `bose-qc-${qc[1]}`, modelLabel: `Bose QuietComfort ${qc[1]}` };
  return null;
}

function matchDyson(norm) {
  if (!/\bdyson\b/.test(norm)) return null;
  // Reject Dyson spare parts / accessories that share the model name.
  if (/[a-z]*filter\b|munstycke|borste|borsthuvud|golvmunstycke|vaggfaste|vaggdocka|laddstation|dockningsstation|tillbehor|reservdel|\bbatteri\b|\bdok\b/.test(norm)) return null;
  // Hair-care tools.
  if (/airwrap/.test(norm)) return { resaleKey: 'dyson-airwrap', modelLabel: 'Dyson Airwrap' };
  if (/supersonic/.test(norm)) return { resaleKey: 'dyson-supersonic', modelLabel: 'Dyson Supersonic' };
  if (/corrale/.test(norm)) return { resaleKey: 'dyson-corrale', modelLabel: 'Dyson Corrale' };
  if (/airstrait/.test(norm)) return { resaleKey: 'dyson-airstrait', modelLabel: 'Dyson Airstrait' };
  // Cordless stick vacuums.
  const v = norm.match(/\bv(7|8|10|11|12|15)\b/);
  if (v) return { resaleKey: `dyson-v${v[1]}`, modelLabel: `Dyson V${v[1]}` };
  if (/\bgen\s*5\b|\bgen5\b/.test(norm)) return { resaleKey: 'dyson-gen5', modelLabel: 'Dyson Gen5' };
  return null;
}

function matchMetaQuest(norm) {
  if (!/(?:meta|oculus)\s*quest|\bquest\s*[23]\b/.test(norm)) return null;
  // Reject Quest straps / facial interfaces / controllers / lenses.
  if (/elite.?rem|\brem\b|pannband|head\s*strap|\bstrap\b|controller|kontroller|\bgrepp|link\s*kabel|\bcable\b|ansikt|facial|interface|mask\b|granssnitt|vaddering|\btyg\b|overdrag|laddstation|laddningsstation|charge|\bstation\b|\bmount\b|lins(?:er)?\b|prescription|skyddsglas/.test(norm)) return null;
  if (/quest\s*3s/.test(norm)) {
    const storage = extractStorage(norm);
    return { resaleKey: `meta-quest-3s${storage ? '-' + storage : ''}`, modelLabel: `Meta Quest 3S${storage ? ' ' + storage.toUpperCase() : ''}` };
  }
  const m = norm.match(/quest\s*(\d)/);
  const gen = m ? m[1] : '';
  const storage = extractStorage(norm);
  return {
    resaleKey: `meta-quest${gen ? '-' + gen : ''}${storage ? '-' + storage : ''}`,
    modelLabel: `Meta Quest${gen ? ' ' + gen : ''}${storage ? ' ' + storage.toUpperCase() : ''}`
  };
}

function matchMacDesktop(norm) {
  // Apple silicon desktops: Mac mini, Mac Studio, iMac. Chip is the price driver.
  let line = null;
  if (/\bmac\s*mini\b/.test(norm)) line = { key: 'mac-mini', label: 'Mac mini' };
  else if (/\bmac\s*studio\b/.test(norm)) line = { key: 'mac-studio', label: 'Mac Studio' };
  else if (/\bimac\b/.test(norm)) line = { key: 'imac', label: 'iMac' };
  if (!line) return null;
  const chip = norm.match(/\bm([1-4])\s*(pro|max|ultra)?\b/);
  const chipKey = chip ? `-m${chip[1]}${chip[2] ? '-' + chip[2] : ''}` : '';
  const chipLabel = chip ? ` M${chip[1]}${chip[2] ? ' ' + titleCase(chip[2]) : ''}` : '';
  return { resaleKey: `${line.key}${chipKey}`, modelLabel: `${line.label}${chipLabel}` };
}

// Ordered dispatch — most specific / least ambiguous first.
const EXTRACTORS = [
  ['Apple — iPhone', matchIphone],
  ['Apple — iPad', matchIpad],
  ['Apple — MacBook', matchMacbook],
  ['Apple — Mac desktop', matchMacDesktop],
  ['Apple — AirPods', matchAirpods],
  ['Apple — Watch', matchAppleWatch],
  ['Samsung — Galaxy Tab', matchSamsungGalaxyTab],
  ['Samsung — Galaxy Watch', matchSamsungGalaxyWatch],
  ['Samsung — Galaxy phone', matchSamsungGalaxyPhone],
  ['Google Pixel', matchPixel],
  ['Headphones', matchHeadphones],
  ['Dyson', matchDyson],
  ['VR — Meta Quest', matchMetaQuest],
  ['Graphics cards', matchGpu],
  ['Game consoles', matchConsole],
  ['Handhelds', matchHandheld],
  ['Processors (CPU)', matchCpu]
];

/**
 * Extract a canonical resale model signature from a product title.
 * @returns {{ resaleKey: string, modelLabel: string, demandCategory: string } | null}
 */
// Memoized: extractResaleModel is a pure function of the title (only module-level
// constant regexes / pure helpers), but it's regex-heavy and runs over every flip
// candidate (~25k) on every product-cache rebuild. Cache by title so repeated
// rebuilds reuse the result instead of re-running the extractors each time.
const _resaleModelMemo = new Map();

export function extractResaleModel(title) {
  const key = String(title ?? '');
  const cached = _resaleModelMemo.get(key);
  if (cached !== undefined) return cached;
  const result = extractResaleModelImpl(key);
  // Bound memory on very long-lived processes; titles churn slowly so this is rare.
  if (_resaleModelMemo.size > 100000) _resaleModelMemo.clear();
  _resaleModelMemo.set(key, result);
  return result;
}

function extractResaleModelImpl(title) {
  const norm = normalize(title);
  if (!norm) return null;
  // Reject accessories outright so a case/charger/strap is never priced as the device.
  if (ACCESSORY_PATTERN.test(norm)) return null;
  // Reject accessory-only house brands (Linocell/Spigen/etc.) — never the device.
  if (ACCESSORY_BRAND_PATTERN.test(norm)) return null;
  // Reject repair services, spare parts, and broken / for-parts listings.
  if (REPAIR_OR_PARTS_PATTERN.test(norm)) return null;
  for (const [demandCategory, extractor] of EXTRACTORS) {
    const result = extractor(norm);
    if (result?.resaleKey) {
      // Console/handheld titles share the platform name with games & peripherals;
      // reject those so they are never priced as the hardware itself. ALSO require
      // the title to look like the BARE console (no leftover game/extra tokens) so
      // a 99 kr game or a 150 kr accessory that merely names the platform never
      // pollutes the console comp/candidate index.
      if (demandCategory === 'Game consoles' || demandCategory === 'Handhelds') {
        if (looksLikeConsoleGameOrPeripheral(String(title ?? ''), norm)) return null;
        if (!looksLikeConsoleHardware(norm)) return null;
      }
      return { ...result, demandCategory };
    }
  }
  return null;
}

/**
 * High-precision structural rejection: true when a title is unambiguously NOT a
 * resellable device — an accessory/peripheral or a repair-service/spare-part/
 * for-parts listing. Exported so the LLM gap-filler can REFUSE to "recover" such
 * titles: otherwise the LLM might strip the accessory word ("Linocell Swivel
 * Case för iPad Pro" → "iPad Pro") and re-key it as the device, defeating this
 * deterministic guard. The LLM may only ever clean genuinely ambiguous titles.
 */
export function looksLikeAccessoryOrRepair(title) {
  const norm = normalize(title);
  if (!norm) return false;
  return ACCESSORY_PATTERN.test(norm) || ACCESSORY_BRAND_PATTERN.test(norm) || REPAIR_OR_PARTS_PATTERN.test(norm);
}

/**
 * True when a title describes a complete system / laptop / build rather than a
 * bare component. Used to VETO LLM gap-fill recovery: small local models often
 * "clean" a build title ("Gamingdator RTX 5070 Ryzen 7", "Gigabyte gaming laptop
 * … RTX 5070") down to a bare-card label ("RTX 5070"), which would re-key as a
 * bare GPU and pollute its comp index with whole-build prices. The deterministic
 * build guard (looksLikeBareComponent) already rejects these, so the LLM must
 * never override it. Mirrors looksLikeAccessoryOrRepair.
 */
export function looksLikeSystemOrBuild(title) {
  const norm = normalize(title);
  if (!norm) return false;
  if (SYSTEM_OR_LAPTOP_PATTERN.test(norm)) return true;
  if (HAS_GPU_TOKEN.test(norm) && HAS_CPU_TOKEN.test(norm)) return true; // CPU+GPU bundle
  return false;
}

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
    // Implausibly cheap "buy" vs the used median ⇒ category mismatch, not a deal.
    if (buyPriceSek < market.medianSek * opts.minBuyToResaleRatio) continue;

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
