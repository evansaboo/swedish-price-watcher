import {
  fetchDynamicSkus,
  resolveCardSku,
  queryNvidiaFeInventory,
  CARD_METADATA,
  GPU_DISPLAY_ORDER
} from '../sources/nvidia.js';
import { normalizeNvidiaConfig } from './nvidiaConfig.js';

export function createNvidiaPoller({
  getConfig,
  notifier,
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => Date.now(),
}) {
  let timer = null;
  let started = false;
  let inFlight = false;
  const previousState = new Map(); // cardKey -> { available: boolean, api_reachable: boolean }

  const status = {
    running: false,
    lastPollStartedAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    nextPollAt: null,
    pollCount: 0,
    cards: []
  };

  function scheduleNext(delayMs) {
    if (!started) return;
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
    status.nextPollAt = new Date(now() + delayMs).toISOString();
    timer = setTimeoutFn(executePoll, delayMs);
    if (timer?.unref) timer.unref();
  }

  async function executePoll() {
    if (!started || inFlight) return;
    const rawConfig = getConfig();
    const config = normalizeNvidiaConfig(rawConfig);

    if (!config.enabled) {
      status.running = false;
      status.nextPollAt = null;
      return;
    }

    inFlight = true;
    status.running = true;
    status.lastPollStartedAt = new Date(now()).toISOString();

    try {
      const locale = config.locale || 'sv-se';
      const monitoredCards = config.monitoredCards?.length ? config.monitoredCards : ['5090', '5080', '5070'];
      const dynamicSkus = await fetchDynamicSkus();

      // We query all display order cards or the monitored cards to populate the full card status
      const cardsToQuery = Array.from(new Set([...monitoredCards, ...GPU_DISPLAY_ORDER]));

      const cardSkus = cardsToQuery.map((cardKey) => ({
        cardKey,
        sku: resolveCardSku(cardKey, locale, dynamicSkus),
        meta: CARD_METADATA[cardKey]
      }));

      const uniqueSkus = Array.from(new Set(cardSkus.map((c) => c.sku)));
      const inventory = await queryNvidiaFeInventory(uniqueSkus, locale, { timeoutMs: 10000 });

      const cardsSummary = [];
      const stockDrops = [];

      for (const { cardKey, sku, meta } of cardSkus) {
        const raw = inventory.results?.[sku];
        const item = raw?.listMap?.[0] || null;
        const isAvailable = Boolean(item?.is_active === 'true' || item?.is_active === true);
        const apiReachable = Boolean(raw && !raw.error);
        const parsedPrice = item?.price ? Number(item.price) : NaN;
        const isRealPrice = Number.isFinite(parsedPrice) && parsedPrice > 0 && parsedPrice < 900000;
        const productUrl = isAvailable && item?.product_url ? item.product_url : null;
        const isMonitored = monitoredCards.includes(cardKey);

        const cardInfo = {
          cardKey,
          name: meta?.shortName || `RTX ${cardKey} FE`,
          fullName: meta?.name || `NVIDIA GeForce RTX ${cardKey} Founders Edition`,
          sku,
          available: isAvailable,
          api_reachable: apiReachable,
          isMonitored,
          product_url: productUrl,
          store_url: meta?.defaultUrl,
          priceSek: isAvailable && isRealPrice ? parsedPrice : meta?.msrpSek,
          msrpSek: meta?.msrpSek,
          imageUrl: meta?.imageUrl,
          locale,
          last_checked: new Date(now()).toISOString()
        };
        cardsSummary.push(cardInfo);

        const prevState = previousState.get(cardKey);

        // Check stock availability transition for monitored cards:
        // was out of stock (or first check) and is now in stock!
        if (isMonitored && isAvailable && (!prevState || !prevState.available)) {
          stockDrops.push(cardInfo);
        }

        // Check API unreachable alert
        if (config.apiAlarmEnabled && isMonitored && prevState && prevState.api_reachable && !apiReachable) {
          logger.warn(`[nvidiaPoller] NVIDIA API became unreachable for ${cardKey}`);
        }

        previousState.set(cardKey, { available: isAvailable, api_reachable: apiReachable });
      }

      status.cards = cardsSummary;
      status.lastSuccessAt = new Date(now()).toISOString();
      status.lastError = null;
      status.pollCount += 1;

      // Dispatch Discord notifications if any stock drop occurred
      if (stockDrops.length > 0 && config.notifyOnStock !== false && notifier) {
        for (const dropCard of stockDrops) {
          try {
            logger.info(`[nvidiaPoller] 🎯 ${dropCard.name} is IN STOCK! Sending Discord notification.`);
            await notifier.notifyNvidiaStockDrop({
              card: dropCard,
              webhookUrl: config.discordWebhookUrl
            });
          } catch (notifErr) {
            logger.error(`[nvidiaPoller] Failed to send Discord notification:`, notifErr.message);
          }
        }
      }
    } catch (err) {
      status.lastErrorAt = new Date(now()).toISOString();
      status.lastError = err.message;
      logger.error(`[nvidiaPoller] Error during poll:`, err.message);
    } finally {
      inFlight = false;
      const intervalMs = Math.max(5, config.intervalSeconds || 15) * 1000;
      scheduleNext(intervalMs);
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      const config = normalizeNvidiaConfig(getConfig());
      if (config.enabled) {
        status.running = true;
        scheduleNext(100);
      }
    },
    stop() {
      started = false;
      status.running = false;
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
      status.nextPollAt = null;
    },
    restart() {
      this.stop();
      this.start();
    },
    triggerNow() {
      if (timer) clearTimeoutFn(timer);
      return executePoll();
    },
    getStatus() {
      const config = normalizeNvidiaConfig(getConfig());
      return {
        ...status,
        enabled: config.enabled,
        intervalSeconds: config.intervalSeconds,
        locale: config.locale,
        monitoredCards: config.monitoredCards,
        discordWebhookUrl: config.discordWebhookUrl ? '***configured***' : ''
      };
    }
  };
}
