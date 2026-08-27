import { firstFinite, formatSek } from '../lib/utils.js';
import { buildPurchaseComponents } from './purchaseEngine.js';
import { normalizeWebhookUrl } from './hotlistConfig.js';

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
export function itemMatchesRule(item, { keywords, categories, minDiscountPercent, filteredSources, sourceFilterMode }) {
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
  constructor({ webhookUrl, cooldownHours, webhookMaxRetries = 3, webhookRetryBaseMs = 1500, webhookRetryCapMs = 15000, botToken = '', alertChannelId = '', hotlistSourceId = '' }) {
    this.webhookUrl = webhookUrl;
    this.cooldownMs = cooldownHours * 60 * 60 * 1000;
    this.webhookMaxRetries = Math.max(0, Number(webhookMaxRetries) || 0);
    this.webhookRetryBaseMs = Math.max(0, Number(webhookRetryBaseMs) || 0);
    this.webhookRetryCapMs = Math.max(this.webhookRetryBaseMs, Number(webhookRetryCapMs) || this.webhookRetryBaseMs);
    // Plain channel webhooks cannot carry message components (buttons) — only a
    // bot or an application-owned webhook can. When a bot token is configured,
    // interactive alerts go through it; otherwise they degrade to plain embeds.
    this.botToken = String(botToken ?? '').trim();
    this.alertChannelId = String(alertChannelId ?? '').trim();
    // Used to keep hotlist finds out of the alert-rule pipeline.
    this.hotlistSourceId = String(hotlistSourceId ?? '').trim();
  }

  get canSendComponents() {
    return Boolean(this.botToken && this.alertChannelId);
  }

  async notifyScan({ deals, newItems, priceDrops = [], sources, state, notificationSettings, wishlistTargets = {}, purchase = null, stageListing = null }) {
    const settings = notificationSettings ?? {};

    // Respect global notifications-enabled flag (default: true for backward compat)
    if (settings.notificationsEnabled === false) {
      return { sent: 0, skipped: newItems.length, failed: 0, errors: [], reason: 'notifications-disabled', alertRules: { sent: 0, skipped: newItems.length, failed: 0, errors: [] } };
    }

    const alertRules = Array.isArray(settings.alertRules) ? settings.alertRules.filter((r) => r.enabled !== false) : [];
    const alertSummary = await this.notifyAlertRules({ newItems, priceDrops, state, alertRules, purchase, stageListing });

    // Feature 3: wishlist target-price alerts — a tracked item dropped to/below the user's target.
    const wishlistSummary = await this.notifyWishlistTargets({ newItems, priceDrops, state, wishlistTargets, config: settings.wishlistAlerts });

    return {
      sent: alertSummary.sent + wishlistSummary.sent,
      skipped: alertSummary.skipped + wishlistSummary.skipped,
      failed: alertSummary.failed + wishlistSummary.failed,
      errors: [...alertSummary.errors, ...wishlistSummary.errors],
      alertRules: alertSummary,
      wishlistAlerts: wishlistSummary
    };
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
    for (const drop of priceDrops) candidates.push({ ...(state.items[drop.listingKey] ?? drop), buyUrl: drop.buyUrl, affiliate: drop.affiliate });

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
              url: item.buyUrl ?? item.url,
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
  /**
   * Hotlist notifications, deliberately separate from alert rules.
   *
   * The hotlist already decides what it cares about via its watch groups, so
   * re-filtering its finds through unrelated keyword rules was doing the same
   * job twice and doing it wrong: a hotlist iPhone find fired the generic
   * "Iphone" rule and went to that rule's channel, while the Hotlist tab
   * offered no webhook field to explain where anything was going. Everything
   * the poller matched is worth sending, to one destination the user chose.
   */
  async notifyHotlist({
    newItems = [],
    priceDrops = [],
    state,
    webhookUrl,
    notifyPriceDrops = true,
    minPriceDropPercent = 5,
    purchase = null,
    stageListing = null
  }) {
    const empty = { sent: 0, skipped: 0, failed: 0, errors: [] };
    const webhook = normalizeWebhookUrl(webhookUrl) || this.webhookUrl;
    if (!webhook) {
      return { ...empty, skipped: newItems.length + priceDrops.length, reason: 'no-webhook' };
    }

    let sent = 0, skipped = 0, failed = 0;
    const errors = [];
    const now = Date.now();

    const deliver = async (item, notificationKey, { isDrop = false, dropPercent = null } = {}) => {
      const previousSentAt = state.notifications[notificationKey];
      if (previousSentAt && now - Date.parse(previousSentAt) < this.cooldownMs) {
        skipped++;
        return;
      }

      const discount = getDiscountSummary(item);
      const purchaseContext = await this.#resolvePurchaseContext({ item, purchase, stageListing });

      try {
        await this.#deliverAlert({
          payload: {
            username: 'Price Watcher',
            content: isDrop
              ? `📉 **Hotlist** — price drop ${formatPercent(dropPercent)}`
              : '⚡ **Hotlist** — new find',
            embeds: [
              {
                title: item.title,
                url: item.buyUrl ?? item.url,
                description: [
                  `${item.sourceLabel ?? 'Elgiganten'} • ${item.category ?? ''}`.trim(),
                  purchaseContext.note
                ].filter(Boolean).join('\n'),
                color: isDrop ? 0xf59e0b : 0x22c55e,
                fields: [
                  { name: 'Price', value: formatSek(item.latestPriceSek ?? item.priceSek), inline: true },
                  { name: 'Initial', value: formatSek(discount.initialPriceSek), inline: true },
                  { name: 'Discount', value: formatPercent(discount.discountPercent), inline: true }
                ],
                image: item.imageUrl ? { url: item.imageUrl } : undefined,
                footer: item.affiliate ? { text: 'Annonslänk · affiliate link' } : undefined
              }
            ]
          },
          components: purchaseContext.components,
          webhookUrl: webhook
        });
        state.notifications[notificationKey] = new Date(now).toISOString();
        sent++;
      } catch (error) {
        failed++;
        this.#recordError(errors, error);
      }
    };

    for (const item of newItems) {
      await deliver(item, `${item.listingKey}:hotlist`);
    }

    if (notifyPriceDrops) {
      for (const drop of priceDrops) {
        if (!Number.isFinite(drop.dropPercent) || drop.dropPercent < minPriceDropPercent) continue;
        const item = { ...(state.items[drop.listingKey] ?? drop), buyUrl: drop.buyUrl, affiliate: drop.affiliate };
        await deliver(item, `${drop.listingKey}:hotlist:drop`, { isDrop: true, dropPercent: drop.dropPercent });
      }
    }

    return { sent, skipped, failed, errors };
  }

  async notifyAlertRules({ newItems, priceDrops = [], state, alertRules, purchase = null, stageListing = null }) {
    if (!alertRules.length) {
      return { sent: 0, skipped: 0, failed: 0, errors: [], reason: 'no-alert-rules' };
    }

    // Hotlist finds have their own channel and their own matching logic. Even
    // though the poller no longer routes through here, this guard keeps the two
    // systems from silently re-coupling if a future caller passes them in.
    if (this.hotlistSourceId) {
      newItems = newItems.filter((item) => item.sourceId !== this.hotlistSourceId);
      priceDrops = priceDrops.filter((drop) => {
        const sourceId = drop.sourceId ?? state.items?.[drop.listingKey]?.sourceId;
        return sourceId !== this.hotlistSourceId;
      });
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
        const purchaseContext = await this.#resolvePurchaseContext({ item, purchase, stageListing });

        let itemSent = false;
        for (const webhookUrl of webhooks) {
          try {
            await this.#deliverAlert({
              payload: {
                username: 'Price Watcher',
                content: `🔔 **${ruleLabel}** — new match`,
                embeds: [
                  {
                    title: item.title,
                    url: item.buyUrl ?? item.url,
                    description: [
                      `${item.sourceLabel} • ${item.category}`,
                      purchaseContext.note
                    ].filter(Boolean).join('\n'),
                    color: 0x5865f2,
                    fields: [
                      { name: 'Price', value: formatSek(item.latestPriceSek ?? item.priceSek), inline: true },
                      { name: 'Initial', value: formatSek(discount.initialPriceSek), inline: true },
                      { name: 'Discount', value: formatPercent(discount.discountPercent), inline: true },
                      { name: 'First seen', value: new Date(item.firstSeenAt ?? item.seenAt).toLocaleString('sv-SE'), inline: true }
                    ],
                    image: item.imageUrl ? { url: item.imageUrl } : undefined,
                    footer: item.affiliate ? { text: 'Annonslänk · affiliate link' } : undefined
                  }
                ]
              },
              components: purchaseContext.components,
              webhookUrl
            });
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
        const item = { ...(state.items[drop.listingKey] ?? drop), buyUrl: drop.buyUrl, affiliate: drop.affiliate };
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
                  url: drop.buyUrl ?? drop.url,
                  description: `${drop.sourceLabel} • ${drop.category ?? ''}`,
                  color: 0x57f287,
                  fields: [
                    { name: 'Was', value: formatSek(drop.previousPriceSek), inline: true },
                    { name: 'Now', value: formatSek(drop.newPriceSek), inline: true },
                    { name: 'Drop', value: `−${formatPercent(drop.dropPercent)} (${formatSek(drop.dropSek)})`, inline: true }
                  ],
                  image: item.imageUrl ? { url: item.imageUrl } : undefined,
                  footer: drop.affiliate ? { text: 'Annonslänk · affiliate link' } : undefined
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

  /**
   * Work out which checkout model applies to an alert.
   *
   * `deep-link`     → nothing extra.
   * `armed`         → an interaction button carrying the single-use arm token.
   * `cart-staging`  → stage the basket right now so the alert already contains
   *                   a checkout link.
   */
  async #resolvePurchaseContext({ item, purchase, stageListing }) {
    const empty = { components: [], note: null };
    if (!purchase) return empty;

    const arm = purchase.armed?.[item.listingKey];
    if (!arm) return empty;

    const mode = arm.mode ?? purchase.mode ?? 'deep-link';
    if (mode === 'deep-link') return empty;

    let checkoutUrl = null;
    let note = null;

    if (mode === 'cart-staging' && typeof stageListing === 'function') {
      try {
        const result = await stageListing({ listingKey: item.listingKey, arm, via: 'alert' });
        if (result?.ok) {
          checkoutUrl = result.checkoutUrl;
          note = `🛒 Cart staged — complete payment: ${checkoutUrl}`;
        } else {
          note = `⚠️ Auto-staging refused: ${result?.message ?? result?.reason ?? 'unknown reason'}`;
        }
      } catch (error) {
        note = `⚠️ Auto-staging failed: ${error.message}`;
      }
    }

    const components = buildPurchaseComponents({ item, arm, mode, checkoutUrl });

    // Without a bot token Discord rejects components on a plain webhook, so the
    // information is folded into the embed text instead of being lost.
    if (!this.canSendComponents) {
      if (!note && mode === 'armed') {
        note = '⚡ Armed — stage from the dashboard (set DISCORD_BOT_TOKEN for one-tap buttons).';
      }
      return { components: [], note };
    }

    return { components, note };
  }

  /** Route through the bot API when buttons are involved, else the webhook. */
  async #deliverAlert({ payload, components = [], webhookUrl }) {
    const finalPayload = components.length ? { ...payload, components } : payload;
    const targetWebhook = webhookUrl || this.webhookUrl;
    
    // If a specific webhook was requested (e.g. Hotlist or custom alert rule), respect it over the bot.
    // The Bot API is only used as a fallback for the global channel when components are present.
    if (components.length && this.canSendComponents && targetWebhook === this.webhookUrl) {
      return this.#postBotMessage(finalPayload);
    }
    return this.#postWebhook(finalPayload, targetWebhook);
  }

  async #postBotMessage(payload) {
    const response = await fetch(`https://discord.com/api/v10/channels/${this.alertChannelId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bot ${this.botToken}`
      },
      // `username` is a webhook-only field and is rejected by the bot endpoint.
      body: JSON.stringify({ content: payload.content, embeds: payload.embeds, components: payload.components })
    });
    if (!response.ok) {
      throw new Error(`Discord bot API returned ${response.status} ${response.statusText}`);
    }
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
        body: JSON.stringify(payload),
        redirect: 'error'
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
