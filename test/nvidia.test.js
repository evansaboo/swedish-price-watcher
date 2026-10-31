import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNvidiaLiveFeed,
  validatePacket,
  buildFeedUrl,
  safeProductUrl,
  MAX_MESSAGE_BYTES,
  PING_INTERVAL_MS,
  WATCHDOG_GRACE_MS,
  NVIDIA_LIVE_FEED_ORIGIN
} from '../src/sources/nvidiaLiveFeed.js';
import {
  createNvidiaPoller,
  isFreshObservation,
  NOTIFY_COOLDOWN_MS
} from '../src/services/nvidiaPoller.js';
import { normalizeNvidiaConfig, ensureNvidiaConfig } from '../src/services/nvidiaConfig.js';
import {
  GPU_DISPLAY_ORDER,
  CARD_METADATA,
  collectFromNvidia,
  mapNvidiaCard,
  setNvidiaLiveStatusProvider
} from '../src/sources/nvidia.js';

// ── Test doubles ──────────────────────────────────────────────────

function createClock(start = 1_793_475_000_000) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimeoutFn(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: current + ms });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    advance(ms) {
      const target = current + ms;
      for (;;) {
        let dueId = null;
        let due = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!due || t.at < due.at)) {
            dueId = id;
            due = t;
          }
        }
        if (!due) break;
        timers.delete(dueId);
        current = due.at;
        due.fn();
      }
      current = target;
    }
  };
}

