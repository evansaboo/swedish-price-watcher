# Swedish Price Watcher

A production outlet price tracker for Swedish electronics stores. It supports Railway and Raspberry Pi/Docker deployments, uses FlareSolverr where needed, and sends incremental Discord notifications.

## Active sources

| Store | What it tracks | Method |
|-------|---------------|--------|
| **Elgiganten** | Outlet products + weekly campaigns | Direct Algolia API (brand-split pagination) |
| **NetOnNet** | Outlet/clearance | Direct Next.js HTML scraping |
| **Webhallen** | Fyndvara (outlet) + deals toplist | Webhallen internal API |
| **Komplett** | B-grade / demovaror | `apify/cheerio-scraper` (Cloudflare bypass) |
| **ProShop** | Mega Outlet + Demo | FlareSolverr (Cloudflare bypass, free) |
| **Power** | Outlet + campaign markdowns | Direct REST API (`o=true` outlet / `o=false` campaigns) |
| **Inet** | Fyndhörnan (bargains) | Direct HTTP + hydrate JSON parsing |
| **Kjell & Company** | Outlet (A/B grade) | Direct JSON API (XHR headers, ~3 300 products) |
| **Dustin** | Fyndvaror (clearance) | FlareSolverr + embedded JSON (disabled until verified on the Pi) |
| **Blocket** | Second-hand electronics | Internal BFF JSON API (keyword search) |
| **SweClockers** | Community deals (Dagens fynd) | FlareSolverr (Cloudflare bypass) |

## What it does

- Scans all sources in parallel with per-source incremental Discord notifications
- Keeps a local record of listings and highlights new vs seen products
- Enriches outlet products by matching against non-outlet catalog prices
- Shows a discount table (outlet price, reference price, % off) in the dashboard
- Lets you mark favorite categories and filter/sort by them
- Cancel button to abort stuck scans
- Scheduled scans with configurable interval and active-hour windows (Swedish time)
- **Elgiganten hotlist**: a continuous poller for resale-friendly categories, independent of the scan scheduler — see below
- Discord alert rules fire on **new matches** and **price drops** (per-rule toggle + min-drop %)
- **Daily digest**: top new deals by score posted once per day at a configured Stockholm time (Settings → Alerts)
- **Cross-store matching**: the same product is linked across stores via GTIN/EAN and manufacturer part numbers (with normalized-title fallback); cards show "Cheaper at X" / "Best price of N stores"
- **Affiliate distribution**: approved per-source tracking templates have raw-link fallback, visible `Annonslänk` disclosure, and aggregate click counts without visitor identifiers.
- **Incremental scanning** for ProShop, Kjell, and NetOnNet — pagination stops once consecutive pages contain only known items; every 5th scan runs full so stale items still get pruned
- CSV export of the current filtered product list (`/api/export.csv` or the button in the filter panel)
- Partial-scan protection: cancelled scans and incremental early-stops never prune items that simply weren't revisited
- Gzip/brotli compression on all API and static responses

## Elgiganten hotlist (continuous poller)

The hotlist watches the categories that hold their value second-hand (GPUs, RAM,
SSDs, MacBooks, iPhones) and is deliberately **not** part of the scan scheduler.
A full scan walks every source and takes minutes; a hotlist poll is a single
Algolia round-trip, and its whole value is catching a mispriced item before it
sells out.

Configure it in the dashboard under **Settings → Hotlist**:

- **Cadence** — poll interval (30 s floor), jitter %, and a global minimum discount.
- **Watches** — each watch combines any of: Elgiganten's own categories, brands,
  and keywords, plus optional per-watch discount and price bounds.
- **Exact title match** — Algolia is typo-tolerant, so a bare `RTX 5090` query
  also returns 5070s. With this on (the default) a hit must literally contain the
  keyword's significant tokens in its title.
- **Poll now** — run a poll immediately without waiting for the next tick.

Settings live in the SQLite preferences, so they survive restarts and need no
redeploy. The `watchGroups` in `config/sources.json` are only the first-run seed.

**How it stays polite.** Every watch and keyword is packed into ONE Algolia
multi-query request, so adding keywords never adds HTTP round-trips — a poll is
one request against the plain Algolia CDN (which is not behind Elgiganten's bot
mitigation) using the shared cached API key. Timing is jittered so requests never
land on a predictable tick, failures back off exponentially, and polls are
skipped while a full scan holds the state lock. Steady-state polls that find no
change skip the deals recompute and product-cache rebuild entirely.

