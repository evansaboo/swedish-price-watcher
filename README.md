# Swedish Price Watcher

A production outlet price tracker for Swedish electronics stores. Runs on Railway, scrapes six sources via Apify, and sends incremental Discord notifications as each scan completes.

## Active sources

| Store | What it tracks | Method |
|-------|---------------|--------|
| **Elgiganten** | Outlet products | Apify custom actor + keyword queries |
| **NetOnNet** | Outlet/clearance | Direct Next.js HTML scraping |
| **Webhallen** | Fyndvara (outlet) | Webhallen internal API |
| **Komplett** | B-grade / demovaror | `apify/cheerio-scraper` (Cloudflare bypass) |
| **ProShop** | Mega Outlet | `apify/cheerio-scraper` (Cloudflare bypass) |
| **Power** | Erbjudanden (deals) | `apify/playwright-scraper` (Angular SPA) |

## What it does

- Scans all sources in parallel with per-source incremental Discord notifications
- Keeps a local record of listings and highlights new vs seen products
- Enriches outlet products by matching against non-outlet catalog prices
- Shows a discount table (outlet price, reference price, % off) in the dashboard
- Lets you mark favorite categories and filter/sort by them
- Cancel button to abort stuck scans
- Scheduled scans with configurable interval and active-hour windows (Swedish time)
- Discord alerts for: new discounted listings, price drops in favorite categories, amazing deals

## Setup

```bash
cp .env.example .env
npm install
npm start
```

Open `http://127.0.0.1:3030`.

### Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `APIFY_TOKEN` | Yes | Apify API token for all Apify-backed sources |
| `APIFY_TOKEN_2`, `APIFY_TOKEN_3` | No | Extra tokens for Elgiganten round-robin |
| `DISCORD_WEBHOOK_URL` | No | Discord channel webhook for notifications |
| `SCAN_INTERVAL_MINUTES` | No | Initial scheduler interval (default: 30) |
| `RUN_ON_START` | No | Set `true` to scan immediately on boot |

## Railway deployment

This repo is Railway-ready via `railway.json`. Project: `distinguished-vibrancy`.

1. Create a Railway project from this GitHub repo.
2. Set the environment variables above.
3. Deploy — the server binds to `0.0.0.0:$PORT` automatically.

State persists via Apify KV store when `APIFY_TOKEN` is set.

### Railway CLI

```bash
# Link to the project (one-time)
railway link

# Check logs
railway logs --tail 50

# Test production health
railway run curl -s https://swedish-price-watcher-production.up.railway.app/health

# Trigger a manual scan in production
railway run curl -s -X POST https://swedish-price-watcher-production.up.railway.app/api/scan
```

## Run a scan manually (local)

```bash
npm run scan
```

## Dashboard controls

- **Scan all** — starts a full scan of all enabled sources
- **Cancel** — aborts an in-progress scan (appears during scanning)
- **Scan** (per-source) — scan a single source independently
- **Scheduler** — set interval, active window (e.g. 07:00–00:00 Stockholm), enable/disable

## Notifications

Discord sends happen **per source as it finishes**, so you see results incrementally rather than waiting for all sources. Each message includes price context and discount %.

Notification modes per source (set in `config/sources.json`):

| Mode | When it fires |
|------|---------------|
| `favorite-events` | New discounted item or price drop in a favorite category |
| `amazing-deals` | Items above the amazing-deal threshold |
| `new-listings` | Every first-seen listing |
| `none` | Silent |

## Adding a new source

1. Create `src/sources/{name}.js` — export `collectFrom{Name}({ source, fetcher, sourceState, now })`
2. Register handler in `src/sources/index.js`
3. Add type to `supportedSourceTypes` Set in `src/config.js`
4. Add entry to `config/sources.json`

Use `apify/cheerio-scraper` for Cloudflare-protected static sites, `apify/playwright-scraper` for Angular/React SPAs.

## Source config reference

Edit `config/sources.json`. Common fields:

| Field | Meaning |
|-------|---------|
| `id` | Unique source identifier |
| `type` | Handler type (see active sources table) |
| `enabled` | `true`/`false` |
| `label` | Display name in the UI |
| `apiTokenEnvVar` | Env var name for the Apify token (default: `APIFY_TOKEN`) |
| `actorTimeoutMs` | Max wait for Apify actor run |
| `notificationMode` | Discord notification strategy |
| `maxPages` | Pagination limit (for paged sources) |

### Elgiganten-specific fields

| Field | Meaning |
|-------|---------|
| `actorId` | Apify actor (`owner/actor`) |
| `actorKeywordQueries` | Extra keyword searches merged into the scan |
| `includePaths` | URL fragments that must exist (e.g. `/product/outlet/`) |
| `referenceLookup` | Enable non-outlet price matching |
| `referenceLookupMaxPerScan` | Max items to enrich per scan |
| `referenceLookupConcurrency` | Parallel lookup workers |
