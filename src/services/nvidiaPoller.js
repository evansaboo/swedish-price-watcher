import { createNvidiaLiveFeed, FEED_MODELS } from '../sources/nvidiaLiveFeed.js';
import { CARD_METADATA, GPU_DISPLAY_ORDER, storeUrlFor } from '../sources/nvidia.js';
import { normalizeNvidiaConfig } from './nvidiaConfig.js';

/**
 * NVIDIA Founders Edition stock tracker.
 *
 * Despite the historical name this no longer polls NVIDIA: it follows the
 * Notify-FE realtime feed (see sources/nvidiaLiveFeed.js) and sends a Discord
 * alert when a monitored card turns available. The factory signature and the
 * start/stop/restart/triggerNow/getStatus methods are kept for src/index.js
 * and src/app.js.
 */

export const NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;

const LIVE_FEED_STATUSES = new Set(['healthy', 'source_degraded', 'offline']);

/**
 * An observation is fresh when it is younger than the packet's staleAfterMs.
 * Age is measured on the server's clock (serverTime - observedAt) so a skewed
 * Pi clock can neither suppress nor fabricate alerts.
 */
export function isFreshObservation(card, packet) {
  if (!card || card.observedAt === null || card.observedAt === undefined) return false;
  const ageMs = packet.serverTime - card.observedAt;
  return ageMs >= 0 && ageMs < (packet.staleAfterMs ?? 60_000);
}

/** True when a card observation may update the known availability or alert. */
export function isTrustworthyObservation(card, packet) {
  return Boolean(
    card
    && packet
    && !packet.synthetic
    && packet.status !== 'offline'
    && card.status === 'healthy'
    && typeof card.available === 'boolean'
    && isFreshObservation(card, packet)
  );
}

function isLive(feedState) {
  return Boolean(feedState?.connected && LIVE_FEED_STATUSES.has(feedState.status) && feedState.packet);
}

function cardApiError({ config, feedState, packet, feedCard }) {
  if (!config.enabled) return 'tracker_disabled';
  if (!feedState) return 'feed_disconnected';
  if (!isLive(feedState) || !packet) {
    if (feedState.status === 'stale') return 'feed_stale';
    if ((feedState.status === 'connecting' || feedState.status === 'waiting') && !feedState.lastError) return 'feed_connecting';
    return 'feed_disconnected';
  }
  if (packet.status === 'offline') return 'feed_offline';
  if (!feedCard) return 'not_in_feed';
  if (feedCard.status !== 'healthy') return feedCard.status;
  return null;
}

/** Build the status.cards[] array the dashboard renders. */
export function mapFeedCards({ config, feedState }) {
  const packet = feedState?.packet && feedState.packet.locale === config.locale ? feedState.packet : null;
  const live = isLive(feedState) && Boolean(packet);

  return GPU_DISPLAY_ORDER.map((cardKey) => {
    const meta = CARD_METADATA[cardKey];
    const feedCard = packet?.cards?.find((c) => c.model === cardKey) ?? null;
    const apiError = cardApiError({ config, feedState, packet, feedCard });
    const available = live && packet.status !== 'offline' && feedCard?.available === true;

    return {
      cardKey,
      name: meta?.shortName || `RTX ${cardKey} FE`,
      fullName: meta?.name || `NVIDIA GeForce RTX ${cardKey} Founders Edition`,
      sku: feedCard?.sku || null,
      available,
      api_reachable: apiError === null,
      api_error: apiError,
      card_status: feedCard?.status ?? null,
      isMonitored: config.monitoredCards.includes(cardKey),
      product_url: available ? (feedCard?.productUrl ?? null) : null,
      store_url: storeUrlFor(cardKey, config.locale),
      priceSek: meta?.msrpSek,
      msrpSek: meta?.msrpSek,
      imageUrl: meta?.imageUrl,
      locale: config.locale,
      last_checked: feedCard?.observedAt ? new Date(feedCard.observedAt).toISOString() : null,
      last_available_at: feedCard?.lastAvailableAt ? new Date(feedCard.lastAvailableAt).toISOString() : null
    };
  });
}