Status (last poll, deal count, next poll, errors) is exposed at `GET /api/hotlist`
and included in `GET /api/status`.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/hotlist` | Current config, live poller status, and cost per poll |
| `PUT /api/hotlist` | Update cadence and watches (merged over the current config) |
| `POST /api/hotlist/poll` | Force an immediate poll |
| `GET /api/hotlist/catalog?q=` | Search Elgiganten's ~700 categories / ~1000 brands (cached 6 h) |

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
| `ARCHIVE_RETENTION_DAYS` | No | How long pruned items keep their price history (default: 90) |
| `MAX_HISTORY_ENTRIES` | No | Price-history points kept per item (default: 20) |
| `ADMIN_API_TOKEN` | No | Protects assisted-checkout endpoints |
| `DISCORD_PUBLIC_KEY` | No | Discord app public key; enables signed interaction buttons |
| `DISCORD_BOT_TOKEN` | No | Bot token; required to post alerts *with* buttons |
| `DISCORD_ALERT_CHANNEL_ID` | No | Channel the bot posts interactive alerts to |
| `DISCORD_OWNER_IDS` | No | Comma-separated Discord user IDs allowed to press buy buttons (empty = nobody) |
| `ELGIGANTEN_EMAIL` | No | Elgiganten login for signed-in cart staging |
| `ELGIGANTEN_PASSWORD` | No | Elgiganten password (staging never enters card details) |
| `ELGIGANTEN_SESSION_PATH` | No | Where the reusable browser session is stored (mode 0600) |
| `ELGIGANTEN_PROXY_URL` | No | HTTP(S) proxy used for Elgiganten requests — the escape hatch when your IP is firewall-blocked |
| `ELGIGANTEN_BLOCK_COOLDOWN_HOURS` | No | How long to stand Elgiganten sources down after a hard block (default `6`) |

### Avoiding detection

Elgiganten fronts its site with Vercel bot management. Three things keep the
scraper's traffic unremarkable:

**1. A coherent browser identity.** Signals must agree with each other. Spoofing
only the user agent is worse than not spoofing at all, because every other
signal keeps telling the truth. Measured on the Pi before this was fixed, a
single request carried:

```
user-agent          ... Chrome/131.0.0.0  (claiming macOS)
sec-ch-ua           "HeadlessChrome";v="147", ...
sec-ch-ua-platform  "macOS"               (on a Linux host)
navigator.webdriver true
```

`src/sources/browserFingerprint.js` now derives the user agent and client hints
from the running build, so version and platform always match, `HeadlessChrome`
is never advertised, and the automation flags are masked. When changing the
browser, keep these in sync — an inconsistency is more detectable than an
honest headless browser.

**2. Few requests to the protected host.** Product queries go to Algolia's CDN,
which is not challenge-protected. Only the signed-key fetch touches
`elgiganten.se`, so the scraper's footprint there is small. Keep it that way:
add scraping to the Algolia path, not to the site.

**3. Irregular timing.** The signed key lives ~15 minutes, which would put the
key fetch on an almost perfect quarter-hour tick. The renewal margin is
randomised over a several-minute window so the visits scatter.

### When Elgiganten returns 403

Elgiganten sits behind a Vercel firewall. Two failure modes look similar but are
very different:

- **`429` + `x-vercel-mitigated: challenge`** — a bot challenge. Recoverable: the
  scraper retries through a real Chromium, which normally passes it.
- **`403` + `x-vercel-mitigated: deny`** — your egress IP is blocked outright.
  Every path is refused, including `/robots.txt`, so no browser, header or
  fingerprint change gets through.

On a deny, all three Elgiganten sources (`elgiganten-outlet`,
`elgiganten-campaigns`, `elgiganten-hotlist`) stand down together for
`ELGIGANTEN_BLOCK_COOLDOWN_HOURS`. This is deliberate: retrying cannot succeed,
and continued traffic risks prolonging the block. Other sources are unaffected.

To confirm a deny:

```bash
curl -sSI https://www.elgiganten.se/ | grep -i 'HTTP/\|vercel-mitigated'
```

To recover, either wait out the cooldown or set `ELGIGANTEN_PROXY_URL` to a proxy
on a different IP (`http://user:pass@host:port`; residential proxies are the most
reliable) and restart.
| `AFFILIATE_LINK_TEMPLATE_<SOURCE_ID>` | No | Approved tracking URL template containing `{url}` |


### Affiliate links

