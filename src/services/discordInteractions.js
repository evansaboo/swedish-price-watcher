import crypto from 'node:crypto';

/**
 * Discord interactions (button clicks).
 *
 * Discord webhooks are send-only; receiving a button click requires a registered
 * Discord *application* with a public interactions endpoint. Discord signs every
 * request with Ed25519 and will refuse to register an endpoint that does not
 * reject bad signatures, so verification here is both a security boundary and a
 * hard protocol requirement.
 */

export const INTERACTION_TYPE = Object.freeze({ PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 });
export const INTERACTION_RESPONSE = Object.freeze({
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
});
const EPHEMERAL = 64;

// SPKI DER header for a raw 32-byte Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function toPublicKey(publicKeyHex) {
  const raw = Buffer.from(String(publicKeyHex ?? ''), 'hex');
  if (raw.length !== 32) throw new Error('Discord public key must be 32 bytes of hex.');
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * @returns {boolean} true only for a genuine, untampered Discord request.
 */
export function verifyDiscordRequest({ publicKey, signature, timestamp, rawBody } = {}) {
  if (!publicKey || !signature || !timestamp || typeof rawBody !== 'string') return false;
  let key;
  try {
    key = toPublicKey(publicKey);
  } catch {
    return false;
  }
  let signatureBuffer;
  try {
    signatureBuffer = Buffer.from(String(signature), 'hex');
  } catch {
    return false;
  }
  if (signatureBuffer.length !== 64) return false;

  try {
    return crypto.verify(
      null,
      Buffer.from(String(timestamp) + rawBody),
      key,
      signatureBuffer,
    );
  } catch {
    return false;
  }
}

/** Discord puts the user under `member` in a guild and `user` in a DM. */
export function extractDiscordUserId(interaction = {}) {
  return interaction?.member?.user?.id ?? interaction?.user?.id ?? null;
}

/**
 * Second security layer: even a validly signed interaction must come from an
 * allow-listed account. Without this, anyone who can see the alert channel
 * could press the button.
 */
export function isAuthorizedDiscordUser(interaction, ownerIds = []) {
  const userId = extractDiscordUserId(interaction);
  if (!userId) return false;
  return ownerIds.some((candidate) => {
    const a = Buffer.from(String(candidate));
    const b = Buffer.from(String(userId));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

export function parseCustomId(customId) {
  const raw = String(customId ?? '');
  const separator = raw.indexOf(':');
  if (separator === -1) return { action: raw, value: '' };
  return { action: raw.slice(0, separator), value: raw.slice(separator + 1) };
}

function ephemeral(content) {
  return {
    type: INTERACTION_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL },
  };
}

/**
 * Route a verified interaction.
 *
 * Staging needs a browser and blows Discord's 3-second response budget, so a
 * buy press is acknowledged immediately with a deferred ephemeral reply and the
 * real result is PATCHed onto that reply afterwards via `followUp`.
 *
 * @returns {{response: object, followUp?: () => Promise<void>}}
 */
export function handleInteraction({ interaction, ownerIds = [], onBuy } = {}) {
  if (interaction?.type === INTERACTION_TYPE.PING) {
    return { response: { type: INTERACTION_RESPONSE.PONG } };
  }

  if (interaction?.type !== INTERACTION_TYPE.MESSAGE_COMPONENT) {
    return { response: ephemeral('Unsupported interaction.') };
  }

  if (!isAuthorizedDiscordUser(interaction, ownerIds)) {
    return { response: ephemeral('⛔ You are not authorised to use this control.') };
  }

  const { action, value } = parseCustomId(interaction?.data?.custom_id);
  if (action !== 'buy') {
    return { response: ephemeral('Unknown action.') };
  }
  if (typeof onBuy !== 'function') {
    return { response: ephemeral('Purchase handling is not configured.') };
  }

  return {
    response: {
      type: INTERACTION_RESPONSE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: EPHEMERAL },
    },
    followUp: async () => {
      let content;
      try {
        content = await onBuy({ token: value, interaction });
      } catch (error) {
        content = `❌ Staging failed: ${error.message}`;
      }
      await editOriginalResponse(interaction, content);
    },
  };
}

/**
 * Edit the deferred reply. Uses the interaction token, so no bot token is
 * required — the app only ever needs its public key and application id.
 */
export async function editOriginalResponse(interaction, content, fetchImpl = fetch) {
  const applicationId = interaction?.application_id;
  const token = interaction?.token;
  if (!applicationId || !token) return false;

  const body = typeof content === 'string' ? { content } : content;
  const response = await fetchImpl(
    `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return response.ok;
}
