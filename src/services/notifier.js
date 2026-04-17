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

export class DiscordNotifier {
  constructor({ webhookUrl, cooldownHours }) {
    this.webhookUrl = webhookUrl;
    this.cooldownMs = cooldownHours * 60 * 60 * 1000;
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

    return {
      sent: amazingDealsSummary.sent + newListingsSummary.sent + favoriteCategoryEvents.sent,
      skipped: amazingDealsSummary.skipped + newListingsSummary.skipped + favoriteCategoryEvents.skipped,
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
        reason: 'discord-webhook-not-configured'
      };
    }

    const now = Date.now();
    let sent = 0;
    let skipped = 0;

    for (const deal of amazingDeals) {
      const notificationKey = `${deal.listingKey}:${deal.currentPriceSek}`;
      const previousSentAt = state.notifications[notificationKey];

      if (previousSentAt && now - Date.parse(previousSentAt) < this.cooldownMs) {
        skipped += 1;
        continue;
      }

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
            ]
          }
        ]
      });

      state.notifications[notificationKey] = new Date(now).toISOString();
      sent += 1;
    }

    return { sent, skipped };
  }

  async notifyNewListings(newItems, state, sources, sourceMap = new Map()) {
    const items = newItems.filter((item) => sources.some((source) => source.id === item.sourceId));

    if (!this.webhookUrl) {
      return {
        sent: 0,
        skipped: items.length,
        reason: 'discord-webhook-not-configured'
      };
    }

    let sent = 0;
    let skipped = 0;
    let messages = 0;
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

        for (const item of batch) {
          state.notifications[`${item.listingKey}:new-listing`] = new Date(now).toISOString();
          sent += 1;
        }

        messages += 1;
      }
    }

    return { sent, skipped, messages };
  }

  async notifyFavoriteCategoryEvents({ newItems, priceDrops, favoriteCategories, allowedSourceIds, state }) {
    const favoriteCategorySet = asFavoriteCategorySet(favoriteCategories);
    const allowedSources = allowedSourceIds instanceof Set ? allowedSourceIds : null;
    const sourceAllowed = (sourceId) => !allowedSources || allowedSources.has(sourceId);

    if (!favoriteCategorySet.size) {
      return {
        sent: 0,
        skipped: 0,
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
        reason: 'discord-webhook-not-configured'
      };
    }

    let sent = 0;
    let skipped = 0;
    let newListingEvents = 0;
    let priceDropEvents = 0;

    for (const { item, discount } of favoriteNewItems) {
      const notificationKey = `${item.listingKey}:favorite-new:${item.latestPriceSek}`;

      if (state.notifications[notificationKey]) {
        skipped += 1;
        continue;
      }

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

      state.notifications[notificationKey] = new Date().toISOString();
      sent += 1;
      priceDropEvents += 1;
    }

    return {
      sent,
      skipped,
      newListingEvents,
      priceDropEvents
    };
  }

  async #postWebhook(payload) {
    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Discord webhook returned ${response.status} ${response.statusText}`);
    }
  }
}
