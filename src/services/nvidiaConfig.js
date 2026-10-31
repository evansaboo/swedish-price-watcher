import { isSupportedCard } from '../sources/nvidia.js';
import { FEED_LOCALES } from '../sources/nvidiaLiveFeed.js';

const DEFAULT_MONITORED_CARDS = ['5090', '5080', '5070'];

export const DEFAULT_NVIDIA_CONFIG = {
  enabled: false,
  // Legacy: the tracker now follows Notify-FE's push feed and has no poll interval.
  // Kept so stored preferences round-trip unchanged.
  intervalSeconds: 15,
  locale: 'sv-se',
  monitoredCards: [...DEFAULT_MONITORED_CARDS],
  discordWebhookUrl: '',
  notifyOnStock: true,
  apiAlarmEnabled: false,
  soundEnabled: true,
  autoOpenShop: false,
  repetitions: 1
};

export function normalizeNvidiaConfig(raw = {}) {
  const enabled = Boolean(raw.enabled);
  const parsedInterval = Number.parseInt(String(raw.intervalSeconds ?? ''), 10);
  const intervalSeconds = Number.isFinite(parsedInterval) && parsedInterval >= 5 && parsedInterval <= 3600
    ? parsedInterval
    : 15;
  const rawLocale = typeof raw.locale === 'string' ? raw.locale.trim().toLowerCase() : '';
  const locale = FEED_LOCALES.includes(rawLocale) ? rawLocale : 'sv-se';
  // Drop cards the feed doesn't track (e.g. stored 4090/4080S/4070S entries).
  const supportedCards = Array.isArray(raw.monitoredCards)
    ? Array.from(new Set(raw.monitoredCards.map(String).filter(isSupportedCard)))
    : [];
  const monitoredCards = supportedCards.length > 0 ? supportedCards : [...DEFAULT_MONITORED_CARDS];
  const discordWebhookUrl = typeof raw.discordWebhookUrl === 'string'
    ? raw.discordWebhookUrl.trim()
    : '';
  const notifyOnStock = raw.notifyOnStock !== false;
  const apiAlarmEnabled = Boolean(raw.apiAlarmEnabled);
  const soundEnabled = raw.soundEnabled !== false;
  const autoOpenShop = Boolean(raw.autoOpenShop);
  const repetitions = Math.max(1, Math.min(5, Number(raw.repetitions) || 1));

  return {
    enabled,
    intervalSeconds,
    locale,
    monitoredCards,
    discordWebhookUrl,
    notifyOnStock,
    apiAlarmEnabled,
    soundEnabled,
    autoOpenShop,
    repetitions
  };
}

export function ensureNvidiaConfig(preferences) {
  if (!preferences.nvidiaFe || typeof preferences.nvidiaFe !== 'object') {
    preferences.nvidiaFe = { ...DEFAULT_NVIDIA_CONFIG };
  } else {
    preferences.nvidiaFe = normalizeNvidiaConfig(preferences.nvidiaFe);
  }
  return preferences.nvidiaFe;
}