function createFakeWebSocketClass() {
  const instances = [];
  class FakeWebSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.readyState = 0;
      this.sent = [];
      this.closedByClient = null;
      this.listeners = { open: [], message: [], error: [], close: [] };
      instances.push(this);
    }
    addEventListener(type, fn) {
      this.listeners[type].push(fn);
    }
    dispatch(type, event = {}) {
      for (const fn of this.listeners[type]) fn(event);
    }
    send(data) {
      this.sent.push(data);
    }
    close(code) {
      this.closedByClient = code ?? 1000;
      this.readyState = 3;
      // Real sockets emit close later; the feed must ignore it after teardown.
      this.dispatch('close', { code: code ?? 1000, reason: '' });
    }
    // helpers driven by the test
    serverOpen() {
      this.readyState = 1;
      this.dispatch('open');
    }
    serverSend(data) {
      this.dispatch('message', { data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
    serverClose(code = 1006, reason = '') {
      this.readyState = 3;
      this.dispatch('close', { code, reason });
    }
  }
  return { FakeWebSocket, instances };
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeLogger() {
  const entries = [];
  const log = (level) => (...args) => entries.push({ level, msg: args.join(' ') });
  return { entries, info: log('info'), warn: log('warn'), error: log('error') };
}

function makeCard(model, overrides = {}, serverTime) {
  return {
    model,
    sku: `SKU${model}`,
    available: false,
    productUrl: null,
    observedAt: serverTime - 1000,
    lastAvailableAt: null,
    status: 'healthy',
    ...overrides
  };
}

function makePacket({ serverTime, type = 'health', sequence = 1, status = 'healthy', cards = {}, ...rest } = {}) {
  return {
    version: 1,
    type,
    sequence,
    synthetic: false,
    serverTime,
    locale: 'sv-se',
    models: ['5090', '5080', '5070'],
    status,
    monitorHealthPercent: 100,
    staleAfterMs: 60_000,
    offlineAfterMs: 75_000,
    cards: ['5070', '5080', '5090'].map((m) => makeCard(m, cards[m], serverTime)),
    alerts: [],
    metrics: { requests: 1 },
    clients: { total: 3 },
    ...rest
  };
}

// ── Packet validation ─────────────────────────────────────────────

describe('nvidiaLiveFeed - validatePacket', () => {
  const serverTime = 1_793_475_000_000;

  it('accepts a real-shaped packet and trims extra fields', () => {
    const result = validatePacket(makePacket({ serverTime }), { locale: 'sv-se' });
    assert.equal(result.ok, true);
    assert.equal(result.packet.cards.length, 3);
    assert.equal(result.packet.metrics, undefined);
    assert.equal(result.packet.staleAfterMs, 60_000);
  });

  it('rejects wrong version, type, locale and status', () => {
    assert.equal(validatePacket({ ...makePacket({ serverTime }), version: 2 }, { locale: 'sv-se' }).reason, 'unsupported_version');
    assert.equal(validatePacket({ ...makePacket({ serverTime }), type: 'bogus' }, { locale: 'sv-se' }).reason, 'unknown_type');
    assert.equal(validatePacket(makePacket({ serverTime }), { locale: 'de-de' }).reason, 'locale_mismatch');
    assert.equal(validatePacket({ ...makePacket({ serverTime }), status: 'meh' }, { locale: 'sv-se' }).reason, 'unknown_status');
    assert.equal(validatePacket(null).ok, false);
    assert.equal(validatePacket([]).ok, false);
  });

  it('rejects malformed cards', () => {
    const base = makePacket({ serverTime });
    const withCard = (patch) => ({ ...base, cards: [{ ...base.cards[0], ...patch }] });
    assert.equal(validatePacket({ ...base, cards: 'nope' }).reason, 'bad_cards');
    assert.equal(validatePacket(withCard({ available: 'yes' })).reason, 'bad_card');
    assert.equal(validatePacket(withCard({ status: 'exploded' })).reason, 'bad_card');
    assert.equal(validatePacket(withCard({ observedAt: 'now' })).reason, 'bad_card');
    assert.equal(validatePacket(withCard({ sku: 42 })).reason, 'bad_card');
    assert.equal(validatePacket({ ...base, cards: [base.cards[0], base.cards[0]] }).reason, 'duplicate_card');
  });

  it('accepts available:null and drops unsafe product URLs', () => {
    const base = makePacket({ serverTime });
    const result = validatePacket({
      ...base,
      cards: [
        { ...base.cards[0], available: null },
        { ...base.cards[1], productUrl: 'javascript:alert(1)' },
        { ...base.cards[2], productUrl: 'https://store.example/basket?sig=abc' }
      ]
    });
    assert.equal(result.ok, true);
    assert.equal(result.packet.cards[0].available, null);
    assert.equal(result.packet.cards[1].productUrl, null);
    assert.equal(result.packet.cards[2].productUrl, 'https://store.example/basket?sig=abc');
    assert.equal(safeProductUrl('https://user:pw@x.example/'), null);
  });

  it('builds the subscription URL without a client label', () => {
    const url = new URL(buildFeedUrl('wss://live.example/v1/ws', 'sv-se', ['5090', '5080', '5070']));
    assert.equal(url.searchParams.get('locale'), 'sv-se');
    assert.equal(url.searchParams.get('models'), '5090,5080,5070');
    assert.equal(url.searchParams.get('monitorHealth'), '1');
    assert.equal(url.searchParams.get('client'), null);
  });
});

// ── Feed transport ────────────────────────────────────────────────

describe('nvidiaLiveFeed - transport', () => {
  let clock;
  let ws;
  let packets;
  let feed;

  beforeEach(() => {
    clock = createClock();
    ws = createFakeWebSocketClass();
    packets = [];
    feed = createNvidiaLiveFeed({
      locale: 'sv-se',
      url: 'wss://live.example/v1/ws',
      WebSocketImpl: ws.FakeWebSocket,
      logger: silentLogger,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      onPacket: (p) => packets.push(p)
    });
  });

  afterEach(() => feed.stop());

  it('connects with origin and user-agent headers and reports state', () => {
    feed.start();
    assert.equal(ws.instances.length, 1);
    const sock = ws.instances[0];
    assert.equal(sock.options.headers.origin, NVIDIA_LIVE_FEED_ORIGIN);
    assert.match(sock.options.headers['user-agent'], /swedish-price-watcher/);
    assert.equal(feed.getState().status, 'connecting');

    sock.serverOpen();
    assert.equal(feed.getState().status, 'waiting');
    sock.serverSend(makePacket({ serverTime: clock.now(), type: 'snapshot' }));

    const state = feed.getState();
    assert.equal(state.connected, true);
    assert.equal(state.status, 'healthy');
    assert.equal(state.monitorHealthPercent, 100);
    assert.equal(state.lastError, null);
    assert.ok(state.lastPacketAt);
    assert.equal(state.packet.cards.length, 3);
    assert.equal(packets.length, 1);
  });

  it('pings every 25 s and ignores pong', () => {
    feed.start();
    const sock = ws.instances[0];
    sock.serverOpen();
    sock.serverSend(makePacket({ serverTime: clock.now() }));
    clock.advance(PING_INTERVAL_MS);
    assert.deepEqual(sock.sent, ['ping']);
    sock.serverSend('pong');
    sock.serverSend(makePacket({ serverTime: clock.now(), sequence: 2 }));
    clock.advance(PING_INTERVAL_MS);
    assert.deepEqual(sock.sent, ['ping', 'ping']);
    assert.equal(packets.length, 2);
  });

  it('ignores invalid JSON, oversize, synthetic, binary and out-of-order messages without crashing', () => {
    feed.start();
    const sock = ws.instances[0];
    sock.serverOpen();
    sock.serverSend('{not json');
    sock.serverSend('x'.repeat(MAX_MESSAGE_BYTES + 1));
    sock.serverSend({ ...makePacket({ serverTime: clock.now() }), synthetic: true });
    sock.dispatch('message', { data: { weird: true } });
    sock.serverSend({ version: 1, type: 'snapshot' });
    assert.equal(packets.length, 0);
    assert.equal(feed.getState().status, 'waiting');

    sock.serverSend(makePacket({ serverTime: clock.now(), sequence: 10 }));
    sock.serverSend(makePacket({ serverTime: clock.now(), sequence: 9 }));
    assert.equal(packets.length, 1);
    assert.equal(feed.getState().packet.sequence, 10);
  });

  it('survives an onPacket handler that throws or rejects', () => {
    const throwing = createNvidiaLiveFeed({
      WebSocketImpl: ws.FakeWebSocket,
      logger: silentLogger,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      onPacket: () => { throw new Error('boom'); },
      onStateChange: () => { throw new Error('boom'); }
    });
    throwing.start();
    const sock = ws.instances.at(-1);
    sock.serverOpen();
    assert.doesNotThrow(() => sock.serverSend(makePacket({ serverTime: clock.now() })));
    assert.equal(throwing.getState().status, 'healthy');
    throwing.stop();
  });

  it('reconnects with exponential backoff capped at 60 s, resetting after a valid packet', () => {
    feed.start();
    const delays = [];
    for (let i = 0; i < 7; i += 1) {
      const sock = ws.instances.at(-1);
      sock.serverClose(1006);
      assert.equal(feed.getState().status, 'disconnected');
      assert.equal(feed.getState().connected, false);
      assert.match(feed.getState().lastError, /closed \(1006\)/);
      const before = ws.instances.length;
      const nextAt = Date.parse(feed.getState().nextReconnectAt);
      delays.push(nextAt - clock.now());
      clock.advance(delays.at(-1) - 1);
      assert.equal(ws.instances.length, before, 'must not reconnect early');
      clock.advance(1);
      assert.equal(ws.instances.length, before + 1);
    }
    assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000]);

    const sock = ws.instances.at(-1);
    sock.serverOpen();
    sock.serverSend(makePacket({ serverTime: clock.now() }));
    sock.serverClose(1006);
    assert.equal(Date.parse(feed.getState().nextReconnectAt) - clock.now(), 2000);
  });

  it('reconnects when the WebSocket constructor throws', () => {
    let fail = true;
    class Flaky extends ws.FakeWebSocket {
      constructor(...args) {
        if (fail) throw new Error('bad url');
        super(...args);
      }
    }
    const flaky = createNvidiaLiveFeed({
      WebSocketImpl: Flaky,
      logger: silentLogger,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now
    });
    assert.doesNotThrow(() => flaky.start());
    assert.equal(flaky.getState().status, 'disconnected');
    assert.match(flaky.getState().lastError, /bad url/);
    fail = false;
    clock.advance(2000);
    assert.equal(flaky.getState().status, 'connecting');
    flaky.stop();
  });

  it('watchdog marks the feed stale and reconnects after staleAfterMs + 15 s of silence', () => {
    feed.start();
    const sock = ws.instances[0];
    sock.serverOpen();
    sock.serverSend(makePacket({ serverTime: clock.now(), staleAfterMs: 30_000 }));

    clock.advance(30_000 + WATCHDOG_GRACE_MS - 1);
    assert.equal(feed.getState().status, 'healthy');
    // pings alone do not keep the watchdog happy; only valid packets do
    assert.ok(sock.sent.includes('ping'));
    clock.advance(1);
    assert.equal(feed.getState().status, 'stale');
    assert.equal(feed.getState().connected, false);
    assert.match(feed.getState().lastError, /No valid packet for 45s/);
    assert.equal(sock.closedByClient, 1000);

    clock.advance(2000);
    assert.equal(ws.instances.length, 2);
  });

  it('watchdog also covers a handshake that never completes', () => {
    feed.start();
    clock.advance(60_000 + WATCHDOG_GRACE_MS);
    assert.equal(feed.getState().status, 'stale');
    clock.advance(2000);
    assert.equal(ws.instances.length, 2);
  });

  it('stop() closes the socket and clears every timer', () => {
    feed.start();
    const sock = ws.instances[0];
    sock.serverOpen();
    sock.serverSend(makePacket({ serverTime: clock.now() }));
    feed.stop();
    assert.equal(feed.getState().status, 'stopped');
    assert.equal(sock.closedByClient, 1000);
    assert.equal(clock.pending(), 0);
    clock.advance(10 * 60_000);
    assert.equal(ws.instances.length, 1);
  });
});

