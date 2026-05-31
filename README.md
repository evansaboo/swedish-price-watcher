# Swedish Price Watcher

A production outlet price tracker for Swedish electronics stores. Runs on a Raspberry Pi 4 with Docker, uses FlareSolverr for Cloudflare bypass, and sends Discord notifications as each scan completes. Public access via Cloudflare Tunnel.

## Active sources

| Store | What it tracks | Method |
|-------|---------------|--------|
| **Elgiganten** | Outlet products | Direct Algolia API (brand-split pagination) |
| **NetOnNet** | Outlet/clearance | Direct Next.js HTML scraping |
| **Webhallen** | Fyndvara (outlet) | Webhallen internal API |
| **Komplett** | B-grade / demovaror | `apify/cheerio-scraper` (Cloudflare bypass) |
| **ProShop** | Mega Outlet + Demo | FlareSolverr (Cloudflare bypass, free) |
| **Power** | Erbjudanden (deals) | `apify/playwright-scraper` (Angular SPA) |
| **Inet** | Fyndhörnan (bargains) | Direct HTTP + hydrate JSON parsing |

## What it does

- Scans all sources in parallel with per-source incremental Discord notifications
- Keeps a local record of listings and highlights new vs seen products
- Enriches outlet products by matching against non-outlet catalog prices
- Shows a discount table (outlet price, reference price, % off) in the dashboard
- Lets you mark favorite categories and filter/sort by them
- Cancel button to abort stuck scans
- Scheduled scans with configurable interval and active-hour windows (Swedish time)
- Discord alerts for: new discounted listings, price drops in favorite categories

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
| `APIFY_TOKEN` | No | Apify API token (for Komplett, Power scrapers) |
| `DISCORD_WEBHOOK_URL` | No | Discord channel webhook for notifications |
| `CLOUDFLARE_TUNNEL_TOKEN` | No | Token for Cloudflare Tunnel (public HTTPS access) |
| `SCAN_INTERVAL_MINUTES` | No | Initial scheduler interval (default: 180) |
| `RUN_ON_START` | No | Set `true` to scan immediately on boot |
| `SCRAPFLY_API_KEY` | No | Scrapfly key (optional ProShop fallback, 1000 free credits/mo) |
| `FLARESOLVERR_URL` | Auto | Set by docker-compose to `http://flaresolverr:8191` |

### ProShop — Cloudflare bypass

ProShop is behind Cloudflare Bot Management. FlareSolverr handles this automatically
(included in docker-compose). No paid API keys needed.

ProShop uses **incremental scanning** — on repeat scans it stops pagination as soon as it sees
pages full of already-known items, cutting scan time significantly.

## Raspberry Pi 4 deployment

### Prerequisites

On your Pi (Raspberry Pi OS 64-bit):

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in

# Install Docker Compose plugin
sudo apt-get install docker-compose-plugin
```

### 1. Clone and configure

```bash
git clone https://github.com/evansaboo/swedish-price-watcher.git
cd swedish-price-watcher
cp .env.example .env
# Edit .env with your tokens:
nano .env
```

### 2. Set up Cloudflare Tunnel

```bash
# Install cloudflared on your Pi (or just use the Docker container)
# Go to https://one.dash.cloudflare.com → Networks → Tunnels → Create a tunnel
# Name it "price-watcher", copy the tunnel token
# Then add a public hostname:
#   Subdomain: price-watcher
#   Domain: evansaboo.com
#   Service: http://app:3000
```

Add the token to your `.env`:
```
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoiYWJjLi4uIiwidCI6Ii4uLiIsInMiOiIuLi4ifQ==
```

### 3. Build and start

```bash
docker compose up -d --build
```

First build takes ~10 minutes on RPi 4. Subsequent starts are instant.

### 4. Verify

```bash
# Check all containers are running
docker compose ps

# Check app health
curl http://localhost:3000/health

# Check public access
curl https://price-watcher.evansaboo.com/health

# View logs
docker compose logs -f app --tail 50
```

### Useful commands

```bash
# Restart after code changes
git pull && docker compose up -d --build

# Trigger a manual scan
curl -X POST http://localhost:3000/api/run

# View FlareSolverr logs (useful for ProShop debugging)
docker compose logs flaresolverr --tail 20

# Check resource usage
docker stats --no-stream

# Stop everything
docker compose down
```

### Memory usage (8GB Pi)

| Container | Limit | Typical |
|-----------|-------|---------|
| app | 1 GB | 200–400 MB |
| flaresolverr | 2 GB | 300–800 MB (during CF bypass) |
| cloudflared | 128 MB | 20–30 MB |
| **Total** | ~3.1 GB | ~1 GB idle |

Leaves plenty of headroom for the OS and other services.

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

| `new-listings` | Every first-seen listing |
| `none` | Silent |

## Post-change testing checklist

After any code change, verify the following work end-to-end — each test assumes at least one completed scan run:

### Categories & favorites
- [ ] **Category filter** — open the dashboard, the "All categories" dropdown must show named categories per source (e.g. "Grafikkort (GPU)", "Mobiltelefon" from Elgiganten; not just "Outlet" or "electronics")
- [ ] **Elgiganten categories** — run a scan and confirm Elgiganten products have specific categories, not "Outlet" for all
- [ ] **Favorite categories** — open Favourites editor, mark 1-2 categories; "Favourites only" filter must hide products outside those categories
- [ ] **Category favorites persist** — reload the page; favorites must still be checked

### New listings
- [ ] **New badge** — products first seen in the latest scan show a "New" badge in the table
- [ ] **New filter** — "New products only" toggle must narrow the list to freshly discovered items; toggling off restores the full list

### Images
- [ ] **Elgiganten** — each product card shows a non-broken product image (media.elkjop.com JPEG)
- [ ] **Webhallen** — images load (not an SVG placeholder); URL must come from `fyndwareOf` parent product ID
- [ ] **ProShop** — images visible (check `data-src` / `data-lazy-src` extraction)
- [ ] **NetOnNet, Power, Komplett** — spot-check 3-5 cards each for working images
- [ ] **Discord embeds** — notifications include product images (not broken or SVG)

### Store filter & per-source counts
- [ ] **Store dropdown** — lists all active sources; selecting "Elgiganten Outlet" shows only Elgiganten products
- [ ] **Per-source scan results** — after running "Scan all", sidebar shows a count > 0 for each source once it finishes (Elgiganten, Webhallen, NetOnNet, Komplett, Power); ProShop should appear but may be 0 if Cloudflare blocks it

### Notifications (requires `DISCORD_WEBHOOK_URL`)

- [ ] **New-listings notification** — for a source in `new-listings` mode, first-seen products must post to Discord
- [ ] **Retry on 429** — deliberately hit the webhook rapidly; confirm no notification is silently lost (check scan summary `notificationSummary.errors`)

### Scheduler
- [ ] **Enable/disable** — toggle scheduler on/off in sidebar; status pill updates without page reload
- [ ] **Interval update** — change interval to 5 minutes, save; `/api/scheduler` must return updated `intervalMinutes`
- [ ] **Active window** — set a window that excludes the current time; scheduler must skip automatic runs

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
