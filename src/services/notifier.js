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

/**
 * Returns the first matching category webhook URL from the configured mappings,
 * or null if no pattern matches the given category string.
 * Pattern matching is bidirectional case-insensitive substring.
 */
function resolveCategoryWebhook(category, categoryWebhooks) {
  if (!category || !Array.isArray(categoryWebhooks) || !categoryWebhooks.length) return null;
  const cat = String(category).toLowerCase();
  for (const { pattern, webhook } of categoryWebhooks) {
    if (!pattern || !webhook) continue;
    const pat = String(pattern).toLowerCase();
    if (cat.includes(pat) || pat.includes(cat)) return webhook;
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

  async notifyScan({ deals, newItems, priceDrops = [], sources, state, notificationSettings }) {
    // By default global "new-listings" posts are disabled. Enable via notificationSettings.enableGlobalNewListings = true
    const enabledSources = sources.filter((source) => source.enabled);
    const sourceMap = new Map(enabledSources.map((source) => [source.id, source]));
    const favoriteCategories = state.preferences?.favoriteCategories ?? [];

    const settings = notificationSettings ?? {};
    const categoryWebhooks = Array.isArray(settings.categoryWebhooks) ? settings.categoryWebhooks : [];
    const notifFilter = settings.schedulerNotificationTypes ?? null;
    const favoritesAllowed = !notifFilter || notifFilter.favorites !== false;
    const keywordsAllowed = !notifFilter || notifFilter.keywords !== false;
    const categoriesAllowed = !notifFilter || notifFilter.categories !== false;

    // Conditionally send global new-listings if explicitly enabled in settings and allowed
    const enableGlobalNewListings = Boolean(settings.enableGlobalNewListings);
    let newListingsSummary = { sent: 0, skipped: newItems.length, failed: 0, errors: [], reason: 'disabled-by-config' };

    if (enableGlobalNewListings && categoriesAllowed) {
      const newListingSources = enabledSources.filter((source) => source.notificationMode === 'new-listings');
      newListingsSummary = await this.notifyNewListings(newItems, state, newListingSources, sourceMap);
    } else if (enableGlobalNewListings && !categoriesAllowed) {
      newListingsSummary = { sent: 0, skipped: newItems.length, failed: 0, errors: [], reason: 'skipped-by-filter' };
    }

    const favoriteCategoryEvents = favoritesAllowed
      ? await this.notifyFavoriteCategoryEvents({
          newItems,
          priceDrops,
          favoriteCategories,
          allowedSourceIds: null,
          categoryWebhooks,
          state
        })
      : { sent: 0, skipped: newItems.length + priceDrops.length, failed: 0, errors: [], reason: 'skipped-by-filter' };

    const keywords = Array.isArray(settings.keywords) ? settings.keywords.filter((k) => k.enabled) : [];
    const keywordWebhook = typeof settings.keywordWebhook === 'string' ? settings.keywordWebhook.trim() : '';
    const keywordSummary = keywordsAllowed ? await this.notifyKeywordMatches({ newItems, state, keywordWebhook, keywords }) : { sent: 0, skipped: newItems.length, failed: 0, errors: [], reason: 'skipped-by-filter' };

    const errors = [
      ...(newListingsSummary.errors ?? []),
      ...(favoriteCategoryEvents.errors ?? []),
      ...(keywordSummary.errors ?? [])
    ].slice(0, 10);

    return {
      sent: (newListingsSummary.sent ?? 0) + (favoriteCategoryEvents.sent ?? 0) + (keywordSummary.sent ?? 0),
      skipped: (newListingsSummary.skipped ?? 0) + (favoriteCategoryEvents.skipped ?? 0) + (keywordSummary.skipped ?? 0),
      failed: (newListingsSummary.failed ?? 0) + (favoriteCategoryEvents.failed ?? 0) + (keywordSummary.failed ?? 0),
      errors,
      newListings: newListingsSummary,
      favoriteCategoryEvents,
      keywordMatches: keywordSummary
    };
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

  async notifyFavoriteCategoryEvents({ newItems, priceDrops, favoriteCategories, allowedSourceIds, categoryWebhooks = [], state }) {
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
      }));
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
        const targetWebhook = resolveCategoryWebhook(item.category, categoryWebhooks) ?? this.webhookUrl;
        await this.#postWebhook({
          username: 'Price Watcher',
          content: `Favorite category: new listing in ${item.category}`,
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
        }, targetWebhook);
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
        const targetWebhook = resolveCategoryWebhook(event.category, categoryWebhooks) ?? this.webhookUrl;
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
        }, targetWebhook);
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

  async notifyKeywordMatches({ newItems, state, keywordWebhook, keywords }) {
    if (!keywordWebhook || !keywords.length) {
      return { sent: 0, skipped: 0, failed: 0, errors: [], reason: 'no-keyword-webhook-or-keywords' };
    }

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];
    const now = Date.now();

    for (const { keyword, id, categories, category } of keywords) {
      const kw = keyword.toLowerCase();
      // Support both legacy `category` string and new `categories` array
      const cats = Array.isArray(categories) ? categories : (category ? [category] : []);
      const matches = newItems.filter((item) => {
        if (!String(item.title ?? '').toLowerCase().includes(kw)) return false;
        if (cats.length && !cats.some((c) => String(item.category ?? '').toLowerCase() === c.toLowerCase())) return false;
        return true;
      });

      for (const item of matches) {
        const catKey = cats.length ? cats.join(',') : '';
        const notificationKey = `${item.listingKey}:keyword:${kw}${catKey ? `:${catKey}` : ''}`;
        const previousSentAt = state.notifications[notificationKey];

        if (previousSentAt && now - Date.parse(previousSentAt) < this.cooldownMs) {
          skipped += 1;
          continue;
        }

        const discount = getDiscountSummary(item);
        const catDisplay = cats.length ? cats.join(', ') : null;
        const keywordDisplay = catDisplay ? `${keyword} (in ${catDisplay})` : keyword;

        try {
          await this.#postWebhook({
            username: 'Price Watcher',
            content: `🔍 Keyword alert: **${keyword}**${catDisplay ? ` · ${catDisplay}` : ''}`,
            embeds: [
              {
                title: item.title,
                url: item.url,
                description: `${item.sourceLabel} • ${item.category}`,
                color: 0x5865f2,
                fields: [
                  { name: 'Keyword', value: keywordDisplay, inline: true },
                  { name: 'Price', value: formatSek(item.latestPriceSek ?? item.priceSek), inline: true },
                  { name: 'Initial', value: formatSek(discount.initialPriceSek), inline: true },
                  { name: 'Discount %', value: formatPercent(discount.discountPercent), inline: true },
                  { name: 'First seen', value: new Date(item.firstSeenAt ?? item.seenAt).toLocaleString('sv-SE'), inline: true }
                ],
                image: item.imageUrl ? { url: item.imageUrl } : undefined
              }
            ]
          }, keywordWebhook);
        } catch (error) {
          failed += 1;
          this.#recordError(errors, error);
          continue;
        }

        state.notifications[notificationKey] = new Date(now).toISOString();
        sent += 1;
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