// ── Config ────────────────────────────────────────────────────────

describe('nvidiaConfig - normalizeNvidiaConfig', () => {
  it('applies defaults on empty input', () => {
    const cfg = normalizeNvidiaConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.locale, 'sv-se');
    assert.deepEqual(cfg.monitoredCards, ['5090', '5080', '5070']);
    assert.equal(cfg.discordWebhookUrl, '');
    assert.equal(cfg.soundEnabled, true);
    assert.equal(cfg.autoOpenShop, false);
  });

  it('filters discontinued 40-series cards out of the stored config', () => {
    const cfg = normalizeNvidiaConfig({ monitoredCards: ['5090', '5080', '5070', '4070S', '4090', '4080S'] });
    assert.deepEqual(cfg.monitoredCards, ['5090', '5080', '5070']);
    const onlyOld = normalizeNvidiaConfig({ monitoredCards: ['4090'] });
    assert.deepEqual(onlyOld.monitoredCards, ['5090', '5080', '5070']);
    const prefs = { nvidiaFe: { enabled: true, monitoredCards: ['5080', '4090', '5080'] } };
    ensureNvidiaConfig(prefs);
    assert.deepEqual(prefs.nvidiaFe.monitoredCards, ['5080']);
  });

  it('normalises locale to a feed locale and keeps the legacy interval field', () => {
    const cfg = normalizeNvidiaConfig({ locale: 'DE-DE ', intervalSeconds: 60, discordWebhookUrl: ' https://x/y ' });
    assert.equal(cfg.locale, 'de-de');
    assert.equal(cfg.intervalSeconds, 60);
    assert.equal(cfg.discordWebhookUrl, 'https://x/y');
    assert.equal(normalizeNvidiaConfig({ locale: 'xx-yy' }).locale, 'sv-se');
  });

  it('only lists the cards the feed tracks', () => {
    assert.deepEqual(GPU_DISPLAY_ORDER, ['5090', '5080', '5070']);
    assert.deepEqual(Object.keys(CARD_METADATA).sort(), ['5070', '5080', '5090']);
  });
});

