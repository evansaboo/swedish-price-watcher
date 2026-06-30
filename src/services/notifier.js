import { firstFinite, formatSek } from '../lib/utils.js';

function getInitialPrice(item) {
  return firstFinite(item.referencePriceSek, item.marketValueSek);
}

function getDiscountSummary(item) {
  const initialPriceSek = getInitialPrice(item);

  if (!Number.isFinite(initialPriceSek) || initialPriceSek <= 0) {
    return {
      initialPriceSek: null,
      discountSek: null,
      discountPercent: null
    };
  }

  const discountSek = Math.max(0, initialPriceSek - item.latestPriceSek);
  const discountPercent = Math.max(0, Math.round((discountSek / initialPriceSek) * 100));

  return {
    initialPriceSek,
    discountSek,
    discountPercent
  };
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value}%` : 'n/a';
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function parseRetryDelayMs(response) {
  const retryAfterRaw = response?.headers?.get?.('retry-after');
  const resetAfterRaw = response?.headers?.get?.('x-ratelimit-reset-after');

  if (retryAfterRaw) {
    const asSeconds = Number.parseFloat(retryAfterRaw);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.round(asSeconds * 1000);
    }

    const asDate = Date.parse(retryAfterRaw);
    if (!Number.isNaN(asDate)) {
      return Math.max(0, asDate - Date.now());
    }
  }

  if (resetAfterRaw) {
    const asSeconds = Number.parseFloat(resetAfterRaw);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.round(asSeconds * 1000);
    }
  }

  return null;
}

/**
 * Returns true if the item matches all constraints of an alert rule:
 * - Source filter: item sourceId must pass the include/exclude source list (if set)
 * - At least one keyword token sequence must appear in item title (if keywords are set)
 * - Item category must match at least one rule category (if categories are set)
 * - Item discount % must be ≥ minDiscountPercent (if set)
 */
function itemMatchesRule(item, { keywords, categories, minDiscountPercent, filteredSources, sourceFilterMode }) {
  // Source filter — support both include and exclude modes
  if (filteredSources && filteredSources.length) {
    const inList = filteredSources.includes(item.sourceId);
    if (sourceFilterMode === 'include' && !inList) return false;
    if (sourceFilterMode !== 'include' && inList) return false;
  }

  if (typeof minDiscountPercent === 'number' && Number.isFinite(minDiscountPercent) && minDiscountPercent > 0) {
    const price = item.latestPriceSek ?? item.priceSek;
    const refPrice = item.referencePriceSek ?? item.marketValueSek;
    const discountPct = refPrice && refPrice > price ? Math.round((1 - price / refPrice) * 100) : 0;
    if (discountPct < minDiscountPercent) return false;
  }

  if (keywords.length) {
    const titleLower = String(item.title ?? '').toLowerCase();
    const anyKeywordMatches = keywords.some((kw) => {
      const tokens = kw.split(/\s+/).filter(Boolean);
      return tokens.every((t) => titleLower.includes(t));
    });
    if (!anyKeywordMatches) return false;
  }

  if (categories.length) {
    const itemCat = String(item.category ?? '').toLowerCase();
    // Empty itemCat must not match — `c.includes('')` is always true in JS, which would cause
    // every product with no category to pass any category rule.
    if (!itemCat || !categories.some((c) => itemCat.includes(c) || c.includes(itemCat))) return false;
  }

  return true;
}

export class DiscordNotifier {
  constructor({ webhookUrl, cooldownHours, webhookMaxRetries = 3, webhookRetryBaseMs = 1500, webhookRetryCapMs = 15000 }) {
    this.webhookUrl = webhookUrl;
    this.cooldownMs = cooldownHours * 60 * 60 * 1000;
    this.webhookMaxRetries = Math.max(0, Number(webhookMaxRetries) || 0);
    this.webhookRetryBaseMs = Math.max(0, Number(webhookRetryBaseMs) || 0);
    this.webhookRetryCapMs = Math.max(this.webhookRetryBaseMs, Number(webhookRetryCapMs) || this.webhookRetryBaseMs);
  }

  async notifyScan({ deals, newItems, priceDrops = [], sources, state, notificationSettings, flips = [], wishlistTargets = {} }) {
    const settings = notificationSettings ?? {};

    // Respect global notifications-enabled flag (default: true for backward compat)
    if (settings.notificationsEnabled === false) {
      return { sent: 0, skipped: newItems.length, failed: 0, errors: [], reason: 'notifications-disabled', alertRules: { sent: 0, skipped: newItems.length, failed: 0, errors: [] } };
    }

    const alertRules = Array.isArray(settings.alertRules) ? settings.alertRules.filter((r) => r.enabled !== false) : [];
    const alertSummary = await this.notifyAlertRules({ newItems, priceDrops, state, alertRules });

    // Feature 4: flip alerts — high-margin resale opportunities to a dedicated channel.
    const flipSummary = await this.notifyFlipAlerts({ flips, state, config: settings.flipAlerts });

    // Feature 3: wishlist target-price alerts — a tracked item dropped to/below the user's target.
    const wishlistSummary = await this.notifyWishlistTargets({ newItems, priceDrops, state, wishlistTargets, config: settings.wishlistAlerts });

    return {
      sent: alertSummary.sent + flipSummary.sent + wishlistSummary.sent,
      skipped: alertSummary.skipped + flipSummary.skipped + wishlistSummary.skipped,
      failed: alertSummary.failed + flipSummary.failed + wishlistSummary.failed,
      errors: [...alertSummary.errors, ...flipSummary.errors, ...wishlistSummary.errors],
      alertRules: alertSummary,
      flipAlerts: flipSummary,
      wishlistAlerts: wishlistSummary
    };
  }

  /**
   * Feature 4 — Flip alerts.
   * Posts high-margin resale opportunities (net profit / ROI above the configured
   * thresholds) to a dedicated Discord webhook. Deduped per listing per cooldown.
   */
  async notifyFlipAlerts({ flips = [], state, config }) {
    const empty = { sent: 0, skipped: 0, failed: 0, errors: [] };
    if (!config || config.enabled !== true) return { ...empty, reason: 'disabled' };
    const webhook = typeof config.webhook === 'string' ? config.webhook.trim() : '';
    if (!webhook) return { ...empty, reason: 'no-webhook' };
    if (!Array.isArray(flips) || !flips.length) return empty;

    const minNetProfit = Number.isFinite(config.minNetProfitSek) ? config.minNetProfitSek : 500;
    const minRoi = Number.isFinite(config.minRoiPercent) ? config.minRoiPercent : 15;
    const now = Date.now();
    let sent = 0, skipped = 0, failed = 0;
    const errors = [];

    for (const flip of flips) {
      if (!Number.isFinite(flip.netProfitSek) || flip.netProfitSek < minNetProfit) continue;
      if (!Number.isFinite(flip.roiPercent) || flip.roiPercent < minRoi) continue;

      // Dedupe per listing per buy price so a re-listing at a new price can re-alert.
      const notificationKey = `${flip.listingKey}:flip:${flip.buyPriceSek}`;
      const previousSentAt = state.notifications[notificationKey];
      if (previousSentAt && now - Date.parse(previousSentAt) < this.cooldownMs) { skipped++; continue; }

      try {
        await this.#postWebhook({
          username: 'Price Watcher',
          content: `⚡ **Flip opportunity** — ${flip.modelLabel ?? flip.title}`,
          embeds: [
            {
              title: flip.title,
              url: flip.url,
              description: `${flip.sourceLabel} • ${flip.demandCategory ?? ''}`,
              color: 0xfaa61a,
              fields: [
                { name: 'Buy now', value: formatSek(flip.buyPriceSek), inline: true },
                { name: 'Resale median', value: formatSek(flip.resaleMedianSek), inline: true },
                { name: 'Net profit', value: `+${formatSek(flip.netProfitSek)}`, inline: true },
                { name: 'ROI', value: `${flip.roiPercent}%`, inline: true },
                { name: 'Comps', value: `${flip.sampleCount} Blocket`, inline: true }
              ],
              image: flip.imageUrl ? { url: flip.imageUrl } : undefined
            }
          ]
        }, webhook);
        state.notifications[notificationKey] = new Date(now).toISOString();
        sent++;
      } catch (error) {
        failed++;
        this.#recordError(errors, error);
      }
    }

    return { sent, skipped, failed, errors };
  }

  /**
   * Feature 3 — Wishlist target-price alerts.
   * When a wishlisted item appears (new) or drops to/below the user's target
   * price, post an alert to a dedicated Discord webhook. Deduped per listing per
   * target per cooldown.
   */
  async notifyWishlistTargets({ newItems = [], priceDrops = [], state, wishlistTargets = {}, config }) {
    const empty = { sent: 0, skipped: 0, failed: 0, errors: [] };
    if (!config || config.enabled !== true) return { ...empty, reason: 'disabled' };
    const webhook = typeof config.webhook === 'string' ? config.webhook.trim() : '';
    if (!webhook) return { ...empty, reason: 'no-webhook' };
    const targets = wishlistTargets && typeof wishlistTargets === 'object' ? wishlistTargets : {};
    if (!Object.keys(targets).length) return empty;

    const now = Date.now();
    let sent = 0, skipped = 0, failed = 0;
    const errors = [];

    // Candidate = any new item or price-dropped item that is on the wishlist with a target.
    const seen = new Set();
    const candidates = [];
    for (const item of newItems) candidates.push(item);
    for (const drop of priceDrops) candidates.push(state.items[drop.listingKey] ?? drop);

    for (const item of candidates) {
      const listingKey = item.listingKey;
      if (!listingKey || seen.has(listingKey)) continue;
      const target = Number(targets[listingKey]);
      if (!Number.isFinite(target) || target <= 0) continue;

      const price = Number(item.latestPriceSek ?? item.priceSek ?? item.newPriceSek);
      if (!Number.isFinite(price) || price > target) continue;
      seen.add(listingKey);

      const notificationKey = `${listingKey}:target:${target}`;
      const previousSentAt = state.notifications[notificationKey];
      if (previousSentAt && now - Date.parse(previousSentAt) < this.cooldownMs) { skipped++; continue; }

      try {
        await this.#postWebhook({
          username: 'Price Watcher',
          content: `🎯 **Wishlist target hit** — ${item.title}`,
          embeds: [
            {
              title: item.title,
              url: item.url,
              description: `${item.sourceLabel ?? ''} • ${item.category ?? ''}`,
              color: 0xeb459e,
              fields: [
                { name: 'Price', value: formatSek(price), inline: true },
                { name: 'Your target', value: formatSek(target), inline: true },
                { name: 'Under target by', value: formatSek(Math.max(0, target - price)), inline: true }
              ],
              image: item.imageUrl ? { url: item.imageUrl } : undefined
            }
          ]
        }, webhook);
        state.notifications[notificationKey] = new Date(now).toISOString();
        sent++;
      } catch (error) {
        failed++;
        this.#recordError(errors, error);
      }
    }

    return { sent, skipped, failed, errors };
  }

  /**
   * Send Discord notifications for each enabled alert rule.
   * A rule fires when a new item — or a price drop, unless the rule sets
   * notifyPriceDrops=false — matches all its constraints:
   *   - Source filter: sourceFilterMode='include' → only listed sources;
   *                    sourceFilterMode='exclude' (default) → all except listed
   *   - At least one keyword matches item title (if keywords are set; empty = any)
   *   - Item category matches a rule category (if categories are set; empty = any)
   *   - Item discount % ≥ minDiscountPercent (if set)
   *   - Price drops additionally require dropPercent ≥ minPriceDropPercent (default 5)
   * Sends to all webhooks listed on the rule.
   */
  async notifyAlertRules({ newItems, priceDrops = [], state, alertRules }) {
    if (!alertRules.length) {
      return { sent: 0, skipped: 0, failed: 0, errors: [], reason: 'no-alert-rules' };
    }

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];
    const now = Date.now();

    for (const rule of alertRules) {
      const webhooks = (rule.webhooks ?? []).filter((w) => typeof w === 'string' && w.trim());
      if (!webhooks.length) continue;

      const keywords = (rule.keywords ?? []).map((k) => String(k).toLowerCase().trim()).filter(Boolean);
      const categories = (rule.categories ?? []).map((c) => String(c).toLowerCase().trim()).filter(Boolean);
      // Backward compat: old rules used excludedSources; new rules use filteredSources + sourceFilterMode
      const filteredSources = (rule.filteredSources ?? rule.excludedSources ?? []).map((s) => String(s).trim()).filter(Boolean);
      const sourceFilterMode = rule.sourceFilterMode === 'include' ? 'include' : 'exclude';
      const minDiscountPercent = typeof rule.minDiscountPercent === 'number' && Number.isFinite(rule.minDiscountPercent) ? rule.minDiscountPercent : null;
      const constraints = { keywords, categories, minDiscountPercent, filteredSources, sourceFilterMode };
      const ruleLabel = rule.label || (keywords.length ? keywords.join(', ') : categories.length ? categories.join(', ') : 'Alert');

      const matches = newItems.filter((item) => itemMatchesRule(item, constraints));

      for (const item of matches) {
        const notificationKey = `${item.listingKey}:rule:${rule.id}`;
        const previousSentAt = state.notifications[notificationKey];

        if (previousSentAt && now - Date.parse(previousSentAt) < this.cooldownMs) {
          skipped++;
          continue;
        }

        const discount = getDiscountSummary(item);

        let itemSent = false;
        for (const webhookUrl of webhooks) {
          try {
            await this.#postWebhook({
              username: 'Price Watcher',
              content: `🔔 **${ruleLabel}** — new match`,
              embeds: [
                {
                  title: item.title,
                  url: item.url,
                  description: `${item.sourceLabel} • ${item.category}`,
                  color: 0x5865f2,
                  fields: [
                    { name: 'Price', value: formatSek(item.latestPriceSek ?? item.priceSek), inline: true },
                    { name: 'Initial', value: formatSek(discount.initialPriceSek), inline: true },
                    { name: 'Discount', value: formatPercent(discount.discountPercent), inline: true },
                    { name: 'First seen', value: new Date(item.firstSeenAt ?? item.seenAt).toLocaleString('sv-SE'), inline: true }
                  ],
                  image: item.imageUrl ? { url: item.imageUrl } : undefined
                }
              ]
            }, webhookUrl);
            itemSent = true;
          } catch (error) {
            failed++;
            this.#recordError(errors, error);
          }
        }

        if (itemSent) {
          state.notifications[notificationKey] = new Date(now).toISOString();
          sent++;
        }
      }

      // ── Price drops ──────────────────────────────────────────────
      if (rule.notifyPriceDrops === false) continue;
      const minDropPercent = typeof rule.minPriceDropPercent === 'number' && Number.isFinite(rule.minPriceDropPercent)
        ? rule.minPriceDropPercent
        : 5;

      for (const drop of priceDrops) {
        if (!Number.isFinite(drop.dropPercent) || drop.dropPercent < minDropPercent) continue;
        // Match against the full tracked item (has reference price + image); fall
        // back to the drop record itself if the item was pruned mid-scan.
        const item = state.items[drop.listingKey] ?? drop;
        if (!itemMatchesRule(item, constraints)) continue;

        // One drop alert per item per rule per cooldown window.
        const notificationKey = `${drop.listingKey}:rule:${rule.id}:drop`;
        const previousSentAt = state.notifications[notificationKey];
        if (previousSentAt && now - Date.parse(previousSentAt) < this.cooldownMs) {
          skipped++;
          continue;
        }

        let dropSent = false;
        for (const webhookUrl of webhooks) {
          try {
            await this.#postWebhook({
              username: 'Price Watcher',
              content: `📉 **${ruleLabel}** — price drop`,
              embeds: [
                {
                  title: drop.title,
                  url: drop.url,
                  description: `${drop.sourceLabel} • ${drop.category ?? ''}`,
                  color: 0x57f287,
                  fields: [
                    { name: 'Was', value: formatSek(drop.previousPriceSek), inline: true },
                    { name: 'Now', value: formatSek(drop.newPriceSek), inline: true },
                    { name: 'Drop', value: `−${formatPercent(drop.dropPercent)} (${formatSek(drop.dropSek)})`, inline: true }
                  ],
                  image: item.imageUrl ? { url: item.imageUrl } : undefined
                }
              ]
            }, webhookUrl);
            dropSent = true;
          } catch (error) {
            failed++;
            this.#recordError(errors, error);
          }
        }

        if (dropSent) {
          state.notifications[notificationKey] = new Date(now).toISOString();
          sent++;
        }
      }
    }

    return { sent, skipped, failed, errors };
  }

  /** Post an arbitrary payload (e.g. the daily digest) to a webhook with retry. */
  async sendToWebhook(payload, webhookUrl) {
    return this.#postWebhook(payload, webhookUrl);
  }

  #recordError(errors, error) {
    if (!Array.isArray(errors) || errors.length >= 5) {
      return;
    }

    errors.push(error instanceof Error ? error.message : String(error));
  }

  #resolveRetryDelayMs(response, attempt) {
    const headerDelay = parseRetryDelayMs(response);

    if (Number.isFinite(headerDelay)) {
      return Math.min(this.webhookRetryCapMs, Math.max(0, headerDelay));
    }

    const exponentialDelay = this.webhookRetryBaseMs * 2 ** attempt;
    return Math.min(this.webhookRetryCapMs, exponentialDelay);
  }

  async #postWebhook(payload, webhookUrl = this.webhookUrl) {
    for (let attempt = 0; attempt <= this.webhookMaxRetries; attempt += 1) {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        return;
      }

      const retriable = response.status === 429 || response.status >= 500;

      if (retriable && attempt < this.webhookMaxRetries) {
        await sleep(this.#resolveRetryDelayMs(response, attempt));
        continue;
      }

      throw new Error(`Discord webhook returned ${response.status} ${response.statusText}`);
    }
  }
}
