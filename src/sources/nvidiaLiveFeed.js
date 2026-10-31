import { WebSocket as UndiciWebSocket } from 'undici';

/**
 * Client for Notify-FE's public realtime feed (https://github.com/jlplenio/notify-fe).
 *
 * NVIDIA's Akamai edge blocks direct inventory polling from this host, so we
 * subscribe to the feed Notify-FE's own website uses. The server pushes a
 * snapshot on connect, health packets about every 30 s, and update packets on
 * changes. This module only handles transport and validation; alert decisions
 * live in services/nvidiaPoller.js.
 */

export const NVIDIA_LIVE_FEED_URL = 'wss://live.jlplen.io/v1/ws';
// The gateway rejects upgrades without a browser-style Origin header.
export const NVIDIA_LIVE_FEED_ORIGIN = 'https://notify-fe.plen.io';
export const NVIDIA_LIVE_FEED_USER_AGENT = 'swedish-price-watcher (personal FE notifier)';

export const FEED_MODELS = ['5090', '5080', '5070'];
export const FEED_LOCALES = [
  'de-de', 'en-gb', 'de-at', 'da-dk', 'es-es', 'fr-fr', 'it-it',
  'nl-nl', 'nb-no', 'pl-pl', 'fi-fi', 'sv-se', 'en-us'
];

export const PACKET_TYPES = new Set(['snapshot', 'update', 'health']);
export const PACKET_STATUSES = new Set(['healthy', 'source_degraded', 'offline']);
export const CARD_STATUSES = new Set([
  'unknown', 'healthy', 'blocked', 'rate_limited', 'timeout', 'network_error', 'invalid_response', 'stale'
]);

export const MAX_MESSAGE_BYTES = 128 * 1024;
export const PING_INTERVAL_MS = 25_000;
export const BACKOFF_INITIAL_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;
export const DEFAULT_STALE_AFTER_MS = 60_000;
export const WATCHDOG_GRACE_MS = 15_000;

const WS_OPEN = 1;
const MAX_CARDS = 10;

const isCounter = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isTimestampOrNull = (v) => v === null || isCounter(v);
const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Return the URL unchanged when it is a credential-free https link, else null. */
export function safeProductUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return value;
  } catch {
    return null;
  }
}

export function buildFeedUrl(baseUrl = NVIDIA_LIVE_FEED_URL, locale = 'sv-se', models = FEED_MODELS) {
  const url = new URL(baseUrl);
  url.searchParams.set('locale', locale);
  url.searchParams.set('models', models.join(','));
  url.searchParams.set('monitorHealth', '1');
  url.searchParams.set('discoveries', '1');
  // Deliberately no `client=website`: we are not the website.
  return url.toString();
}

function validateCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.model !== 'string' || !raw.model || raw.model.length > 16) return null;
  if (typeof raw.sku !== 'string' || raw.sku.length > 128) return null;
  if (!(raw.available === null || typeof raw.available === 'boolean')) return null;
  if (!(raw.productUrl === null || raw.productUrl === undefined || typeof raw.productUrl === 'string')) return null;
  if (!isTimestampOrNull(raw.observedAt)) return null;
  if (!(raw.lastAvailableAt === undefined || isTimestampOrNull(raw.lastAvailableAt))) return null;
  if (!CARD_STATUSES.has(raw.status)) return null;
  return {
    model: raw.model,
    sku: raw.sku,
    available: raw.available,
    productUrl: safeProductUrl(raw.productUrl),
    observedAt: raw.observedAt,
    lastAvailableAt: raw.lastAvailableAt ?? null,
    status: raw.status
  };
}

/**
 * Defensive structural check of a decoded feed packet. Returns a trimmed copy
 * holding only the fields we use (metrics, clients and discoveries are dropped).
 */