// ── Poller: mapping and notification rule ─────────────────────────

function setupPoller(configOverrides = {}, { notifyImpl } = {}) {
  const clock = createClock();
  const ws = createFakeWebSocketClass();
  const logger = makeLogger();
  const sent = [];
  let config = {
    enabled: true,
    locale: 'sv-se',
    monitoredCards: ['5090', '5080', '5070'],
    discordWebhookUrl: 'https://discord.example/webhook',
    ...configOverrides
  };
  const notifier = {
    async notifyNvidiaStockDrop(args) {
      if (notifyImpl) await notifyImpl(args);
      sent.push(args);
    }
  };
  let lastOnPacket = null;
  const poller = createNvidiaPoller({
    getConfig: () => config,
    notifier,
    logger,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    now: clock.now,
    feedOptions: { WebSocketImpl: ws.FakeWebSocket, url: 'wss://live.example/v1/ws' },
    createFeed: (opts) => {
      // Capture the poller's handler so tests can await its notification promise.
      const inner = opts.onPacket;
      const feedRef = createNvidiaLiveFeed({
        ...opts,
        onPacket: (p) => {
          lastOnPacket = inner(p);
          return lastOnPacket;
        }
      });
      return feedRef;
    }
  });

  const socket = () => ws.instances.at(-1);
  let seq = 0;
  async function push(packetOverrides = {}) {
    seq += 1;
    socket().serverSend(makePacket({ serverTime: clock.now(), sequence: seq, ...packetOverrides }));
    await lastOnPacket;
  }

  return {
    clock, ws, logger, sent, poller, socket, push,
    setConfig: (patch) => { config = { ...config, ...patch }; }
  };
}

