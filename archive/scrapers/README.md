# Archived scrapers

These scan sources were retired on **2026-10-31**. The app now covers only the
Elgiganten hotlist, the Komplett demo watcher and the NVIDIA FE tracker. The code
is kept here as a reference for building new scrapers. Nothing in `src/` imports
it, and `npm test` (`node --test test/`) doesn't run the tests in `tests/`.

- **Config:** each source's last `config/sources.json` entry is in
  `sources.archived.json`.
- **History:** files were moved with `git mv`, so `git log --follow archive/scrapers/<file>`
  shows their history.
- **Data:** the products these sources collected are still in SQLite (the `items`
  table). The app keeps them as inactive items and doesn't delete them; the
  dashboard just doesn't show them.

## Lessons that apply to any new scraper

- **Fixed-interval polling gets you blocked.** By late 2026, Komplett (Akamai) and
  NVIDIA's store (Akamai) blocked the Pi's home IP (Telia) and the NordVPN SOCKS
  proxy at connection level: the TLS connection opens, then nothing comes back or
  it returns 403. Elgiganten answers a bare `curl` with 429. Use randomised
  intervals with backoff on 403/429, and fetch as little as possible.
- **Choosing the fetch path, cheapest first:**
  1. A JSON API the site's own frontend uses (Power, Kjell, Webhallen, Blocket,
     Elgiganten's Algolia).
  2. Server-rendered HTML with embedded JSON (Komplett, Inet, NetOnNet, Dustin).
  3. A real browser via FlareSolverr (the `flaresolverr` container on :8191),
     ScraperAPI or Scrapfly, for Cloudflare Bot Management (ProShop,
     SweClockers, Dustin).
  4. An Apify actor run from Apify's IPs when our IP is blocked. On the FREE plan
     Apify can't proxy our own requests ("proxy external access" is disabled);
     only actor runs work. A 1-page `apify/cheerio-scraper` run with 256 MB
     costs about $0.0004.
- **Incremental scanning** (`lib/incremental.js`): stop paginating after N pages
  in a row with only known items. This only works when the listing order is
  stable (newest first).

## The sources

