/**
 * A standalone polling loop for the Elgiganten hotlist.
 *
 * The hotlist is deliberately *not* part of the shared scan scheduler. A full
 * scan walks every source and takes minutes; the hotlist is a single Algolia
 * round-trip and its whole value is catching a mispriced GPU before someone
 * else does. Tying it to the slow cycle wasted almost all of that advantage.
 *
 * Politeness is preserved by construction:
 *  - one HTTP request per poll, against the plain Algolia CDN,
 *  - a configurable floor on the interval,
 *  - randomised jitter so requests never land on a predictable tick,
 *  - exponential backoff on failure, so an upstream problem quiets the poller
 *    down instead of hammering it.
 */

const DEFAULT_MAX_BACKOFF_MS = 15 * 60 * 1000;

export function createHotlistPoller({
  run,
  getConfig,
  isPaused = () => false,
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  random = Math.random,
  now = () => Date.now(),
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
}) {
  let timer = null;
  let started = false;
  let inFlightPromise = null;
  let consecutiveFailures = 0;

  const status = {
    running: false,
    lastPollStartedAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    lastCount: null,
    lastNewCount: null,
    lastDurationMs: null,
    nextPollAt: null,
    pollCount: 0,
    failureCount: 0,
    skippedCount: 0,
  };

  /**
   * Base interval with ±jitterPct applied, or an exponentially backed-off delay
   * after repeated failures.
   */
  function nextDelayMs() {
    const config = getConfig();
    const baseMs = Math.max(1, Number(config.intervalSeconds) || 90) * 1000;

    if (consecutiveFailures > 0) {
      const backoff = baseMs * 2 ** Math.min(consecutiveFailures, 8);
      return Math.min(backoff, maxBackoffMs);
    }

    const jitterPct = Math.min(Math.max(Number(config.jitterPct) || 0, 0), 50);
    if (!jitterPct) return baseMs;
    const spread = baseMs * (jitterPct / 100);
    return Math.round(baseMs - spread + random() * spread * 2);
  }

  function clearTimer() {
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function schedule(delayMs) {
    clearTimer();
    if (!started) return;
    status.nextPollAt = new Date(now() + delayMs).toISOString();
    timer = setTimeoutFn(() => {
      timer = null;
      tick().catch((error) => logger.error?.('[hotlist]', error.message));
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function tick({ manual = false } = {}) {
    if (inFlightPromise) {
      if (manual) return inFlightPromise;
      return null;
    }

    const config = getConfig();
    if (!manual && (!started || config.enabled === false)) {
      schedule(nextDelayMs());
      return null;
    }

    // A full scan mutates the same state; rather than interleave, the poller
    // yields and tries again on the next tick.
    if (!manual && isPaused()) {
      status.skippedCount += 1;
      schedule(nextDelayMs());
      return null;
    }

    status.running = true;
    status.lastPollStartedAt = new Date(now()).toISOString();
    const startedAtMs = now();

    inFlightPromise = (async () => {
      try {
        const result = await run({ manual });
        consecutiveFailures = 0;
        status.pollCount += 1;
        status.lastSuccessAt = new Date(now()).toISOString();
        status.lastError = null;
        status.lastCount = result?.count ?? null;
        status.lastNewCount = result?.newCount ?? null;
        return result;
      } catch (error) {
        consecutiveFailures += 1;
        status.failureCount += 1;
        status.lastErrorAt = new Date(now()).toISOString();
        status.lastError = error.message;
        logger.error?.(`[hotlist] Poll failed (${consecutiveFailures} in a row): ${error.message}`);
        if (manual) throw error;
        return null;
      } finally {
        status.lastDurationMs = now() - startedAtMs;
        status.running = false;
        schedule(nextDelayMs());
      }
    })();

    try {
      return await inFlightPromise;
    } finally {
      inFlightPromise = null;
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      // A short initial delay lets the rest of the app finish booting before
      // the first poll fires.
      schedule(Math.min(5000, nextDelayMs()));
    },
    stop() {
      started = false;
      clearTimer();
      status.nextPollAt = null;
    },
    /** Re-arm with the new interval as soon as settings change. */
    reschedule() {
      if (!started) return;
      consecutiveFailures = 0;
      schedule(nextDelayMs());
    },
    /** Force a poll now (dashboard "Poll now" button). */
    async pollNow() {
      return tick({ manual: true });
    },
    getStatus() {
      return {
        ...status,
        enabled: getConfig().enabled !== false,
        started,
        consecutiveFailures,
      };
    },
  };
}