const IN_STOCK = { available: true, productUrl: 'https://store.example/buy-5090' };

describe('nvidiaPoller - card mapping and status', () => {
  it('maps feed cards into the dashboard card shape', async () => {
    const t = setupPoller();
    t.poller.start();
    t.socket().serverOpen();
    await t.push({ cards: { '5090': IN_STOCK, '5080': { status: 'blocked' } } });

    const status = t.poller.getStatus();
    assert.equal(status.running, true);
    assert.equal(status.lastError, 'Card status: 5080 blocked');
    assert.equal(status.feed.connected, true);
    assert.equal(status.feed.status, 'healthy');
    assert.equal(status.feed.monitorHealthPercent, 100);
    assert.deepEqual(status.cards.map((c) => c.cardKey), ['5090', '5080', '5070']);

    const c5090 = status.cards[0];
    assert.equal(c5090.sku, 'SKU5090');
    assert.equal(c5090.available, true);
    assert.equal(c5090.api_reachable, true);
    assert.equal(c5090.api_error, null);
    assert.equal(c5090.product_url, 'https://store.example/buy-5090');
    assert.equal(c5090.last_checked, new Date(t.clock.now() - 1000).toISOString());
    assert.equal(c5090.isMonitored, true);
    assert.equal(c5090.msrpSek, 25990);
    assert.equal(c5090.locale, 'sv-se');
    assert.match(c5090.store_url, /marketplace\.nvidia\.com\/sv-se\//);
    for (const key of ['cardKey', 'name', 'fullName', 'sku', 'available', 'api_reachable', 'api_error', 'isMonitored',
      'product_url', 'store_url', 'priceSek', 'msrpSek', 'imageUrl', 'locale', 'last_checked']) {
      assert.ok(key in c5090, `missing ${key}`);
    }

    const c5080 = status.cards[1];
    assert.equal(c5080.api_reachable, false);
    assert.equal(c5080.api_error, 'blocked');
    t.poller.stop();
  });

  it('reports feed_offline, feed_disconnected and degraded states in lastError', async () => {
    const t = setupPoller();
    t.poller.start();
    assert.equal(t.poller.getStatus().cards[0].api_error, 'feed_connecting');
    assert.equal(t.poller.getStatus().lastError, null);

    t.socket().serverOpen();
    await t.push({ status: 'offline' });
    let status = t.poller.getStatus();
    assert.equal(status.cards[0].api_error, 'feed_offline');
    assert.equal(status.cards[0].api_reachable, false);
    assert.match(status.lastError, /offline/);

    await t.push({ status: 'source_degraded', monitorHealthPercent: 67 });
    assert.match(t.poller.getStatus().lastError, /degraded \(67% monitor health\)/);

    await t.push();
    assert.equal(t.poller.getStatus().lastError, null);

    t.socket().serverClose(1006);
    status = t.poller.getStatus();
    assert.equal(status.cards[0].api_error, 'feed_disconnected');
    assert.equal(status.cards[0].available, false);
    assert.match(status.lastError, /Live feed disconnected/);
    assert.ok(status.lastErrorAt);
    t.poller.stop();
  });

  it('logs an alarm when the feed goes unhealthy and apiAlarmEnabled is on', async () => {
    const t = setupPoller({ apiAlarmEnabled: true });
    t.poller.start();
    t.socket().serverOpen();
    await t.push();
    t.socket().serverClose(1006);
    assert.ok(t.logger.entries.some((e) => e.level === 'warn' && /ALARM/.test(e.msg)));

    const quiet = setupPoller({ apiAlarmEnabled: false });
    quiet.poller.start();
    quiet.socket().serverOpen();
    await quiet.push();
    quiet.socket().serverClose(1006);
    assert.ok(!quiet.logger.entries.some((e) => /ALARM/.test(e.msg)));
    t.poller.stop();
    quiet.poller.stop();
    assert.ok(!t.logger.entries.some((e) => /healthy again/.test(e.msg)), 'stopping is not a recovery');
    assert.equal(t.poller.getStatus().lastError, null);
  });

  it('does not connect when disabled, and reconnects only on enabled/locale changes', async () => {
    const t = setupPoller({ enabled: false });
    t.poller.start();
    assert.equal(t.ws.instances.length, 0);
    assert.equal(t.poller.getStatus().running, false);
    assert.equal(t.poller.getStatus().cards[0].api_error, 'tracker_disabled');

    t.setConfig({ enabled: true });
    t.poller.restart();
    assert.equal(t.ws.instances.length, 1);

    t.setConfig({ monitoredCards: ['5090'] });
    t.poller.restart();
    assert.equal(t.ws.instances.length, 1, 'card selection change must not reconnect');
    assert.equal(t.poller.getStatus().cards[1].isMonitored, false);

    t.setConfig({ locale: 'de-de' });
    t.poller.restart();
    assert.equal(t.ws.instances.length, 2);
    assert.equal(t.ws.instances[0].closedByClient, 1000);
    assert.match(t.ws.instances[1].url, /locale=de-de/);

    t.setConfig({ enabled: false });
    t.poller.restart();
    assert.equal(t.ws.instances[1].closedByClient, 1000);
    assert.equal(t.poller.getStatus().running, false);
    t.poller.stop();
  });

  it('triggerNow reconnects immediately only when disconnected', async () => {
    const t = setupPoller();
    t.poller.start();
    t.socket().serverOpen();
    await t.push();
    await t.poller.triggerNow();
    assert.equal(t.ws.instances.length, 1);
    t.socket().serverClose(1006);
    await t.poller.triggerNow();
    assert.equal(t.ws.instances.length, 2);
    t.poller.stop();
  });

  it('isFreshObservation uses the server clock', () => {
    const packet = { serverTime: 100_000, staleAfterMs: 60_000 };
    assert.equal(isFreshObservation({ observedAt: 99_000 }, packet), true);
    assert.equal(isFreshObservation({ observedAt: 40_000 }, packet), false);
    assert.equal(isFreshObservation({ observedAt: 101_000 }, packet), false);
    assert.equal(isFreshObservation({ observedAt: null }, packet), false);
  });
});

describe('nvidiaPoller - notification rule', () => {
  let t;
  beforeEach(() => {
    t = setupPoller();
    t.poller.start();
    t.socket().serverOpen();
  });
  afterEach(() => t.poller.stop());

  it('alerts on an unavailable -> available transition', async () => {
    await t.push({ type: 'snapshot' });
    assert.equal(t.sent.length, 0);
    await t.push({ type: 'update', cards: { '5090': IN_STOCK } });
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0].card.cardKey, '5090');
    assert.equal(t.sent[0].card.product_url, 'https://store.example/buy-5090');
    assert.equal(t.sent[0].webhookUrl, 'https://discord.example/webhook');
  });

  it('alerts when the first known state is already available (restart during a drop)', async () => {
    await t.push({ type: 'snapshot', cards: { '5080': { available: true } } });
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0].card.cardKey, '5080');
  });

  it('does not re-alert while the card stays available', async () => {
    await t.push({ cards: { '5090': IN_STOCK } });
    await t.push({ cards: { '5090': IN_STOCK } });
    t.clock.advance(NOTIFY_COOLDOWN_MS + 1);
    await t.push({ cards: { '5090': IN_STOCK } });
    assert.equal(t.sent.length, 1);
  });

  it('applies a 10-minute cooldown to flapping', async () => {
    await t.push({ cards: { '5090': IN_STOCK } });
    await t.push();
    await t.push({ cards: { '5090': IN_STOCK } });
    assert.equal(t.sent.length, 1, 'flap within cooldown is suppressed');

    await t.push();
    t.clock.advance(NOTIFY_COOLDOWN_MS);
    t.socket().serverOpen(); // the watchdog may have recycled the socket meanwhile
    await t.push({ cards: { '5090': IN_STOCK } });
    assert.equal(t.sent.length, 2, 'new drop after cooldown alerts');
  });

  it('does not alert for unhealthy, stale, null, synthetic or offline observations', async () => {
    const now = t.clock.now();
    await t.push({ cards: { '5090': { ...IN_STOCK, status: 'blocked' } } });
    await t.push({ cards: { '5090': { ...IN_STOCK, status: 'stale' } } });
    await t.push({ cards: { '5090': { ...IN_STOCK, observedAt: now - 61_000 } } });
    await t.push({ cards: { '5090': { ...IN_STOCK, observedAt: now + 5_000 } } });
    await t.push({ cards: { '5090': { available: null } } });
    await t.push({ status: 'offline', cards: { '5090': IN_STOCK } });
    await t.push({ synthetic: true, cards: { '5090': IN_STOCK } });
    assert.equal(t.sent.length, 0);

    // Untrustworthy packets never recorded availability, so the first healthy one alerts.
    await t.push({ cards: { '5090': IN_STOCK } });
    assert.equal(t.sent.length, 1);
  });

  it('only alerts for monitored cards and respects notifyOnStock', async () => {
    t.setConfig({ monitoredCards: ['5070'] });
    await t.push({ cards: { '5090': IN_STOCK } });
    assert.equal(t.sent.length, 0);

    t.setConfig({ monitoredCards: ['5090', '5070'], notifyOnStock: false });
    await t.push({ cards: { '5070': { available: true } } });
    assert.equal(t.sent.length, 0);
  });

  it('retries on the next packet when the Discord send fails', async () => {
    const failing = setupPoller({}, {
      notifyImpl: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          if (calls === 1) throw new Error('discord down');
        };
      })()
    });
    failing.poller.start();
    failing.socket().serverOpen();
    await failing.push({ cards: { '5090': IN_STOCK } });
    assert.equal(failing.sent.length, 0);
    assert.ok(failing.logger.entries.some((e) => e.level === 'error' && /discord down/.test(e.msg)));
    await failing.push({ cards: { '5090': IN_STOCK } });
    assert.equal(failing.sent.length, 1);
    failing.poller.stop();
  });
});

