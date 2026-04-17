const STOCKHOLM_TIME_ZONE = 'Europe/Stockholm';
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function normalizeIntervalMinutes(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeTimeOfDay(value, fallback) {
  const candidate = String(value ?? '').trim();
  return TIME_OF_DAY_PATTERN.test(candidate) ? candidate : fallback;
}

function timeOfDayToMinutes(value) {
  const [hours, minutes] = String(value).split(':').map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

function resolveNow(nowProvider) {
  const candidate = nowProvider();
  return candidate instanceof Date && Number.isFinite(candidate.getTime()) ? candidate : new Date();
}

function resolveMinuteInTimeZone(now, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = formatter.formatToParts(now);
  const hours = Number.parseInt(parts.find((part) => part.type === 'hour')?.value ?? '', 10);
  const minutes = Number.parseInt(parts.find((part) => part.type === 'minute')?.value ?? '', 10);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  return hours * 60 + minutes;
}

export function normalizeActiveWindow(activeWindow, fallback = null) {
  const base = fallback ?? {
    enabled: false,
    startTime: '07:00',
    endTime: '00:00',
    timeZone: STOCKHOLM_TIME_ZONE
  };
  const raw = activeWindow && typeof activeWindow === 'object' && !Array.isArray(activeWindow) ? activeWindow : {};
  const timeZone = String(raw.timeZone ?? base.timeZone).trim() || base.timeZone;

  return {
    enabled: raw.enabled === undefined ? Boolean(base.enabled) : Boolean(raw.enabled),
    startTime: normalizeTimeOfDay(raw.startTime, base.startTime),
    endTime: normalizeTimeOfDay(raw.endTime, base.endTime),
    timeZone
  };
}

export function isWithinActiveWindow(activeWindow, now = new Date()) {
  const normalized = normalizeActiveWindow(activeWindow);

  if (!normalized.enabled) {
    return true;
  }

  const currentMinute = resolveMinuteInTimeZone(now, normalized.timeZone);

  if (currentMinute == null) {
    return true;
  }

  const startMinute = timeOfDayToMinutes(normalized.startTime);
  const endMinute = timeOfDayToMinutes(normalized.endTime);

  if (startMinute === endMinute) {
    return true;
  }

  if (startMinute < endMinute) {
    return currentMinute >= startMinute && currentMinute < endMinute;
  }

  return currentMinute >= startMinute || currentMinute < endMinute;
}

export function createSchedulerController({ run, intervalMinutes, enabled = true, activeWindow, nowProvider = () => new Date() }) {
  let currentIntervalMinutes = normalizeIntervalMinutes(intervalMinutes, 180);
  let currentEnabled = Boolean(enabled) && currentIntervalMinutes > 0;
  let currentActiveWindow = normalizeActiveWindow(activeWindow);
  let timer = null;
  let nextRunAt = null;

  function scheduleNextRun() {
    if (!currentEnabled || !currentIntervalMinutes) {
      nextRunAt = null;
      return;
    }

    const now = resolveNow(nowProvider);
    nextRunAt = new Date(now.getTime() + currentIntervalMinutes * 60 * 1000).toISOString();
  }

  function clearTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    nextRunAt = null;
  }

  function executeTick() {
    const now = resolveNow(nowProvider);

    if (isWithinActiveWindow(currentActiveWindow, now)) {
      run().catch((error) => {
        console.error('[scheduler]', error.message);
      });
    }

    scheduleNextRun();
  }

  function startTimer() {
    if (!currentEnabled || !currentIntervalMinutes || timer) {
      return;
    }

    scheduleNextRun();
    timer = setInterval(executeTick, currentIntervalMinutes * 60 * 1000);
  }

  function restart() {
    clearTimer();
    startTimer();
  }

  function getState() {
    return {
      enabled: currentEnabled,
      intervalMinutes: currentIntervalMinutes,
      nextRunAt,
      activeWindow: { ...currentActiveWindow },
      isInActiveWindow: isWithinActiveWindow(currentActiveWindow, resolveNow(nowProvider))
    };
  }

  startTimer();

  return {
    getState,
    update({ enabled: nextEnabled, intervalMinutes: nextIntervalMinutes, activeWindow: nextActiveWindow } = {}) {
      if (nextEnabled !== undefined) {
        currentEnabled = Boolean(nextEnabled);
      }

      if (nextIntervalMinutes !== undefined) {
        const normalized = normalizeIntervalMinutes(nextIntervalMinutes);

        if (!normalized) {
          throw new Error('intervalMinutes must be a positive integer.');
        }

        currentIntervalMinutes = normalized;
      }

      if (nextActiveWindow !== undefined) {
        currentActiveWindow = normalizeActiveWindow(nextActiveWindow, currentActiveWindow);
      }

      if (currentIntervalMinutes <= 0) {
        currentEnabled = false;
      }

      restart();
      return getState();
    },
    stop() {
      clearTimer();
    },
    start() {
      startTimer();
    }
  };
}

export function startScheduler(run, intervalMinutes) {
  const controller = createSchedulerController({
    run,
    intervalMinutes,
    enabled: true
  });

  return () => controller.stop();
}
