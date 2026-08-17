import test from 'node:test';
import assert from 'node:assert/strict';

import { createHotlistPoller } from '../src/services/hotlistPoller.js';

/**
 * A controllable clock so the poller's scheduling can be asserted without
 * waiting real seconds.
 */
function makeClock() {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map();
  const delays = [];

  return {
    now: () => nowMs,
    /** Every delay the poller has asked for, in order. */
    delays,
    setTimeoutFn(fn, delay) {
      const id = nextId++;
      delays.push(delay);
      timers.set(id, { fn, at: nowMs + delay });
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
    get pending() {
      return [...timers.values()].map((t) => t.at - nowMs);
    },
    /** Run every timer that is due at or before `nowMs + ms`. */
    async advance(ms) {
      const target = nowMs + ms;
      let guard = 0;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due || guard++ > 50) break;
        const [id, timer] = due;
        timers.delete(id);
        nowMs = timer.at;
        timer.fn();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
      nowMs = target;
    },
  };
}

const silentLogger = { error() {}, warn() {}, log() {} };

function makePoller(overrides = {}) {
  const clock = makeClock();
  const runs = [];
  const poller = createHotlistPoller({
    run: async (args) => { runs.push(args); return { count: 1, newCount: 0 }; },
    getConfig: () => ({ enabled: true, intervalSeconds: 100, jitterPct: 0 }),
    logger: silentLogger,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    now: clock.now,
    random: () => 0.5,
    ...overrides,
  });
  return { poller, clock, runs };
}

test('the poller keeps polling on its own interval', async () => {
  const { poller, clock, runs } = makePoller();
  poller.start();

  // Boots quickly, then settles into the configured cadence.
  await clock.advance(5000);
  assert.equal(runs.length, 1);

  await clock.advance(100_000);
  assert.equal(runs.length, 2);

  await clock.advance(100_000);
  assert.equal(runs.length, 3);

  poller.stop();
  await clock.advance(500_000);
  assert.equal(runs.length, 3, 'stop() ends the loop');
});

test('jitter spreads polls around the base interval instead of a fixed tick', () => {
  const samples = [];
  const { poller, clock } = makePoller({
    getConfig: () => ({ enabled: true, intervalSeconds: 100, jitterPct: 20 }),
    random: () => samples.length ? 1 : 0,
  });

  poller.start();
  samples.push(clock.pending[0]);
  poller.reschedule();
  samples.push(clock.pending[0]);

  // ±20% of 100s → the window is 80s..120s, and the two extremes differ.
  const [low, high] = samples;
  assert.ok(high >= 80_000 && high <= 120_000, `jittered delay ${high} within window`);
  assert.notEqual(low, high, 'delays are not a constant tick');
});

test('a failing poll backs off exponentially and recovers after a success', async () => {
  let shouldFail = true;
  const { poller, clock } = makePoller({
    run: async () => {
      if (shouldFail) throw new Error('algolia is down');
      return { count: 3, newCount: 1 };
    },
  });

  poller.start();
  await clock.advance(5000);
  assert.equal(poller.getStatus().consecutiveFailures, 1);
  // First failure doubles the 100s base rather than retrying immediately.
  assert.equal(clock.pending[0], 200_000);

  await clock.advance(200_000);
  assert.equal(poller.getStatus().consecutiveFailures, 2);
  assert.equal(clock.pending[0], 400_000);

  shouldFail = false;
  await clock.advance(400_000);
  const status = poller.getStatus();
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.lastError, null);
  assert.equal(status.lastCount, 3);
  // Back to the normal cadence once upstream recovers.
  assert.equal(clock.pending[0], 100_000);
});

test('backoff is capped so a long outage never stalls the poller indefinitely', async () => {
  const { poller, clock } = makePoller({
    run: async () => { throw new Error('down'); },
    maxBackoffMs: 300_000,
  });

  poller.start();
  await clock.advance(5000);
  for (let i = 0; i < 6; i += 1) await clock.advance(400_000);

  assert.ok(poller.getStatus().consecutiveFailures >= 5);
  assert.equal(Math.max(...clock.delays), 300_000, 'no delay ever exceeds maxBackoffMs');
  assert.equal(clock.delays.at(-1), 300_000, 'a sustained outage settles at the cap');
});

test('polling is skipped while a full scan holds the state lock', async () => {
  let scanning = true;
  const { poller, clock, runs } = makePoller({ isPaused: () => scanning });

  poller.start();
  await clock.advance(5000);
  assert.equal(runs.length, 0);
  assert.equal(poller.getStatus().skippedCount, 1);

  // The loop keeps its rhythm and picks straight back up afterwards.
  scanning = false;
  await clock.advance(100_000);
  assert.equal(runs.length, 1);
});

test('a disabled hotlist does not poll but stays scheduled for re-enabling', async () => {
  let enabled = false;
  const { poller, clock, runs } = makePoller({
    getConfig: () => ({ enabled, intervalSeconds: 100, jitterPct: 0 }),
  });

  poller.start();
  await clock.advance(5000);
  await clock.advance(100_000);
  assert.equal(runs.length, 0);

  enabled = true;
  await clock.advance(100_000);
  assert.equal(runs.length, 1);
});

test('pollNow runs immediately even when disabled or paused, and surfaces errors', async () => {
  const { poller, runs } = makePoller({
    getConfig: () => ({ enabled: false, intervalSeconds: 100, jitterPct: 0 }),
    isPaused: () => true,
  });

  const result = await poller.pollNow();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].manual, true);
  assert.deepEqual(result, { count: 1, newCount: 0 });

  const failing = makePoller({ run: async () => { throw new Error('nope'); } });
  await assert.rejects(() => failing.poller.pollNow(), /nope/);
});

test('overlapping polls are collapsed rather than run concurrently', async () => {
  let active = 0;
  let maxActive = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const { poller } = makePoller({
    run: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return { count: 0, newCount: 0 };
    },
  });

  const first = poller.pollNow();
  const second = poller.pollNow();
  release();
  await Promise.all([first, second]);

  assert.equal(maxActive, 1, 'a second poll never overlaps the first');
});

test('status reports the schedule so the dashboard can show a countdown', async () => {
  const { poller, clock } = makePoller();
  poller.start();
  await clock.advance(5000);

  const status = poller.getStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.started, true);
  assert.equal(status.pollCount, 1);
  assert.equal(status.lastCount, 1);
  assert.ok(status.lastSuccessAt, 'records when the last poll succeeded');
  assert.ok(status.nextPollAt, 'records when the next poll is due');
  assert.equal(status.running, false);
});