// ── Scan source ───────────────────────────────────────────────────

describe('nvidia scan source - collectFromNvidia', () => {
  const source = { id: 'nvidia-fe', label: 'NVIDIA Founders Edition', type: 'nvidia', locale: 'sv-se' };
  const now = '2026-10-31T12:00:00.000Z';

  afterEach(() => setNvidiaLiveStatusProvider(null));

  it('maps live feed cards into observations without network calls', async () => {
    const t = setupPoller();
    t.poller.start();
    t.socket().serverOpen();
    await t.push({ cards: { '5080': { available: true, productUrl: 'https://store.example/5080' }, '5070': { status: 'timeout' } } });
    setNvidiaLiveStatusProvider(() => t.poller.getStatus());

    const sourceState = {};
    const obs = await collectFromNvidia({ source, sourceState, now });
    assert.deepEqual(obs.map((o) => o.externalId), ['nvidia-fe-5090-sv-se', 'nvidia-fe-5080-sv-se']);
    assert.equal(obs[0].availability, 'out_of_stock');
    assert.equal(obs[1].availability, 'in_stock');
    assert.equal(obs[1].url, 'https://store.example/5080');
    assert.equal(obs[1].priceSek, 13990);
    assert.equal(sourceState.lastScanPartial, true, '5070 was unhealthy, so the snapshot is partial');
    t.poller.stop();
  });

  it('throws when the tracker is disabled or the feed has no fresh data', async () => {
    await assert.rejects(collectFromNvidia({ source, now }), /not initialised/);

    setNvidiaLiveStatusProvider(() => ({ enabled: false, cards: [] }));
    await assert.rejects(collectFromNvidia({ source, now }), /disabled/);

    const t = setupPoller();
    t.poller.start();
    setNvidiaLiveStatusProvider(() => t.poller.getStatus());
    await assert.rejects(collectFromNvidia({ source, now }), /no fresh data/);
    t.poller.stop();
  });

  it('mapNvidiaCard falls back to the store URL when out of stock', () => {
    const obs = mapNvidiaCard({
      card: { cardKey: '5090', sku: 'PROFESHOP5090', available: false, product_url: null, locale: 'sv-se' },
      source,
      now
    });
    assert.equal(obs.title, 'NVIDIA GeForce RTX 5090 Founders Edition');
    assert.equal(obs.category, 'GPU');
    assert.equal(obs.condition, 'new');
    assert.equal(obs.availability, 'out_of_stock');
    assert.equal(obs.priceSek, 25990);
    assert.match(obs.url, /marketplace\.nvidia\.com\/sv-se\/consumer\/graphics-cards\/nvidia-geforce-rtx-5090\//);
    assert.ok(obs.notes.includes('PROFESHOP5090'));
  });
});