Affiliate URLs fail safe: without a valid approved template, retailer links remain unchanged. Templates stay in environment configuration:

```bash
AFFILIATE_LINK_TEMPLATE_KOMPLETT_OUTLET_ELECTRONICS='https://approved-network.example/click?destination={url}'
```

Do not use placeholder domains in production or configure a retailer before program approval. The UI and Discord embeds show `Annonslänk` whenever a tracking template is active.

### ProShop / Dustin / SweClockers — Cloudflare bypass

These stores sit behind Cloudflare Bot Management. FlareSolverr handles this automatically
(included in docker-compose). No paid API keys needed.

ProShop, Kjell, and NetOnNet use **incremental scanning** — on repeat scans, pagination stops
as soon as consecutive pages contain only already-known items. Every 5th scan
(`incrementalFullScanEvery`) runs a full pass so removed listings still get pruned.

### Enabling Dustin (first time)

The `dustin-fyndvaror` source ships **disabled** — it was written against an archived
page capture and needs one verification pass on the Pi where FlareSolverr runs:

```bash
# 1. Enable the source via the dashboard (Settings → Sources) or set enabled=true in config/sources.json
# 2. Run a single-source scan:
curl -X POST localhost:3000/api/run -H 'content-type: application/json' -d '{"sourceIds":["dustin-fyndvaror"]}'
# 3. Check the logs: docker compose logs app --tail 30
#    Expect "[dustin-fyndvaror] /group/ovrigt/fyndvaror page 1: N new products" with N > 0,
#    and page 2 also yielding products (verifies ?page= pagination).
```

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

Alert rules (Settings → Alerts) control what gets posted. Each rule has keywords,
categories, a source include/exclude filter, min discount %, one or more webhooks,
and a **price-drop toggle**: when enabled (default), the rule also fires when a
tracked item matching the rule drops in price by at least `Min drop %` (default 5%).
Drop alerts are rate-limited to one per item per rule per cooldown window
(`NOTIFICATION_COOLDOWN_HOURS`, default 24 h).

Notification modes per source (set in `config/sources.json`):

| Mode | When it fires |
|------|---------------|
| `favorite-events` | New discounted item or price drop in a favorite category |
| `new-listings` | Every first-seen listing |
| `none` | Silent |

## Assisted checkout

Turns an Elgiganten alert into a ready-to-pay cart. **Payment is never automated.**
Every path stops at the checkout page so you confirm the card step yourself
(BankID / 3-D Secure). That boundary is deliberate: unattended card charging is
blocked by PSD2/SCA anyway, and engineering around it would defeat fraud
protection and trip the most aggressive bot detection on the site.

Three models, selectable per-alert or as a default in the dashboard's **⚡ Buy** panel:

| Mode | Behaviour |
|------|-----------|
| `deep-link` | Alert carries a direct product link. Nothing is automated. |
| `armed` | You pre-arm a listing (price cap + expiry + single use). One Discord tap then stages the cart. |
| `cart-staging` | The bot stages the cart as soon as a matching alert fires, and the alert links straight to checkout. |

Guard rails (all enforced server-side in `src/services/purchaseEngine.js`):

- Every `/api/purchase/*` route requires `ADMIN_API_TOKEN` (`501` when unset, `401` when wrong).
- Discord clicks need **both** a valid Ed25519 signature *and* a `DISCORD_OWNER_IDS` allow-list match. An empty allow-list refuses everyone.
- Arm tokens are 18 random bytes, single-use, expiring, and compared with `timingSafeEqual`. They are never returned by the API.
- A per-arm price cap is clamped to the global cap at arm time, so arming can never *raise* the ceiling. An existing arm governs staging no matter which path triggered it.
- Staging is rate-limited by a sliding window (`maxStagesPerHour`, default 10), and every attempt — including every refusal — is written to an audit log visible in the panel.

Arm a listing from any Elgiganten card with the **⚡** button, or manage
defaults, armed listings, and the audit log from the **⚡ Buy** panel.

### Enabling Discord buttons

Plain channel webhooks cannot render buttons, so a real Discord application is
required. Without one the feature still works from the dashboard and alerts fall
back to plain embeds.

Fetch three values from <https://discord.com/developers/applications> (create an
application first):

| Value | Where |
|-------|-------|
| Public Key | *General Information* tab |
| Bot Token | *Bot* tab → **Reset Token** (shown once) |
| Your User ID | Discord → *Settings → Advanced → Developer Mode*, then right-click yourself → **Copy User ID** |

