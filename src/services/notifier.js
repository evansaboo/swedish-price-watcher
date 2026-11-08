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

/** File name for a Komplett alert image attachment (extension from its type). */
function komplettAttachmentName(id, image) {
  const ext = /png/.test(image?.contentType ?? '') ? 'png' : /webp/.test(image?.contentType ?? '') ? 'webp' : 'jpg';
  return `komplett-${String(id).replace(/[^0-9a-z-]/gi, '')}.${ext}`;
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
  async notifyKomplettDemo({ alerts = [], webhookUrl, images = {} } = {}) {
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
      const isDeal = (alert.feed ?? product.feed) === 'deals';
      const category = getKomplettDemoCategory(alert.categoryId);
      const reasonLine = alert.reason === 'price-drop'
        ? `📉 Price drop ${formatPercent(alert.dropPercent)} (was ${formatSek(alert.previousPriceSek)})`
        : alert.reason === 'back-in-stock' ? '🔁 Back in stock' : null;
      const fields = [
        { name: 'Price', value: formatSek(product.priceSek), inline: true }
      ];
      if (isDeal && Number.isFinite(product.listPriceSek) && product.listPriceSek > product.priceSek) {
        const pct = product.discountPct ?? Math.round((1 - product.priceSek / product.listPriceSek) * 100);
        fields.push({ name: 'Ordinary', value: `${formatSek(product.listPriceSek)} (−${pct}%)`, inline: true });
      }
      if (alert.reason === 'price-drop') {
        fields.push({ name: 'Was', value: formatSek(alert.previousPriceSek), inline: true });
      }
      fields.push(
        { name: 'Stock', value: String(product.availabilityText || (product.inStock ? 'In stock' : 'Out of stock')).slice(0, 1024), inline: true },
        { name: 'Category', value: category ? `${category.groupLabel} › ${category.label}` : String(alert.categoryId ?? '—'), inline: true },
        { name: 'Condition', value: isDeal ? 'Kampanj' : 'B-grade / demo', inline: true }
      );
      if (Array.isArray(alert.groups) && alert.groups.length > 0) {
        const names = alert.groups.map((g) => (typeof g === 'string' ? g : g.name || g.id)).filter(Boolean);
        if (names.length > 0) {
          fields.push({ name: 'Watch group(s)', value: names.join(', ').slice(0, 1024), inline: false });
        }
      }
      return {
        title: String(product.title ?? (isDeal ? 'Komplett deal' : 'Komplett demo product')).slice(0, 256),
        url: product.url,
        description: [isDeal ? 'Komplett kampanj' : 'Komplett demovaror', reasonLine].filter(Boolean).join('\n'),
        color: meta.color,
        fields,
        // An attached file (see `images`) renders; a komplett.se URL doesn't,
        // because Discord's image proxy is blocked by Komplett.
        image: images[String(product.id)]
          ? { url: `attachment://${komplettAttachmentName(product.id, images[String(product.id)])}` }
          : (product.imageUrl ? { url: product.imageUrl } : undefined),
        footer: { text: `${isDeal ? 'Komplett deal · Kampanj' : 'Komplett demo · B-grade'}${product.id ? ` · ${product.id}` : ''}` },
        timestamp: new Date().toISOString()
      };
    };

    let sent = 0, failed = 0;
    const errors = [];
    for (let start = 0; start < alerts.length; start += 10) {
      const batch = alerts.slice(start, start + 10);
      const first = reasonMeta[batch[0].reason] ?? reasonMeta.new;
      const isDealBatch = (batch[0].feed ?? batch[0].product?.feed) === 'deals';
      const label = isDealBatch ? 'Komplett deal' : 'Komplett demo';
      const firstText = batch[0].reason === 'new' && isDealBatch ? 'new deal' : first.text;
      const content = batch.length === 1
        ? `${first.emoji} **${label}** — ${batch[0].reason === 'price-drop' ? `${firstText} ${formatPercent(batch[0].dropPercent)}` : firstText}`
        : `${first.emoji} **${label}** — ${batch.length} updates`;
      try {
        const files = batch
          .map((alert) => {
            const id = String(alert.product?.id ?? '');
            const image = images[id];
            return image ? { name: komplettAttachmentName(id, image), data: image.data, contentType: image.contentType } : null;
          })
          .filter(Boolean)
          .filter((file, index, all) => all.findIndex((other) => other.name === file.name) === index);
        await this.#postWebhook({
          username: 'Price Watcher',
          content,
          allowed_mentions: { parse: [] },
          embeds: batch.map(buildEmbed)
        }, webhook, files);
        batch.forEach((_, offset) => { delivered[start + offset] = true; });
        sent += batch.length;
      } catch (error) {
        failed += batch.length;
        this.#recordError(errors, error);
      }
    }

    return { sent, failed, skipped: 0, errors, delivered };
  }

  /**
   * Inet watcher alerts (see services/inetPoller.js): campaign deals and
   * Fyndhörnan outlet items matching the user's watch groups.
   *
   * `alerts` are `{ reason: 'new'|'price-drop'|'back-in-stock', product, feed,
   * groupNames, previousPriceSek?, dropPercent? }`. Discord's proxy can load
   * cdn.inet.se itself, so the image is a plain embed URL. Batches of up to 10
   * embeds per message; mentions are disabled outright.
   *
   * @returns {{ sent, failed, skipped, errors, delivered: boolean[], reason? }}
   */
  async notifyInet({ alerts = [], webhookUrl, catalog = {} } = {}) {
    const delivered = alerts.map(() => false);
    const webhook = normalizeWebhookUrl(webhookUrl) || this.webhookUrl;
    if (!webhook) {
      return { sent: 0, failed: 0, skipped: alerts.length, errors: [], delivered, reason: 'no-webhook' };
    }

    const reasonMeta = {
      'new': { emoji: '🆕', text: 'new find', color: 0x22c55e },
      'price-drop': { emoji: '📉', text: 'price drop', color: 0xf59e0b },
      'back-in-stock': { emoji: '🔁', text: 'back in stock', color: 0x3b82f6 }
    };
    const feedLabel = (feed) => (feed === 'outlet' ? 'Inet outlet' : 'Inet deal');

    const buildEmbed = (alert) => {
      const meta = reasonMeta[alert.reason] ?? reasonMeta.new;
      const product = alert.product ?? {};
      const isOutlet = alert.feed === 'outlet';
      const reasonLine = alert.reason === 'price-drop'
        ? `📉 Price drop ${formatPercent(alert.dropPercent)} (was ${formatSek(alert.previousPriceSek)})`
        : alert.reason === 'back-in-stock' ? '🔁 Back in stock' : null;
      const category = catalog?.[String(product.templateId ?? '')]?.name ?? null;
      const ordinary = Number.isFinite(product.listPriceSek) && product.listPriceSek > product.priceSek
        ? `${formatSek(product.listPriceSek)} (−${product.discountPct ?? Math.round((1 - product.priceSek / product.listPriceSek) * 100)}%)`
        : '—';
      // Outlet units are held in a store, not in web stock.
      const stock = product.inWebStock
        ? `${Number.isFinite(product.webQty) ? product.webQty : 'In'} in web stock`
        : product.storeQty > 0
          ? `None online · ${product.storeQty} in store`
          : 'Out of stock';
      const fields = [
        { name: 'Price', value: formatSek(product.priceSek), inline: true },
        { name: 'Ordinary', value: ordinary, inline: true },
        { name: 'Feed', value: isOutlet ? 'Fyndhörnan' : 'Kampanj', inline: true }
      ];
      if (isOutlet && product.sellingPoint) {
        fields.push({ name: 'Condition', value: String(product.sellingPoint).slice(0, 1024), inline: false });
      }
      fields.push({ name: 'Stock', value: stock, inline: true });
      if (category) fields.push({ name: 'Category', value: category.slice(0, 1024), inline: true });
      if (alert.groupNames?.length) {
        fields.push({ name: alert.groupNames.length === 1 ? 'Watch group' : 'Watch groups', value: alert.groupNames.join(', ').slice(0, 1024), inline: false });
      }
      return {
        title: String(product.title ?? 'Inet product').slice(0, 256),
        url: product.url,
        description: [isOutlet ? 'Inet Fyndhörnan' : 'Inet kampanj', reasonLine].filter(Boolean).join('\n'),
        color: meta.color,
        fields,
        image: product.imageUrl ? { url: product.imageUrl } : undefined,
        footer: { text: `${feedLabel(alert.feed)}${product.id ? ` · ${product.id}` : ''}` },
        timestamp: new Date().toISOString()
      };
    };

    let sent = 0, failed = 0;
    const errors = [];
    for (let start = 0; start < alerts.length; start += 10) {
      const batch = alerts.slice(start, start + 10);
      const first = reasonMeta[batch[0].reason] ?? reasonMeta.new;
      const feeds = new Set(batch.map((alert) => alert.feed));
      const label = feeds.size === 1 ? feedLabel(batch[0].feed) : 'Inet';
      const content = batch.length === 1
        ? `${first.emoji} **${label}** — ${batch[0].reason === 'price-drop' ? `${first.text} ${formatPercent(batch[0].dropPercent)}` : first.text}`
        : `${first.emoji} **${label}** — ${batch.length} updates`;
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

  /**
   * Webhallen watcher alerts (see services/webhallenPoller.js): campaign deals
   * and Fyndvaror outlet items matching the user's watch groups.
   *
   * @returns {{ sent, failed, skipped, errors, delivered: boolean[], reason? }}
   */
  async notifyWebhallen({ alerts = [], webhookUrl, catalog = {} } = {}) {
    const delivered = alerts.map(() => false);
    const webhook = normalizeWebhookUrl(webhookUrl) || this.webhookUrl;
    if (!webhook) {
      return { sent: 0, failed: 0, skipped: alerts.length, errors: [], delivered, reason: 'no-webhook' };
    }

    const reasonMeta = {
      'new': { emoji: '🆕', text: 'new find', color: 0x22c55e },
      'price-drop': { emoji: '📉', text: 'price drop', color: 0xf59e0b },
      'back-in-stock': { emoji: '🔁', text: 'back in stock', color: 0x3b82f6 }
    };
    const feedLabel = (feed) => (feed === 'outlet' ? 'Webhallen outlet' : 'Webhallen deal');

    const buildEmbed = (alert) => {
      const meta = reasonMeta[alert.reason] ?? reasonMeta.new;
      const product = alert.product ?? {};
      const isOutlet = alert.feed === 'outlet';
      const reasonLine = alert.reason === 'price-drop'
        ? `📉 Price drop ${formatPercent(alert.dropPercent)} (was ${formatSek(alert.previousPriceSek)})`
        : alert.reason === 'back-in-stock' ? '🔁 Back in stock' : null;
      const category = product.categoryName ?? catalog?.[String(product.categoryId ?? '')]?.name ?? null;
      const ordinary = Number.isFinite(product.listPriceSek) && product.listPriceSek > product.priceSek
        ? `${formatSek(product.listPriceSek)} (−${product.discountPct ?? Math.round((1 - product.priceSek / product.listPriceSek) * 100)}%)`
        : '—';
      const stock = product.inWebStock
        ? `${Number.isFinite(product.webQty) ? product.webQty : 'In'} in web stock`
        : product.storeQty > 0
          ? `None online · ${product.storeQty} in store`
          : 'Out of stock';
      const fields = [
        { name: 'Price', value: formatSek(product.priceSek), inline: true },
        { name: 'Ordinary', value: ordinary, inline: true },
        { name: 'Feed', value: isOutlet ? 'Fyndvaror' : 'Kampanjer', inline: true }
      ];
      if (isOutlet && product.sellingPoint) {
        fields.push({ name: 'Condition', value: String(product.sellingPoint).slice(0, 1024), inline: false });
      }
      fields.push({ name: 'Stock', value: stock, inline: true });
      if (category) fields.push({ name: 'Category', value: category.slice(0, 1024), inline: true });
      if (alert.groupNames?.length) {
        fields.push({
          name: alert.groupNames.length === 1 ? 'Watch group' : 'Watch groups',
          value: alert.groupNames.join(', ').slice(0, 1024),
          inline: false
        });
      }
      return {
        title: String(product.title ?? 'Webhallen product').slice(0, 256),
        url: product.url,
        description: [isOutlet ? 'Webhallen Fyndvaror' : 'Webhallen kampanj', reasonLine].filter(Boolean).join('\n'),
        color: meta.color,
        fields,
        image: product.imageUrl ? { url: product.imageUrl } : undefined,
        footer: { text: `${feedLabel(alert.feed)}${product.id ? ` · ${product.id}` : ''}` },
        timestamp: new Date().toISOString()
      };
    };

    let sent = 0, failed = 0;
    const errors = [];
    for (let start = 0; start < alerts.length; start += 10) {
      const batch = alerts.slice(start, start + 10);
      const first = reasonMeta[batch[0].reason] ?? reasonMeta.new;
      const feeds = new Set(batch.map((alert) => alert.feed));
      const label = feeds.size === 1 ? feedLabel(batch[0].feed) : 'Webhallen';
      const content = batch.length === 1
        ? `${first.emoji} **${label}** — ${batch[0].reason === 'price-drop' ? `${first.text} ${formatPercent(batch[0].dropPercent)}` : first.text}`
        : `${first.emoji} **${label}** — ${batch.length} updates`;
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

  async #postWebhook(payload, webhookUrl = this.webhookUrl, files = []) {
    for (let attempt = 0; attempt <= this.webhookMaxRetries; attempt += 1) {
      let init;
      if (files.length) {
        // multipart/form-data with payload_json plus files[n]; embeds refer to
        // them as attachment://<name>. Rebuilt per attempt (a body is single-use).
        const form = new FormData();
        form.append('payload_json', JSON.stringify(payload));
        files.forEach((file, index) => {
          form.append(`files[${index}]`, new Blob([file.data], { type: file.contentType || 'application/octet-stream' }), file.name);
        });
        init = { method: 'POST', body: form, redirect: 'error' };
      } else {
        init = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          redirect: 'error'
        };
      }
      const response = await fetch(webhookUrl, init);

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
