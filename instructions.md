# Swedish Price Watcher - Project Instructions

## Goal
- Build and operate a real product pricing watcher for Swedish electronics deals.
- Prioritize outlet and discounted listings, then surface strong opportunities with clear price comparison context.
- Keep scans reliable in production on Railway and optimize for practical resale/deal-finding workflows.

## Product Scope
- Main source: Elgiganten outlet via Apify actor integration.
- Compare outlet price against matched non-outlet catalog prices when possible.
- Track new listings, price drops, and category-level behavior.
- Support dashboard-first workflows: scan controls, scheduling, filtering, sorting, and favorites.
- Optional notifications via Discord webhook with rate-limit-safe behavior.

## Runtime and Deployment
- Primary hosting target is Railway (always-on).
- Bind server to `0.0.0.0` in Railway runtime.
- Persist state via Apify KV store when configured; otherwise local JSON store.
- Keep health endpoint working (`/health`) for platform health checks.

## Scraping and Reliability Guidelines
- Use Apify-backed collection instead of direct high-risk scraping from protected storefront pages.
- Keep request behavior polite and robust:
  - retries for transient upstream failures (`502`/`5xx`/timeouts),
  - token pooling/rotation across multiple `APIFY_TOKEN*` env vars,
  - cached/multi-scan enrichment for reference matches.
- Avoid aggressive or bot-like behavior that risks source blocking.

## UX Expectations
- Mobile-friendly dashboard.
- Light, readable interface.
- Fast filtering workflow with useful defaults and quick-filter actions.
- Keep "new product" highlighting and filtering consistent between backend and UI.
- Always follow good UX/UI practices: prioritize clarity, responsive behavior, accessibility, and low-friction user flows.

## Engineering Rules for This Repo
- Make focused, production-safe changes and keep tests passing.
- Update docs/config examples when behavior or setup changes.
- Do not reintroduce Vercel-specific runtime paths/config.

## Workflow Rule (Required)
- **After every completed code change, always commit and push to `main`.**