/** Human-readable problem with the feed, or null when it is healthy. */
export function describeFeedProblem({ config, feedState }) {
  if (!config.enabled || !feedState) return null;
  const { status, lastError, packet } = feedState;
  switch (status) {
    case 'stopped':
      return null;
    case 'connecting':
    case 'waiting':
      return lastError ? `Live feed reconnecting after error: ${lastError}` : null;
    case 'disconnected':
      return `Live feed disconnected: ${lastError || 'connection closed'}`;
    case 'stale':
      return `Live feed stale: ${lastError || 'no recent packet'}`;
    case 'offline':
      return 'Notify-FE reports its NVIDIA monitor is offline';
    default:
      break;
  }

  const unhealthy = config.monitoredCards
    .map((cardKey) => {
      const card = packet?.cards?.find((c) => c.model === cardKey);
      if (!card) return `${cardKey} missing`;
      return card.status === 'healthy' ? null : `${cardKey} ${card.status}`;
    })
    .filter(Boolean);

  if (status === 'source_degraded') {
    const pct = feedState.monitorHealthPercent;
    const health = pct === null || pct === undefined ? '' : ` (${pct}% monitor health)`;
    return `Notify-FE monitor degraded${health}${unhealthy.length ? `: ${unhealthy.join(', ')}` : ''}`;
  }
  if (unhealthy.length) return `Card status: ${unhealthy.join(', ')}`;
  return null;
}

