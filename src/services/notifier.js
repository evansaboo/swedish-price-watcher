import { firstFinite, formatSek } from '../lib/utils.js';
import { normalizeWebhookUrl } from './hotlistConfig.js';
import { getKomplettDemoCategory } from './komplettDemoConfig.js';

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

export class DiscordNotifier {
  constructor({ webhookUrl, cooldownHours, webhookMaxRetries = 3, webhookRetryBaseMs = 1500, webhookRetryCapMs = 15000 }) {
    this.webhookUrl = webhookUrl;
    this.cooldownMs = cooldownHours * 60 * 60 * 1000;
    this.webhookMaxRetries = Math.max(0, Number(webhookMaxRetries) || 0);
    this.webhookRetryBaseMs = Math.max(0, Number(webhookRetryBaseMs) || 0);
    this.webhookRetryCapMs = Math.max(this.webhookRetryBaseMs, Number(webhookRetryCapMs) || this.webhookRetryBaseMs);
  }

  // The scan-time alert rules and wishlist target-price ("favorite") alerts
  // were removed on 2026-10-31 together with the multi-source scan. The three
  // remaining features each post through their own method below.

  /**
   * Hotlist notifications. The hotlist decides what it cares about via its
   * watch groups, so everything the poller matched is sent, to the one
   * destination the user chose in the Hotlist tab.
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
      const purchaseNote = await this.#resolvePurchaseNote({ item, purchase, stageListing });

      try {
        await this.#postWebhook({
          username: 'Price Watcher',
          content: isDrop
            ? `📉 **Elgiganten Hotlist** — price drop ${formatPercent(dropPercent)}`
            : '⚡ **Elgiganten Hotlist** — new find',
          embeds: [
            {
              title: item.title,
              url: item.buyUrl ?? item.url,
              description: [
                `${item.sourceLabel ?? 'Elgiganten'} • ${item.category ?? ''}`.trim(),
                purchaseNote
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
        }, webhook);
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

  /**
   * Komplett demo-products watcher alerts (see services/komplettDemoPoller.js).
   *
   * `alerts` are `{ reason: 'new'|'price-drop'|'back-in-stock', product,
   * categoryId, previousPriceSek?, dropPercent? }`. Embeds go out in batches
   * of up to 10 (Discord's per-message limit) so a burst of new demo items
   * costs a few requests, not dozens. Mentions are disabled outright.
   *
   * @returns {{ sent, failed, skipped, errors, delivered: boolean[], reason? }}
   */
  async notifyKomplettDemo({ alerts = [], webhookUrl } = {}) {
    const delivered = alerts.map(() => false);
    const webhook = normalizeWebhookUrl(webhookUrl) || this.webhookUrl;
    if (!webhook) {
      return { sent: 0, failed: 0, skipped: alerts.length, errors: [], delivered, reason: 'no-webhook' };
    }

    const reasonMeta = {
      'new': { emoji: '🆕', text: 'new demo product', color: 0x22c55e },
      'price-drop': { emoji: '📉', text: 'price drop', color: 0xf59e0b },
      'back-in-stock': { emoji: '🔁', text: 'back in stock', color: 0x3b82f6 }
    };

    const buildEmbed = (alert) => {
      const meta = reasonMeta[alert.reason] ?? reasonMeta.new;
      const product = alert.product ?? {};
      const category = getKomplettDemoCategory(alert.categoryId);
      const reasonLine = alert.reason === 'price-drop'
        ? `📉 Price drop ${formatPercent(alert.dropPercent)} (was ${formatSek(alert.previousPriceSek)})`
        : alert.reason === 'back-in-stock' ? '🔁 Back in stock' : null;
      const fields = [
        { name: 'Price', value: formatSek(product.priceSek), inline: true }
      ];
      if (alert.reason === 'price-drop') {
        fields.push({ name: 'Was', value: formatSek(alert.previousPriceSek), inline: true });
      }
      fields.push(
        { name: 'Stock', value: String(product.availabilityText || (product.inStock ? 'In stock' : 'Out of stock')).slice(0, 1024), inline: true },
        { name: 'Category', value: category ? `${category.groupLabel} › ${category.label}` : String(alert.categoryId ?? '—'), inline: true },
        { name: 'Condition', value: 'B-grade / demo', inline: true }
      );
      return {
        title: String(product.title ?? 'Komplett demo product').slice(0, 256),
        url: product.url,
        description: ['Komplett demovaror', reasonLine].filter(Boolean).join('\n'),
        color: meta.color,
        fields,
        image: product.imageUrl ? { url: product.imageUrl } : undefined,
        footer: { text: `Komplett demo · B-grade${product.id ? ` · ${product.id}` : ''}` },
        timestamp: new Date().toISOString()
      };
    };

    let sent = 0, failed = 0;
    const errors = [];
    for (let start = 0; start < alerts.length; start += 10) {
      const batch = alerts.slice(start, start + 10);
      const first = reasonMeta[batch[0].reason] ?? reasonMeta.new;
      const content = batch.length === 1
        ? `${first.emoji} **Komplett demo** — ${batch[0].reason === 'price-drop' ? `${first.text} ${formatPercent(batch[0].dropPercent)}` : first.text}`
        : `${first.emoji} **Komplett demo** — ${batch.length} updates`;
      try {
        await this.#postWebhook({
          username: 'Price Watcher',
          content,
          allowed_mentions: { parse: [] },
          embeds: batch.map(buildEmbed)
        }, webhook);
        batch.forEach((_, offset) => { delivered[start + offset] = true; });
        sent += batch.length;
      } catch (error) {
        failed += batch.length;
        this.#recordError(errors, error);
      }
    }

    return { sent, failed, skipped: 0, errors, delivered };
  }

  /** Send instant stock alert for an NVIDIA Founders Edition GPU drop. */
  async notifyNvidiaStockDrop({ card, webhookUrl }) {
    const targetWebhook = webhookUrl || this.webhookUrl;
    if (!targetWebhook) {
      throw new Error('No Discord webhook URL configured');
    }

    const priceFormatted = card.priceSek ? `${Number(card.priceSek).toLocaleString('sv-SE')} SEK` : 'MSRP';
    const storeLink = card.product_url || card.store_url || 'https://marketplace.nvidia.com/';

    const payload = {
      username: 'NVIDIA FE Alert',
      avatar_url: 'https://images.nvidia.com/aem-dam/Solutions/geforce/rtx-5090/geforce-rtx-5090-product-gallery-full-1.png',
      content: `🚨 **NVIDIA Founders Edition Stock Alert!** 🎯 @everyone`,
      embeds: [
        {
          title: `🟢 ${card.fullName || card.name} is IN STOCK!`,
          url: storeLink,
          description: `Direct NVIDIA Store stock detected!\n\n👉 **[CLICK HERE TO BUY DIRECTLY ON NVIDIA STORE](${storeLink})**`,
          color: 0x76b900,
          fields: [
            { name: 'Model', value: card.name || card.cardKey, inline: true },
            { name: 'Price', value: priceFormatted, inline: true },
            { name: 'Region', value: (card.locale || 'sv-se').toUpperCase(), inline: true },
            { name: 'SKU', value: `\`${card.sku}\``, inline: true },
            { name: 'Status', value: '🟢 **IN STOCK**', inline: true },
            { name: 'Store Link', value: `[Direct Checkout](${storeLink})`, inline: true }
          ],
          thumbnail: card.imageUrl ? { url: card.imageUrl } : undefined,
          footer: {
            text: 'Swedish Price Watcher • NVIDIA FE Live Poller'
          },
          timestamp: new Date().toISOString()
        }
      ]
    };

    return this.#postWebhook(payload, targetWebhook);
  }

  /** Send test notification to verify Discord webhook configuration for NVIDIA tracker. */
  async testNvidiaWebhook({ webhookUrl }) {
    const targetWebhook = webhookUrl || this.webhookUrl;
    if (!targetWebhook) {
      throw new Error('No Discord webhook URL configured');
    }

    const payload = {
      username: 'NVIDIA FE Alert',
      avatar_url: 'https://images.nvidia.com/aem-dam/Solutions/geforce/rtx-5090/geforce-rtx-5090-product-gallery-full-1.png',
      content: `🧪 **Test Notification from NVIDIA Founders Edition Tracker**`,
      embeds: [
        {
          title: '✅ Discord Integration Verified!',
          description: 'Your Discord webhook is working properly. When any monitored NVIDIA Founders Edition GPU comes into stock, instant drop alerts will be posted here automatically.',
          color: 0x76b900,
          fields: [
            { name: 'Integration', value: 'Notify-FE Scheduler', inline: true },
            { name: 'Status', value: '🟢 Connected', inline: true },
            { name: 'Time', value: new Date().toLocaleTimeString('sv-SE'), inline: true }
          ],
          footer: {
            text: 'Swedish Price Watcher • NVIDIA FE Live Poller'
          },
          timestamp: new Date().toISOString()
        }
      ]
    };

    return this.#postWebhook(payload, targetWebhook);
  }

  /**
   * Work out the purchase line (if any) to add to an alert's embed.
   *
   * `deep-link`     → nothing extra.
   * `armed`         → a reminder that the listing can be staged from the dashboard.
   * `cart-staging`  → stage the basket right now so the alert already contains
   *                   a checkout link.
   *
   * @returns {Promise<string|null>}
   */
  async #resolvePurchaseNote({ item, purchase, stageListing }) {
    if (!purchase) return null;

    const arm = purchase.armed?.[item.listingKey];
    if (!arm) return null;

    const mode = arm.mode ?? purchase.mode ?? 'deep-link';
    if (mode === 'deep-link') return null;

    if (mode === 'cart-staging' && typeof stageListing === 'function') {
      try {
        const result = await stageListing({ listingKey: item.listingKey, arm, via: 'alert' });
        return result?.ok
          ? `🛒 Cart staged — complete payment: ${result.checkoutUrl}`
          : `⚠️ Auto-staging refused: ${result?.message ?? result?.reason ?? 'unknown reason'}`;
      } catch (error) {
        return `⚠️ Auto-staging failed: ${error.message}`;
      }
    }

    return mode === 'armed' ? '⚡ Armed — stage from the dashboard.' : null;
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
