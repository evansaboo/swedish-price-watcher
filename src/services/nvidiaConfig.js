export const DEFAULT_NVIDIA_CONFIG = {
  enabled: false,
  intervalSeconds: 15,
  locale: 'sv-se',
  monitoredCards: ['5090', '5080', '5070'],
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
  const locale = typeof raw.locale === 'string' && raw.locale.trim()
    ? raw.locale.trim().toLowerCase()
    : 'sv-se';
  const monitoredCards = Array.isArray(raw.monitoredCards) && raw.monitoredCards.length > 0
    ? raw.monitoredCards.map(String)
    : ['5090', '5080', '5070'];
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