export function createNvidiaPoller({
  getConfig,
  notifier,
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => Date.now(),
  createFeed = createNvidiaLiveFeed,
  feedOptions = {},
  cooldownMs = NOTIFY_COOLDOWN_MS
}) {
  let started = false;
  let feed = null;
  let feedLocale = null;
  let feedToken = null;
  let packetCount = 0;
  // `${locale}:${model}` -> last trustworthy availability (true/false). Missing = unknown.
  const knownAvailability = new Map();
  // `${locale}:${model}` -> ms timestamp of the last alert (in flight or sent).
  const lastNotifiedAt = new Map();

  const status = {
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null
  };

  const readConfig = () => normalizeNvidiaConfig(getConfig() ?? {});

  function updateHealth(config = readConfig()) {
    const feedState = feed?.getState() ?? null;
    const problem = describeFeedProblem({ config, feedState });
    if (problem === status.lastError) return;

    if (problem) {
      status.lastErrorAt = new Date(now()).toISOString();
      if (config.apiAlarmEnabled && !status.lastError) {
        logger.warn?.(`[nvidiaPoller] ALARM: NVIDIA FE live feed unhealthy: ${problem}`);
      }
    } else if (status.lastError && LIVE_FEED_STATUSES.has(feedState?.status)) {
      // Only a real recovery; stopping or disabling the tracker also clears the error.
      logger.info?.('[nvidiaPoller] NVIDIA FE live feed healthy again.');
    }
    status.lastError = problem;
  }

  async function sendAlert({ key, previous, card, config }) {
    try {
      logger.info?.(`[nvidiaPoller] 🎯 ${card.name} is IN STOCK! Sending Discord notification.`);
      await notifier.notifyNvidiaStockDrop({ card, webhookUrl: config.discordWebhookUrl });
    } catch (err) {
      logger.error?.(`[nvidiaPoller] Failed to send Discord notification for ${card.cardKey}: ${err.message}`);
      // Let the next packet retry rather than silently swallowing the drop.
      lastNotifiedAt.delete(key);
      if (knownAvailability.get(key) === true) {
        if (previous === undefined) knownAvailability.delete(key);
        else knownAvailability.set(key, previous);
      }
    }
  }

  async function handlePacket(packet) {
    const config = readConfig();
    packetCount += 1;
    status.lastSuccessAt = new Date(now()).toISOString();
    updateHealth(config);

    if (packet.synthetic || packet.locale !== feedLocale) return;

    const drops = [];
    for (const feedCard of packet.cards) {
      if (!GPU_DISPLAY_ORDER.includes(feedCard.model)) continue;
      if (!isTrustworthyObservation(feedCard, packet)) continue;

      const key = `${packet.locale}:${feedCard.model}`;
      const previous = knownAvailability.get(key);
      knownAvailability.set(key, feedCard.available);

      if (feedCard.available !== true || previous === true) continue;
      if (!config.monitoredCards.includes(feedCard.model)) continue;

      const last = lastNotifiedAt.get(key);
      if (last !== undefined && now() - last < cooldownMs) {
        logger.info?.(`[nvidiaPoller] ${feedCard.model} available again within cooldown; not re-alerting.`);
        continue;
      }
      drops.push({ key, previous, model: feedCard.model });
    }

    if (drops.length === 0 || config.notifyOnStock === false || !notifier) return;

    const cards = mapFeedCards({ config, feedState: feed?.getState() ?? null });
    await Promise.all(drops.map(({ key, previous, model }) => {
      const card = cards.find((c) => c.cardKey === model);
      lastNotifiedAt.set(key, now());
      return sendAlert({ key, previous, card, config });
    }));
  }

  function syncFeed() {
    const config = readConfig();
    const wanted = started && config.enabled;

    if (feed && (!wanted || feedLocale !== config.locale)) {
      const old = feed;
      feed = null;
      feedToken = null;
      feedLocale = null;
      old.stop();
    }

    if (wanted && !feed) {
      const token = {};
      feedToken = token;
      feedLocale = config.locale;
      feed = createFeed({
        locale: config.locale,
        models: FEED_MODELS,
        logger,
        setTimeoutFn,
        clearTimeoutFn,
        now,
        ...feedOptions,
        onPacket: (packet) => (feedToken === token ? handlePacket(packet) : undefined),
        onStateChange: () => {
          if (feedToken === token) updateHealth();
        }
      });
      feed.start();
    }

    updateHealth(config);
  }

  function start() {
    if (started) return;
    started = true;
    syncFeed();
  }

  function stop() {
    started = false;
    syncFeed();
  }

  /** Apply config changes: reconnects only when enabled/locale changed. */
  function restart() {
    if (!started) start();
    else syncFeed();
  }

  /** The feed pushes updates; this only forces an immediate reconnect when disconnected. */
  async function triggerNow() {
    if (feed && !feed.getState().connected) {
      feed.stop();
      feed.start();
    }
    return getStatus();
  }

  function getStatus() {
    const config = readConfig();
    const feedState = feed?.getState() ?? null;
    updateHealth(config);
    const packet = feedState?.packet ?? null;
    return {
      running: Boolean(started && config.enabled && feed),
      source: 'notify-fe-live-feed',
      lastSuccessAt: status.lastSuccessAt,
      lastErrorAt: status.lastErrorAt,
      lastError: status.lastError,
      nextPollAt: null,
      pollCount: packetCount,
      cards: mapFeedCards({ config, feedState }),
      feed: {
        connected: feedState?.connected ?? false,
        status: feedState?.status ?? (config.enabled ? 'not_started' : 'disabled'),
        monitorHealthPercent: feedState?.monitorHealthPercent ?? null,
        lastPacketAt: feedState?.lastPacketAt ?? null,
        lastError: feedState?.lastError ?? null,
        reconnectAttempts: feedState?.reconnectAttempts ?? 0,
        nextReconnectAt: feedState?.nextReconnectAt ?? null,
        locale: feedState?.locale ?? config.locale,
        packetType: packet?.type ?? null,
        packetStatus: packet?.status ?? null,
        sequence: packet?.sequence ?? null,
        serverTime: packet?.serverTime ? new Date(packet.serverTime).toISOString() : null,
        staleAfterMs: packet?.staleAfterMs ?? null
      },
      enabled: config.enabled,
      intervalSeconds: config.intervalSeconds,
      locale: config.locale,
      monitoredCards: config.monitoredCards,
      discordWebhookUrl: config.discordWebhookUrl ? '***configured***' : ''
    };
  }

  return { start, stop, restart, triggerNow, getStatus };
}