Then run, on the host serving the app:

```bash
./scripts/setup-discord-buy.sh
```

It validates each credential against Discord's API *before* writing anything —
checking the key length, that the bot token authenticates, and that the bot can
actually see your alert channel — then writes `.env` (mode `600`, previous
version backed up), restarts the service and confirms `discordConfigured: true`.
It resolves the alert channel from an existing `DISCORD_WEBHOOK_URL` and
generates `ADMIN_API_TOKEN` if either is missing. Non-interactive form:

```bash
./scripts/setup-discord-buy.sh --public-key KEY --bot-token TOKEN --owner-ids ID
```

Finally, set the **Interactions Endpoint URL** in the Developer Portal to
`https://<your-host>/api/discord/interactions`. Do this *after* running the
script — Discord sends a signed test request and only saves the URL once the
public key is live. The script prints the exact URL to paste.

`DISCORD_OWNER_IDS` is the allow-list: leave it empty and every button press is
refused, including your own.

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

#### Using a VPN or proxy to change the egress IP

The deny is tied to a single IP, so any route out through a different address
restores access. Confirmed behaviour: a blocked IP gets `403 deny`, while other
IPs get `429 challenge`, which the browser path solves normally.

Options, cheapest first:

1. **Change your ISP-assigned IP.** Many consumer ISPs (Telia among them) pin
   the DHCP lease to the router's WAN MAC address. Putting the ISP router in
   bridge mode behind your own router and changing that router's WAN MAC
   usually yields a new address immediately.
2. **NordVPN (or similar) on the host.** Install the Linux client and connect;
   all traffic then leaves through the VPN. Note this changes the egress for
   *everything* on the host — verify inbound access still works (a Cloudflare
   Tunnel keeps working, since it is an outbound connection).
3. **`ELGIGANTEN_PROXY_URL`** to proxy only Elgiganten traffic and leave the
   rest of the host untouched.

> **Credentialed SOCKS proxies are handled for you.** Chromium cannot
> authenticate to a SOCKS proxy, so credentials passed to it are silently
> dropped. If `ELGIGANTEN_PROXY_URL` is a `socks5://user:pass@...` URL, the app
> automatically starts a local HTTP-to-SOCKS bridge
> (`src/services/socksBridge.js`) and points the browser at that instead.

#### NordVPN

Use NordVPN's SOCKS5 endpoint so only Elgiganten traffic changes exit IP,
leaving the rest of the host — including the inbound Cloudflare tunnel —
untouched:

```bash
ELGIGANTEN_PROXY_URL=socks5://<service-user>:<service-pass>@se.socks.nordhold.net:1080
```

**Step 1 — get the service credentials.** These are *not* your Nord account
password. Sign in at [my.nordaccount.com](https://my.nordaccount.com) →
**NordVPN** → **Set up NordVPN manually** → verify by email → copy the
**service username** and **service password**.

**Step 2 — pick a Swedish endpoint.** Port is always `1080`:

| Hostname | Notes |
| --- | --- |
| `se.socks.nordhold.net` | Sweden, picks a server for you |
| `stockholm.se.socks.nordhold.net` | Pins to Stockholm |

Stay in Sweden so the storefront's pricing, language and stock stay consistent
with what the rest of the app expects.

**Step 3 — configure it.** Add to `.env` (the app auto-starts the bridge):

```bash
ELGIGANTEN_PROXY_URL=socks5://<service-user>:<service-pass>@se.socks.nordhold.net:1080
```

**Step 4 — verify before trusting it:**

```bash
npm run check-proxy
```

This is worth doing. A misconfigured proxy fails in the worst possible way:
requests still succeed, but they exit from the host's own IP, so you believe
you are protected while the address you were trying to hide is the one in use.
The checker compares the exit IP against the direct one and refuses to report
success if they match:

```
  mode               credentialed SOCKS5 -> local HTTP bridge
  IP without proxy   78.70.240.212
  IP via proxy       89.45.90.11
  elgiganten.se      429
```

A `429` or plain `403` there is normal — those are the bot challenge, which the
real scraper solves in a browser. Only `mitigated: deny` means the proxy IP is
itself firewall-blocked; switch endpoints if you see it.

Then restart: `sudo systemctl restart swedish-price-watcher`.

Note that only Elgiganten traffic changes exit IP. The rest of the host,
including the inbound Cloudflare tunnel that serves the dashboard, is
untouched — which is why this is preferable to a host-wide VPN.
