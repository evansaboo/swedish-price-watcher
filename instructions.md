# Swedish Price Watcher - Project Instructions

## Goal
- Build and operate a real product pricing watcher for Swedish electronics deals.
- Prioritize outlet and discounted listings, then surface strong opportunities with clear price comparison context.
- Keep scans reliable in production on Railway and optimize for practical resale/deal-finding workflows.

## Product Scope
- Six active sources: Elgiganten, NetOnNet, Webhallen, Komplett B-grade, ProShop Outlet, Power Erbjudanden.
- Compare outlet price against matched non-outlet catalog prices when possible.
- Track new listings, price drops, and category-level behavior.
- Support dashboard-first workflows: scan controls, scheduling, filtering, sorting, favorites, and cancel.
- Optional notifications via Discord webhook with rate-limit-safe, per-source incremental updates.

## Active Sources (config/sources.json)

| ID | Type | Method | Notes |
|----|------|--------|-------|
| `elgiganten-outlet-latest` | `apify-elgiganten` | Apify custom actor | Keyword + outlet search, ref price lookup |
| `netonnet-outlet` | `netonnet-outlet` | Direct Next.js RSC HTML | Batched parallel ref lookups (5 at a time) |
| `webhallen-fyndware` | `webhallen-api` | Webhallen internal API | Includes regularPrice as ref price |
| `komplett-outlet-electronics` | `komplett-category` | `apify/cheerio-scraper` | Apify proxy bypasses Railway IP block |
| `proshop-outlet` | `proshop-outlet` | `apify/cheerio-scraper` | Cloudflare bypass; `li.site-productlist-item` |
| `power-deals` | `power-deals` | `apify/playwright-scraper` | Angular SPA; cookie injection + reload to capture API |

## Runtime and Deployment
- Primary hosting target is Railway (always-on).
- Bind server to `0.0.0.0` in Railway runtime.
- Persist state via Apify KV store when configured; otherwise local JSON store.
- Keep health endpoint working (`/health`) for platform health checks.
- Railway project: `distinguished-vibrancy`, service: `swedish-price-watcher`.

## Railway CLI

```bash
# Link to the project (one-time per machine)
railway link   # select: Evan Saboo's Projects → distinguished-vibrancy → swedish-price-watcher

# Check deployment status and recent logs
railway status
railway logs --tail 50

# Run a command in the production environment (e.g. curl health check)
railway run curl -s https://swedish-price-watcher-production.up.railway.app/health

# Trigger a manual scan in production
railway run curl -s -X POST https://swedish-price-watcher-production.up.railway.app/api/scan

# Check active sources in production
railway run curl -s https://swedish-price-watcher-production.up.railway.app/api/sources
```

## How to Add a New Scraper Source

1. **Create `src/sources/{name}.js`** — export `collectFrom{Name}({ source, fetcher, sourceState, now })`.
   - Use `apify/cheerio-scraper` for Cloudflare/static HTML sites.
   - Use `apify/playwright-scraper` for Angular/React SPAs that require JavaScript rendering.
   - Return an array of observation objects with: `sourceId`, `externalId`, `title`, `url`, `currentPriceSek`, `referencePriceSek`, `category`, `condition`, `scannedAt`.

2. **Register in `src/sources/index.js`** — add import and entry to `handlers` object.

3. **Register in `src/config.js`** — add the type string to `supportedSourceTypes` Set (line 8).

4. **Add entry to `config/sources.json`** — with `id`, `type`, `enabled`, `label`, `apiTokenEnvVar`.

### Apify actor pattern (cheerio-scraper)
```js
const run = await client.actor('apify/cheerio-scraper').call({
  startUrls: [...],
  pageFunction: PAGE_FN_STRING,
  proxyConfiguration: { useApifyProxy: true },
  maxRequestsPerCrawl: N,
}, { timeout: Math.floor(source.actorTimeoutMs / 1000) });
const { items } = await client.dataset(run.defaultDatasetId).listItems();
```

### Playwright scraper pattern (for Angular/SPA sites)
- Inject consent cookie via `page.evaluate()` then `page.reload()` to capture API responses
- Set up `page.on('response', ...)` BEFORE the reload to intercept product API JSON
- Wait for Angular component selectors with `waitForFunction`

## Scraping and Reliability Guidelines
- Use Apify-backed collection instead of direct high-risk scraping from protected storefront pages.
- Keep request behavior polite and robust:
  - retries for transient upstream failures (`502`/`5xx`/timeouts),
  - token pooling/rotation across multiple `APIFY_TOKEN*` env vars,
  - cached/multi-scan enrichment for reference matches.
- Avoid aggressive or bot-like behavior that risks source blocking.

## Scan Architecture

- **Parallel collection**: all sources run I/O concurrently via `Promise.all`.
- **Serialized processing**: a mutex chain (`processingChain.then(...)`) ensures state mutations, Discord notifications, and saves are serialized per-source as each finishes.
- **Per-source Discord updates**: each source sends its own Discord notification immediately after finishing, so users see results incrementally.
- **Cancel**: `POST /api/cancel` aborts via `AbortController`; in-flight Apify actors continue but results are discarded.
- **Incremental UI refresh**: frontend `pollScanStatus` calls `loadDashboard()` whenever `completedSources` ticks up, so the table updates live during a scan.

## UX Expectations
- Mobile-friendly dashboard.
- Light, readable interface.
- Progress bar + per-source status during scans; cancel button for stuck scans.
- Fast filtering workflow with useful defaults and quick-filter actions.
- Keep "new product" highlighting and filtering consistent between backend and UI.
- Always follow good UX/UI practices: prioritize clarity, responsive behavior, accessibility, and low-friction user flows.

## Engineering Rules for This Repo
- Make focused, production-safe changes and keep tests passing (`node --test`).
- Update docs/config examples when behavior or setup changes.
- Do not reintroduce Vercel-specific runtime paths/config.
- When adding a source type, always update BOTH `src/sources/index.js` AND `src/config.js` supportedSourceTypes.

## Workflow Rule (Required)
- **After every completed code change, always commit and push to `main`.**
- Use Railway CLI to verify production health after deploying fixes.
