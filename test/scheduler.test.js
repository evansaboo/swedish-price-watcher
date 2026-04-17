import test from 'node:test';
import assert from 'node:assert/strict';

import { createSchedulerController, isWithinActiveWindow, startScheduler } from '../src/scheduler.js';

test('scheduler triggers run repeatedly and stops cleanly', async () => {
  let calls = 0;
  const stop = startScheduler(async () => {
    calls += 1;
  }, 0.0005);

  await new Promise((resolve) => setTimeout(resolve, 120));
  stop();
  const callsAtStop = calls;
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.ok(callsAtStop >= 2);
  assert.equal(calls, callsAtStop);
});

test('scheduler catches run errors and logs them', async () => {
  const originalConsoleError = console.error;
  const messages = [];
  let calls = 0;

  console.error = (...args) => {
    messages.push(args.map((entry) => String(entry)).join(' '));
  };

  try {
    const stop = startScheduler(async () => {
      calls += 1;
      throw new Error('scheduler-boom');
    }, 0.0005);

    await new Promise((resolve) => setTimeout(resolve, 80));
    stop();
  } finally {
    console.error = originalConsoleError;
  }

  assert.ok(calls >= 1);
  assert.ok(messages.some((message) => message.includes('[scheduler] scheduler-boom')));
});

test('scheduler controller updates interval and enabled state', async () => {
  let calls = 0;
  const scheduler = createSchedulerController({
    run: async () => {
      calls += 1;
    },
    intervalMinutes: 0.0005,
    enabled: true
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  scheduler.update({ enabled: false });
  const callsAtPause = calls;

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, callsAtPause);
  assert.equal(scheduler.getState().enabled, false);

  scheduler.update({ enabled: true, intervalMinutes: 0.001 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  scheduler.stop();

  assert.ok(calls > callsAtPause);
  assert.equal(scheduler.getState().nextRunAt, null);
});

test('active window check uses Stockholm local time', () => {
  const window = {
    enabled: true,
    startTime: '07:00',
    endTime: '00:00',
    timeZone: 'Europe/Stockholm'
  };

  assert.equal(isWithinActiveWindow(window, new Date('2026-06-01T06:00:00.000Z')), true);
  assert.equal(isWithinActiveWindow(window, new Date('2026-06-01T22:30:00.000Z')), false);
});

test('scheduler skips runs outside active window', async () => {
  let now = new Date('2026-06-01T22:30:00.000Z');
  let calls = 0;
  const scheduler = createSchedulerController({
    run: async () => {
      calls += 1;
    },
    intervalMinutes: 0.0005,
    enabled: true,
    activeWindow: {
      enabled: true,
      startTime: '07:00',
      endTime: '00:00',
      timeZone: 'Europe/Stockholm'
    },
    nowProvider: () => now
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, 0);

  now = new Date('2026-06-01T08:30:00.000Z');
  await new Promise((resolve) => setTimeout(resolve, 80));
  scheduler.stop();

  assert.ok(calls >= 1);
});