export function validatePacket(raw, { locale } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('not_an_object');
  if (raw.version !== 1) return fail('unsupported_version');
  if (!PACKET_TYPES.has(raw.type)) return fail('unknown_type');
  if (typeof raw.locale !== 'string' || (locale && raw.locale !== locale)) return fail('locale_mismatch');
  if (!PACKET_STATUSES.has(raw.status)) return fail('unknown_status');
  if (!isCounter(raw.sequence)) return fail('bad_sequence');
  if (!isCounter(raw.serverTime)) return fail('bad_server_time');
  if (!(raw.synthetic === undefined || typeof raw.synthetic === 'boolean')) return fail('bad_synthetic');
  if (!(raw.staleAfterMs === undefined || isPositive(raw.staleAfterMs))) return fail('bad_stale_after');
  if (!(raw.offlineAfterMs === undefined || isPositive(raw.offlineAfterMs))) return fail('bad_offline_after');
  if (!(raw.lastPublisherAt === undefined || isTimestampOrNull(raw.lastPublisherAt))) return fail('bad_publisher_time');
  if (!(raw.monitorHealthPercent === undefined || raw.monitorHealthPercent === null
    || (isCounter(raw.monitorHealthPercent) && raw.monitorHealthPercent <= 100))) {
    return fail('bad_monitor_health');
  }
  if (!Array.isArray(raw.cards) || raw.cards.length > MAX_CARDS) return fail('bad_cards');

  const cards = [];
  const seenModels = new Set();
  for (const rawCard of raw.cards) {
    const card = validateCard(rawCard);
    if (!card) return fail('bad_card');
    if (seenModels.has(card.model)) return fail('duplicate_card');
    seenModels.add(card.model);
    cards.push(card);
  }

  const models = Array.isArray(raw.models) ? raw.models.filter((m) => typeof m === 'string') : [];
  const alerts = Array.isArray(raw.alerts) ? raw.alerts.filter((m) => typeof m === 'string') : [];

  return {
    ok: true,
    packet: {
      version: 1,
      type: raw.type,
      sequence: raw.sequence,
      synthetic: raw.synthetic === true,
      serverTime: raw.serverTime,
      locale: raw.locale,
      models,
      status: raw.status,
      monitorHealthPercent: raw.monitorHealthPercent ?? null,
      staleAfterMs: raw.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      offlineAfterMs: raw.offlineAfterMs ?? null,
      lastPublisherAt: raw.lastPublisherAt ?? null,
      cards,
      alerts
    }
  };
}

function messageText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return null; // Blob or unknown: the feed only sends text frames
}

function messageSize(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data && typeof data.size === 'number') return data.size;
  return 0;
}

