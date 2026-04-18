import { firstFinite, formatSek } from '../lib/utils.js';

function normalizeCategoryKey(category) {
  return String(category ?? '').trim().toLowerCase();
}

function asFavoriteCategorySet(categories = []) {
  return new Set(
    categories
      .map((category) => normalizeCategoryKey(category))
      .filter(Boolean)
  );
}

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

  async notifyScan({ deals, newItems, priceDrops = [], sources, state }) {
    const enabledSources = sources.filter((source) => source.enabled);
    const sourceMap = new Map(enabledSources.map((source) => [source.id, source]));
    const favoriteCategories = state.preferences?.favoriteCategories ?? [];
    const amazingDealSourceIds = new Set(
      enabledSources
        .filter((source) => (source.notificationMode ?? 'amazing-deals') === 'amazing-deals')
        .map((source) => source.id)
    );
    const newListingSources = enabledSources.filter((source) => source.notificationMode === 'new-listings');
    const favoriteEventSourceIds = new Set(
      enabledSources
        .filter((source) => source.notificationMode === 'favorite-events')
        .map((source) => source.id)
    );
    const favoriteCategoryEvents = await this.notifyFavoriteCategoryEvents({
      newItems,
      priceDrops,
      favoriteCategories,
      allowedSourceIds: favoriteEventSourceIds,
      state
    });
    const amazingDealsSummary = await this.notifyAmazingDeals(deals, state, amazingDealSourceIds);
    const newListingsSummary = await this.notifyNewListings(newItems, state, newListingSources, sourceMap);
    const errors = [
      ...(amazingDealsSummary.errors ?? []),
      ...(newListingsSummary.errors ?? []),
      ...(favoriteCategoryEvents.errors ?? [])
    ].slice(0, 10);

    return {
      sent: amazingDealsSummary.sent + newListingsSummary.sent + favoriteCategoryEvents.sent,
      skipped: amazingDealsSummary.skipped + newListingsSummary.skipped + favoriteCategoryEvents.skipped,
      failed: (amazingDealsSummary.failed ?? 0) + (newListingsSummary.failed ?? 0) + (favoriteCategoryEvents.failed ?? 0),
      errors,
      amazingDeals: amazingDealsSummary,
      newListings: newListingsSummary,
      favoriteCategoryEvents
    };
  }

  async notifyAmazingDeals(deals, state, allowedSourceIds = null) {
    const amazingDeals = deals.filter((deal) => deal.amazingDeal && (!allowedSourceIds || allowedSourceIds.has(deal.sourceId)));

    if (!this.webhookUrl) {
      return {
        sent: 0,
        skipped: amazingDeals.length,
        failed: 0,
        errors: [],
        reason: 'discord-webhook-not-configured'
      };
    }

    // Cap per-scan notifications to avoid flooding Discord on first runs.
    // Group by sourceId so each store gets up to MAX_PER_SOURCE deals per scan.
    const MAX_PER_SOURCE = 25;
    const sentPerSource = new Map();
    const cappedDeals = [];
    for (const deal of amazingDeals) {
      const count = sentPerSource.get(deal.sourceId) ?? 0;
      if (count < MAX_PER_SOURCE) {
        cappedDeals.push(deal);
        sentPerSource.set(deal.sourceId, count + 1);
      }
    }

    const now = Date.now();
    let sent = 0;
    let skipped = amazingDeals.length - cappedDeals.length; // capped ones count as skipped
    let failed = 0;
    const errors = [];

    for (const deal of cappedDeals) {
      const notificationKey = `${deal.listingKey}:${deal.currentPriceSek}`;
      const previousSentAt = state.notifications[notificationKey];

      if (previousSentAt && now - Date.parse(previousSentAt) < this.cooldownMs) {
        skipped += 1;
        continue;
      }

      try {
        await this.#postWebhook({
          username: 'Price Watcher',
          content: `Amazing deal: ${deal.title}`,
          embeds: [
            {
              title: deal.title,
              url: deal.url,
              description: `${deal.sourceLabel} • ${deal.category} • ${deal.condition}`,
              fields: [
                { name: 'Current', value: formatSek(deal.currentPriceSek), inline: true },
                { name: 'Initial', value: formatSek(deal.comparisonPriceSek), inline: true },
                { name: 'Discount %', value: formatPercent(deal.discountPercent), inline: true },
                { name: 'Profit', value: formatSek(deal.profitSek), inline: true },
                { name: 'Score', value: String(deal.score), inline: true },
                { name: 'Reasons', value: deal.reasons.join(' • ') || 'No detail', inline: false }
              ],
              image: deal.imageUrl ? { url: deal.imageUrl } : undefined
            }
          ]
        });
      } catch (error) {
        failed += 1;
        this.#recordError(errors, error);
        continue;
      }

      state.notifications[notificationKey] = new Date(now).toISOString();
      sent += 1;
    }

    return { sent, skipped, failed, errors };
  }

  async notifyNewListings(newItems, state, sources, sourceMap = new Map()) {
    const items = newItems.filter((item) => sources.some((source) => source.id === item.sourceId));

    if (!this.webhookUrl) {
      return {
        sent: 0,
        skipped: items.length,
        failed: 0,
        errors: [],
        reason: 'discord-webhook-not-configured'
      };
    }

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let messages = 0;
    const errors = [];
    const now = Date.now();

    for (const source of sources) {
      const sourceItems = items.filter((item) => item.sourceId === source.id);
      const freshItems = [];

      for (const item of sourceItems) {
        const notificationKey = `${item.listingKey}:new-listing`;
        const previousSentAt = state.notifications[notificationKey];

        if (previousSentAt && now - Date.parse(previousSentAt) < this.cooldownMs) {
          skipped += 1;
          continue;
        }

        freshItems.push(item);
      }

      const batchSize = Math.min(10, Math.max(1, Number(source.notificationBatchSize ?? 5)));

      for (let index = 0; index < freshItems.length; index += batchSize) {
        const batch = freshItems.slice(index, index + batchSize);
        const label = sourceMap.get(source.id)?.label ?? source.label ?? source.id;

        try {
          await this.#postWebhook({
            username: 'Price Watcher',
            content: `${label}: ${batch.length} new outlet listing${batch.length === 1 ? '' : 's'}`,
            embeds: batch.map((item) => {
              const discount = getDiscountSummary(item);

              return {
                title: item.title,
                url: item.url,
                description: `${item.sourceLabel} • ${item.category} • ${item.condition}`,
                fields: [
                  { name: 'Price', value: formatSek(item.latestPriceSek ?? item.priceSek), inline: true },
                  { name: 'Initial', value: formatSek(discount.initialPriceSek), inline: true },
                  { name: 'Discount %', value: formatPercent(discount.discountPercent), inline: true },
                  { name: 'First seen', value: new Date(item.firstSeenAt ?? item.seenAt).toLocaleString('sv-SE'), inline: true }
                ],
                image: item.imageUrl ? { url: item.imageUrl } : undefined
              };
            })
          });
        } catch (error) {
          failed += batch.length;
          this.#recordError(errors, error);
          continue;
        }

        for (const item of batch) {
          state.notifications[`${item.listingKey}:new-listing`] = new Date(now).toISOString();
          sent += 1;
        }

        messages += 1;
      }
    }

    return { sent, skipped, failed, messages, errors };
  }

  async notifyFavoriteCategoryEvents({ newItems, priceDrops, favoriteCategories, allowedSourceIds, state }) {
    const favoriteCategorySet = asFavoriteCategorySet(favoriteCategories);
    const allowedSources = allowedSourceIds instanceof Set ? allowedSourceIds : null;
    const sourceAllowed = (sourceId) => !allowedSources || allowedSources.has(sourceId);

    if (!favoriteCategorySet.size) {
      return {
        sent: 0,
        skipped: 0,
        failed: 0,
        errors: [],
        reason: 'no-favorite-categories'
      };
    }

    const favoriteNewItems = newItems
      .filter((item) => sourceAllowed(item.sourceId) && favoriteCategorySet.has(normalizeCategoryKey(item.category)))
      .map((item) => ({
        item,
        discount: getDiscountSummary(item)
      }))
      .filter(({ discount }) => Number.isFinite(discount.discountSek) && discount.discountSek > 0);
    const favoritePriceDrops = priceDrops.filter(
      (event) => sourceAllowed(event.sourceId) && favoriteCategorySet.has(normalizeCategoryKey(event.category))
    );

    if (!this.webhookUrl) {
      return {
        sent: 0,
        skipped: favoriteNewItems.length + favoritePriceDrops.length,
        failed: 0,
        errors: [],
        reason: 'discord-webhook-not-configured'
      };
    }

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let newListingEvents = 0;
    let priceDropEvents = 0;
    const errors = [];

    for (const { item, discount } of favoriteNewItems) {
      const notificationKey = `${item.listingKey}:favorite-new:${item.latestPriceSek}`;

      if (state.notifications[notificationKey]) {
        skipped += 1;
        continue;
      }

      try {
        await this.#postWebhook({
          username: 'Price Watcher',
          content: `Favorite category update: new discounted listing in ${item.category}`,
          embeds: [
            {
              title: item.title,
              url: item.url,
              description: `${item.sourceLabel} • ${item.category}`,
              fields: [
                { name: 'Price', value: formatSek(item.latestPriceSek), inline: true },
                { name: 'Initial', value: formatSek(discount.initialPriceSek), inline: true },
                { name: 'Discount', value: formatSek(discount.discountSek), inline: true },
                { name: 'Discount %', value: formatPercent(discount.discountPercent), inline: true }
              ],
              image: item.imageUrl ? { url: item.imageUrl } : undefined
            }
          ]
        });
      } catch (error) {
        failed += 1;
        this.#recordError(errors, error);
        continue;
      }

      state.notifications[notificationKey] = new Date().toISOString();
      sent += 1;
      newListingEvents += 1;
    }

    for (const event of favoritePriceDrops) {
      const notificationKey = `${event.listingKey}:favorite-drop:${event.previousPriceSek}:${event.newPriceSek}`;

      if (state.notifications[notificationKey]) {
        skipped += 1;
        continue;
      }

      try {
        await this.#postWebhook({
          username: 'Price Watcher',
          content: `Favorite category update: price drop in ${event.category}`,
          embeds: [
            {
              title: event.title,
              url: event.url,
              description: `${event.sourceLabel} • ${event.category}`,
              fields: [
                { name: 'Previous', value: formatSek(event.previousPriceSek), inline: true },
                { name: 'Current', value: formatSek(event.newPriceSek), inline: true },
                { name: 'Drop', value: formatSek(event.dropSek), inline: true },
                { name: 'Drop %', value: `${event.dropPercent}%`, inline: true }
              ]
            }
          ]
        });
      } catch (error) {
        failed += 1;
        this.#recordError(errors, error);
        continue;
      }

      state.notifications[notificationKey] = new Date().toISOString();
      sent += 1;
      priceDropEvents += 1;
    }

    return {
      sent,
      skipped,
      failed,
      newListingEvents,
      priceDropEvents,
      errors
    };
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

  async #postWebhook(payload) {
    for (let attempt = 0; attempt <= this.webhookMaxRetries; attempt += 1) {
      const response = await fetch(this.webhookUrl, {
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