| id | Site / what | Technique | Notes and last known status |
|---|---|---|---|
| `elgiganten-outlet` (`elgiganten.js`) | Elgiganten B-grade outlet, ~13k products | Public Algolia search key, filter `productTaxonomy.id:PT793`; `price.amount` is the outlet price, `bItem.aItemPrice` the new price | Algolia caps any query at 1500 hits (`paginationLimitedTo`), so it splits by brand (607 brands). Images: rewrite `next-media.elkjop.com` → `media.elkjop.com/assets/image/{blobId}`. Last OK 2026-08-27. |
| `elgiganten-campaigns` (`elgigantenCampaigns.js`) | Elgiganten weekly and store campaigns | Same Algolia index; discovers campaign IDs from facets each scan (`W`/`S`/`R` types) | Last error: "failed to obtain Algolia API key… blocked". Last OK 2026-08-26. |
| `elgiganten-outlet-legacy` (`apifyElgiganten.js`) | Elgiganten outlet search | Apify actor, keeps URLs under `/product/outlet/` | Disabled before archiving; replaced by the Algolia source. |
| `amazon-hotlist` (`amazonHotlist.js`, `amazonPaapi.js`) | Amazon.se targeted hotlist | Search pages with pct-off filters for the hotlist watch groups; Playwright fallback; PA-API v5 client (SigV4 via `node:crypto`); suggestions from `completion.amazon.se` | The hotlist now covers Elgiganten only. Watches saved as Amazon-only show a note in the dashboard. |
| `komplett-outlet-electronics` (`komplettCategory.js`) | Komplett demovaror, all categories | Apify cheerio-scraper; each page embeds `"products":[…]` JSON (24/page) | **`&page=N` doesn't page**: it returns page 0 again, so the 10-page loop fetched page 1 ten times. `?sort=ReleaseDateDesc` (newest first) works. Replaced by the Komplett demo watcher (`src/services/komplettDemoPoller.js`). |
| `netonnet-outlet` (`netonnet.js`) | NetOnNet `/art/outlet` + `/art/fyndvaror`, ~1200 products | RSC HTML parsing | Blocks non-browser user agents; send a real browser UA. Last OK 2026-08-26. |
| `webhallen-fyndware`, `webhallen-toplist-deals` (`webhallen.js`) | Webhallen Fyndvaror (~1950), toplist 64 deals (~1700) | Internal `productdiscovery/search/fyndware` and `toplist/64` APIs, 100/page | No bypass needed. Last OK 2026-08-26. |
| `power-deals`, `power-campaigns` (`power.js`) | Power outlet/returns, and campaign markdowns | REST `/api/v2/productlists?s=5&o=true&cd=false` (`o=false` for campaigns) | Returns about 1.65× the requested `size`; advance `from=` by the actual count. Last OK 2026-08-26. |
| `kjell-outlet` (`kjell.js`) | Kjell & Company outlet, ~3300 products | `kjell.com/se/outlet` returns JSON when sent XHR headers (`accept: application/json`, `x-requested-with`), 60/page | Last OK 2026-07-30. |
| `inet-fyndhornan` (`inet.js`) | Inet Fyndhörnan, ~400 products | Server-rendered React; hydrate JSON in script tags (Apify cheerio or direct) | Last OK 2026-08-26. |
| `proshop-outlet` (`proshop.js`) | ProShop outlet + demo | Cloudflare BM: FlareSolverr → ScraperAPI (`render=true`, 5 credits/page) → Scrapfly (`lib/bypassFetch.js`) | Last OK 2026-06-21. |
| `sweclockers-dagensfynd` (`sweclockers.js`) | SweClockers community deals | Same bypass chain as ProShop | Last OK 2026-07-30. |
| `dustin-fyndvaror` (`dustin.js`) | Dustin Home fyndvaror | Hard 403s on direct requests; needs a bypass. Parses embedded `"searchResultProduct":{…}` JSON | Disabled before archiving. Fixture in `tests/fixtures/`. |
| `blocket-electronics` (`blocket.js`) | Blocket second-hand electronics | Internal BFF JSON API `…/search/api/search/SEARCH_ID_BAP_COMMON`, no auth, ~53/page, newest first | Keyword search; it also seeded keywords from the removed favorite categories. Last OK 2026-08-26. |
| `gg-deals-games` (`ggdeals.js`) | Game prices | SteamSpy top 10k IDs (weekly) + GG.deals API, 500 games per scan | Disabled before archiving. |
| `approved-rss-feed` (`rss.js`) | Any approved RSS deal feed | RSS/Atom | Disabled; a template for feed sources. |
| `nvidia-fe` (`nvidiaScanSource.js`) | NVIDIA FE cards in the main listing | Copied the NVIDIA tracker's live-feed state into listings; no network calls | The tracker and its panel don't need it. NVIDIA's store API blocks our IP and the proxy; the tracker uses Notify-FE's feed (`wss://live.jlplen.io/v1/ws`). |

Shared helpers: `lib/bypassFetch.js` (the FlareSolverr/ScraperAPI/Scrapfly chain)
and `lib/incremental.js` (delta pagination).

## How to revive one

1. `git mv archive/scrapers/<file>.js src/sources/` (and its tests from `tests/`
   back to `test/`). Fix import paths: archived files import `../../src/...`.
2. Re-register its type in `src/sources/index.js`, and allow the type in
   `src/config.js` if validation rejects it.
3. Copy its entry from `sources.archived.json` back into `config/sources.json`.
4. The dashboard source controls and the scan scheduler were removed too. Either
   run it on its own poller like the hotlist or Komplett demo watcher
   (randomised interval, backoff, seed silently before alerting), or bring the
   scheduler back from git history (`git log -- src/scheduler.js`).
5. Check the site's blocking first (see the lessons above) before polling it from the Pi.
