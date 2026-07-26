import crypto from 'node:crypto';

function hash(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'canary.discord.com',
  'ptb.discord.com'
]);

export function extractBearerToken(headers = {}) {
  return String(headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
}

export function normalizeDiscordWebhookUrl(value, { allowEmpty = true } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw && allowEmpty) return '';

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Discord webhook must be a valid HTTPS URL.');
  }

  const webhookPath = /^\/api(?:\/v\d+)?\/webhooks\/[^/]+\/[^/]+\/?$/;
  if (
    parsed.protocol !== 'https:' ||
    !DISCORD_WEBHOOK_HOSTS.has(parsed.hostname) ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    !webhookPath.test(parsed.pathname)
  ) {
    throw new Error('Discord webhook must use an official Discord webhook URL.');
  }
  parsed.hash = '';
  return parsed.toString();
}

export function createSubscriber(input = {}, now = new Date()) {
  const accessKey = crypto.randomBytes(32).toString('base64url');
  const timestamp = now.toISOString();
  const subscriber = {
    id: `subscriber-${crypto.randomUUID()}`,
    accessKeyHash: hash(accessKey),
    plan: String(input.plan ?? 'premium').trim() || 'premium',
    status: input.status === 'active' ? 'active' : 'pending',
    discordWebhook: normalizeDiscordWebhookUrl(input.discordWebhook),
    minNetProfitSek: Math.max(0, Number(input.minNetProfitSek) || 500),
    minRoiPercent: Math.max(0, Number(input.minRoiPercent) || 15),
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  return { subscriber, accessKey };
}

export function sanitizeSubscriber(subscriber) {
  const { accessKeyHash: _accessKeyHash, ...safe } = subscriber;
  return safe;
}

export function findSubscriberByAccessKey(subscribers = [], accessKey, staticKeys = []) {
  if (!accessKey) return null;
  if (staticKeys.some((candidate) => safeEqual(candidate, accessKey))) {
    return { id: 'configured-premium-key', plan: 'premium', status: 'active', configured: true };
  }
  const keyHash = hash(accessKey);
  return subscribers.find((subscriber) =>
    subscriber.status === 'active' && safeEqual(subscriber.accessKeyHash, keyHash)
  ) ?? null;
}

export function verifyStripeSignature(rawBody, signatureHeader, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || !rawBody || !signatureHeader) return false;
  const parts = String(signatureHeader).split(',');
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  const parsedTimestamp = Number(timestamp);
  if (!Number.isFinite(parsedTimestamp) || Math.abs(nowSeconds - parsedTimestamp) > 300) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return signatures.some((signature) => safeEqual(signature, expected));
}

export function applyStripeEvent(subscribers, event, now = new Date()) {
  const object = event?.data?.object ?? {};
  const subscriberId = object.metadata?.subscriber_id ?? object.client_reference_id;
  if (!subscriberId) return null;
  const subscriber = subscribers.find((entry) => entry.id === subscriberId);
  if (!subscriber) return null;

  const eventCreated = Number(event.created);
  const lastEventCreated = Number(subscriber.stripeEventCreated);
  const processedEventIds = Array.isArray(subscriber.stripeEventIds) ? subscriber.stripeEventIds : [];
  if (event.id && processedEventIds.includes(event.id)) {
    return null;
  }

  const activeStatuses = new Set(['active', 'trialing']);
  let eventPriority;
  if (event.type === 'checkout.session.completed') eventPriority = 0;
  else if (event.type.startsWith('customer.subscription.')) {
    eventPriority = activeStatuses.has(object.status) ? 1 : 2;
  } else {
    return null;
  }

  const lastEventPriority = Number(subscriber.stripeEventPriority);
  if (
    Number.isFinite(eventCreated) &&
    Number.isFinite(lastEventCreated) &&
    (eventCreated < lastEventCreated ||
      (eventCreated === lastEventCreated && Number.isFinite(lastEventPriority) && eventPriority < lastEventPriority))
  ) {
    return null;
  }

  if (event.type === 'checkout.session.completed') {
    if (object.payment_status === 'paid') subscriber.status = 'active';
    subscriber.stripeCustomerId = object.customer ?? subscriber.stripeCustomerId;
    subscriber.stripeSubscriptionId = object.subscription ?? subscriber.stripeSubscriptionId;
  } else {
    subscriber.status = activeStatuses.has(object.status) ? 'active' : 'inactive';
    subscriber.stripeCustomerId = object.customer ?? subscriber.stripeCustomerId;
    subscriber.stripeSubscriptionId = object.id ?? subscriber.stripeSubscriptionId;
  }
  if (Number.isFinite(eventCreated)) {
    subscriber.stripeEventCreated = eventCreated;
    subscriber.stripeEventPriority = eventPriority;
  }
  if (event.id) subscriber.stripeEventIds = [...processedEventIds, event.id].slice(-20);
  subscriber.updatedAt = now.toISOString();
  return subscriber;
}
