# Swedish Price Watcher

A local Node.js outlet tracker for **Elgiganten Sweden**. It uses an Apify-backed source to collect outlet listings, stores local history, and can push Discord updates for favorite categories.

## Default setup

The default source is now:

- **Elgiganten outlet latest** via `shahidirfan/elgiganten-scraper` on Apify
- outlet products are filtered to `/product/outlet/`
- the UI is simplified to focus on: **price, new price, discount, discount percent**
- you can mark categories as favorites and use them for filtering and Discord updates

This avoids fighting Elgiganten's direct anti-bot protections from the app runtime.

## What it does

- scans Elgiganten outlet search results through Apify with high pagination limits
- keeps a local record of listings it has already seen
- enriches outlet products by matching them against non-outlet Elgiganten listings
- shows a simplified outlet table with discount columns based on matched non-outlet prices
- includes a compact favorites workflow (selected chips + expandable category picker)
- adds richer filters (favorites-only, discounted-only, matched-price-only, min discount %, max price)
- lets you mark favorite categories from discovered outlet categories
- persists your latest filter/sort/favorites-panel UI state in the browser
- lets you configure scan scheduler interval/on-off directly from the dashboard
- supports active-hour windows in Swedish time (for example 07:00-00:00 only)
- sends Discord updates for favorite categories when:
  - a new discounted item appears
  - an existing item in a favorite category gets a price drop

## Setup

```bash
cd /Users/evan.saboo/swedish-price-watcher
cp .env.example .env
npm install
```

Add these values to `.env`:

- `APIFY_TOKEN` - your Apify API token
- `DISCORD_WEBHOOK_URL` - your Discord webhook URL

Then start the app:

```bash
npm start
```

Open `http://127.0.0.1:3030` if you want the local dashboard, or just let scheduled scans post to Discord.

The scheduler uses `SCAN_INTERVAL_MINUTES` as its first-run default, and can then be changed live in the dashboard.

The default source profile is tuned for lower Apify spend (smaller result/page caps, fewer keyword expansions, lighter reference lookups).

## Run one scan manually

```bash
npm run scan
```

## How notifications work

- `notificationMode: "new-listings"` sends Discord alerts when a listing is first seen
- listings are deduplicated in local state, so the same listing is not repeatedly announced every scan
- messages are batched per source for Discord instead of sending one webhook call per item
- listing embeds include price context fields, including initial price and discount percent when available
- favorite categories (set in the dashboard) trigger additional Discord events for:
  - new discounted listings
  - listing price drops

The default Elgiganten source uses `notificationMode: "favorite-events"` so Discord only gets favorite-category events instead of every new listing.

## Source config

Edit `config/sources.json`.

### Elgiganten Apify source fields

| Field | Meaning |
| --- | --- |
| `type` | Must be `apify-elgiganten` |
| `actorId` | Apify actor name, either `owner/actor` or `owner~actor` |
| `apiTokenEnvVar` | Environment variable containing the Apify token |
| `actorInput` | JSON payload sent to the Apify actor |
| `actorKeywordQueries` | Extra keyword-based actor runs merged into the same scan (useful for outlet category gaps like gaming/components) |
| `actorKeywordResultsWanted` | Per-keyword result target |
| `actorKeywordMaxPages` | Per-keyword page limit |
| `actorTimeoutMs` | Timeout for the actor run request |
| `notificationMode` | `new-listings`, `favorite-events`, `amazing-deals`, or `none` |
| `notificationBatchSize` | Max listings bundled into one Discord message |
| `includePaths` | URL fragments that must exist in listing URLs (used for outlet-only filtering) |
| `referenceLookup` | Enable non-outlet match lookups for category names + new-price comparisons |
| `referenceLookupMaxPerScan` | Max outlet items to enrich per scan |
| `referenceLookupConcurrency` | Parallel lookup workers |
| `referenceLookupRetryHours` | Wait time before retrying a failed lookup for the same listing |
| `referenceLookupResultsWanted` | Result size per lookup query |
| `referenceLookupMaxPages` | Page limit per lookup query |

### Default actor input

The bundled source uses:

```json
{
  "startUrl": "https://www.elgiganten.se/search?q=outlet&view=products",
  "results_wanted": 1200,
  "max_pages": 40,
  "includeRawRecord": true
}
```

Category filters use resolved Elgiganten category names when a match is available.

The source also keeps only URLs matching `/product/outlet/` so alerts stay outlet-focused.

To improve coverage beyond the generic outlet search page without excessive Apify spend, the default config also runs a small keyword query set and merges/deduplicates all results into one outlet set.

If a product has no non-outlet match yet, the dashboard shows `match pending` in the **New price** column.

## Notes

- Direct Elgiganten requests from this runtime were blocked by Vercel security checks, so the tracker now uses Apify instead of trying to scrape Elgiganten HTML directly.
- The old Komplett source is still in `config/sources.json`, but disabled.

## Minimal Vercel deploy

This repo now includes a minimal Vercel serverless entrypoint:

- `api/[[...path]].js` (handles all `/api/*` routes)
- `vercel.json` (sets function duration)

For quick smoke testing, serverless mode:

- uses `/tmp/swedish-price-watcher-store.json` for runtime state
- auto-seeds from `data/store.json` when available
- disables background scheduler timers (you can still run scans manually from the dashboard)
