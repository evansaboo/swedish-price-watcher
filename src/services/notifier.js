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
 * - Item sourceId must NOT be in excludedSources (if any are set)
 * - At least one keyword token sequence must appear in item title (if keywords are set)
 * - Item category must match at least one rule category (if categories are set)
 * - Item price must be ≤ maxPriceSek (if set)
 */
function itemMatchesRule(item, { keywords, categories, maxPriceSek, excludedSources }) {
  const price = item.latestPriceSek ?? item.priceSek;

  if (excludedSources && excludedSources.length) {
    if (excludedSources.includes(item.sourceId)) return false;
  }

  if (typeof maxPriceSek === 'number' && Number.isFinite(maxPriceSek) && price > maxPriceSek) {
    return false;
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

  async notifyScan({ deals, newItems, priceDrops = [], sources, state, notificationSettings }) {
    const settings = notificationSettings ?? {};

    // Respect global notifications-enabled flag (default: true for backward compat)
    if (settings.notificationsEnabled === false) {
      return { sent: 0, skipped: newItems.length, failed: 0, errors: [], reason: 'notifications-disabled', alertRules: { sent: 0, skipped: newItems.length, failed: 0, errors: [] } };
    }

    const alertRules = Array.isArray(settings.alertRules) ? settings.alertRules.filter((r) => r.enabled !== false) : [];
    const alertSummary = await this.notifyAlertRules({ newItems, state, alertRules });

    return {
      sent: alertSummary.sent,
      skipped: alertSummary.skipped,
      failed: alertSummary.failed,
      errors: alertSummary.errors,
      alertRules: alertSummary
    };
  }

  /**
   * Send Discord notifications for each enabled alert rule.
   * A rule fires when a new item matches all its constraints:
   *   - At least one keyword matches item title (if keywords are set; empty = any)
   *   - Item category matches a rule category (if categories are set; empty = any)
   *   - Item price ≤ maxPriceSek (if set)
   * Sends to all webhooks listed on the rule.
   */
  async notifyAlertRules({ newItems, state, alertRules }) {
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
      const excludedSources = (rule.excludedSources ?? []).map((s) => String(s).trim()).filter(Boolean);
      const maxPriceSek = typeof rule.maxPriceSek === 'number' && Number.isFinite(rule.maxPriceSek) ? rule.maxPriceSek : null;

      const matches = newItems.filter((item) => itemMatchesRule(item, { keywords, categories, maxPriceSek, excludedSources }));

      for (const item of matches) {
        const notificationKey = `${item.listingKey}:rule:${rule.id}`;
        const previousSentAt = state.notifications[notificationKey];

        if (previousSentAt && now - Date.parse(previousSentAt) < this.cooldownMs) {
          skipped++;
          continue;
        }

        const discount = getDiscountSummary(item);
        const ruleLabel = rule.label || (keywords.length ? keywords.join(', ') : categories.length ? categories.join(', ') : 'Alert');

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
    }

    return { sent, skipped, failed, errors };
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