export function createNvidiaLiveFeed({
  locale = 'sv-se',
  models = FEED_MODELS,
  url = NVIDIA_LIVE_FEED_URL,
  WebSocketImpl = UndiciWebSocket,
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => Date.now(),
  onPacket = null,
  onStateChange = null,
  headers = {}
} = {}) {
  const feedUrl = buildFeedUrl(url, locale, models);

  let started = false;
  let socket = null;
  let generation = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let watchdogTimer = null;
  let backoffMs = BACKOFF_INITIAL_MS;
  let lastSequence = -1;
  let lastInvalidReason = null;

  const state = {
    connected: false,
    status: 'stopped',
    monitorHealthPercent: null,
    lastPacketAt: null,
    lastError: null,
    packet: null,
    reconnectAttempts: 0,
    nextReconnectAt: null
  };

  function emitState() {
    if (!onStateChange) return;
    try {
      onStateChange(getState());
    } catch (err) {
      logger.warn?.(`[nvidiaLiveFeed] onStateChange handler failed: ${err.message}`);
    }
  }

  function setState(patch) {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (state[key] !== value) {
        state[key] = value;
        changed = true;
      }
    }
    if (changed) emitState();
  }

  function clearTimer(timer) {
    if (timer) clearTimeoutFn(timer);
    return null;
  }

  function unref(timer) {
    if (timer?.unref) timer.unref();
    return timer;
  }

  function armWatchdog(staleAfterMs) {
    watchdogTimer = clearTimer(watchdogTimer);
    const timeoutMs = (staleAfterMs ?? DEFAULT_STALE_AFTER_MS) + WATCHDOG_GRACE_MS;
    const gen = generation;
    watchdogTimer = unref(setTimeoutFn(() => {
      watchdogTimer = null;
      if (!started || gen !== generation) return;
      const seconds = Math.round(timeoutMs / 1000);
      logger.warn?.(`[nvidiaLiveFeed] No valid packet for ${seconds}s; reconnecting.`);
      teardownSocket();
      setState({ connected: false, status: 'stale', lastError: `No valid packet for ${seconds}s` });
      scheduleReconnect();
    }, timeoutMs));
  }

  function schedulePing() {
    pingTimer = clearTimer(pingTimer);
    const gen = generation;
    pingTimer = unref(setTimeoutFn(() => {
      pingTimer = null;
      if (!started || gen !== generation || !socket) return;
      try {
        if (socket.readyState === WS_OPEN) socket.send('ping');
      } catch (err) {
        logger.warn?.(`[nvidiaLiveFeed] ping failed: ${err.message}`);
      }
      schedulePing();
    }, PING_INTERVAL_MS));
  }

  function teardownSocket() {
    generation += 1; // late events from the old socket are ignored
    pingTimer = clearTimer(pingTimer);
    watchdogTimer = clearTimer(watchdogTimer);
    const old = socket;
    socket = null;
    if (old) {
      try {
        old.close(1000);
      } catch {
        // already closed
      }
    }
  }

  function scheduleReconnect() {
    if (!started) return;
    reconnectTimer = clearTimer(reconnectTimer);
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    state.reconnectAttempts += 1;
    setState({ nextReconnectAt: new Date(now() + delay).toISOString() });
    reconnectTimer = unref(setTimeoutFn(() => {
      reconnectTimer = null;
      connect();
    }, delay));
  }

  function handleDisconnect(gen, reason) {
    if (gen !== generation || !started) return;
    teardownSocket();
    logger.warn?.(`[nvidiaLiveFeed] Disconnected (${reason}); retrying in ${Math.round(backoffMs / 1000)}s.`);
    setState({ connected: false, status: 'disconnected', lastError: reason });
    scheduleReconnect();
  }

  function handleMessage(gen, data) {
    if (gen !== generation || !started) return;
    try {
      if (messageSize(data) > MAX_MESSAGE_BYTES) {
        noteInvalid('message_too_large');
        return;
      }
      const text = messageText(data);
      if (text === null) {
        noteInvalid('non_text_message');
        return;
      }
      if (text === 'pong') return;

      let decoded;
      try {
        decoded = JSON.parse(text);
      } catch {
        noteInvalid('invalid_json');
        return;
      }

      const result = validatePacket(decoded, { locale });
      if (!result.ok) {
        noteInvalid(result.reason);
        return;
      }
      const packet = result.packet;
      if (packet.synthetic) {
        noteInvalid('synthetic');
        return;
      }
      if (packet.sequence < lastSequence && packet.type !== 'snapshot') {
        noteInvalid('out_of_order');
        return;
      }

      lastSequence = packet.sequence;
      lastInvalidReason = null;
      backoffMs = BACKOFF_INITIAL_MS;
      state.reconnectAttempts = 0;
      armWatchdog(packet.staleAfterMs);
      setState({
        connected: true,
        status: packet.status,
        monitorHealthPercent: packet.monitorHealthPercent,
        lastPacketAt: new Date(now()).toISOString(),
        lastError: null,
        packet,
        nextReconnectAt: null
      });

      if (onPacket) {
        try {
          const maybePromise = onPacket(packet);
          if (maybePromise?.catch) {
            maybePromise.catch((err) => logger.error?.(`[nvidiaLiveFeed] onPacket handler failed: ${err.message}`));
          }
        } catch (err) {
          logger.error?.(`[nvidiaLiveFeed] onPacket handler failed: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error?.(`[nvidiaLiveFeed] Failed to handle message: ${err.message}`);
    }
  }

  function noteInvalid(reason) {
    // Log once per distinct reason so a misbehaving feed cannot flood the journal.
    if (reason !== lastInvalidReason) {
      lastInvalidReason = reason;
      logger.warn?.(`[nvidiaLiveFeed] Ignored message: ${reason}`);
    }
  }

  function connect() {
    if (!started) return;
    teardownSocket();
    const gen = generation;
    lastSequence = -1;
    setState({ connected: false, status: 'connecting', nextReconnectAt: null });

    let ws;
    try {
      ws = new WebSocketImpl(feedUrl, {
        headers: {
          origin: NVIDIA_LIVE_FEED_ORIGIN,
          'user-agent': NVIDIA_LIVE_FEED_USER_AGENT,
          ...headers
        }
      });
    } catch (err) {
      setState({ status: 'disconnected', lastError: `connect failed: ${err.message}` });
      logger.warn?.(`[nvidiaLiveFeed] Could not open socket: ${err.message}`);
      scheduleReconnect();
      return;
    }
    socket = ws;

    // Also covers a handshake that hangs: no packet within the window means reconnect.
    armWatchdog(DEFAULT_STALE_AFTER_MS);

    let socketError = null;
    ws.addEventListener('open', () => {
      if (gen !== generation || !started) return;
      logger.info?.(`[nvidiaLiveFeed] Connected to Notify-FE live feed (${locale}).`);
      setState({ connected: true, status: 'waiting' });
      schedulePing();
    });
    ws.addEventListener('message', (event) => handleMessage(gen, event?.data));
    ws.addEventListener('error', (event) => {
      socketError = event?.error?.message || event?.message || 'socket error';
    });
    ws.addEventListener('close', (event) => {
      const detail = event?.reason || socketError;
      handleDisconnect(gen, `closed (${event?.code ?? 'unknown'})${detail ? `: ${detail}` : ''}`);
    });
  }

  function getState() {
    return {
      connected: state.connected,
      status: state.status,
      monitorHealthPercent: state.monitorHealthPercent,
      lastPacketAt: state.lastPacketAt,
      lastError: state.lastError,
      packet: state.packet,
      reconnectAttempts: state.reconnectAttempts,
      nextReconnectAt: state.nextReconnectAt,
      locale,
      url: feedUrl
    };
  }

  return {
    start() {
      if (started) return;
      started = true;
      backoffMs = BACKOFF_INITIAL_MS;
      connect();
    },
    stop() {
      if (!started) return;
      started = false;
      reconnectTimer = clearTimer(reconnectTimer);
      teardownSocket();
      setState({ connected: false, status: 'stopped', nextReconnectAt: null });
    },
    getState
  };
}
