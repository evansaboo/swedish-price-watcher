import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  verifyDiscordRequest,
  isAuthorizedDiscordUser,
  extractDiscordUserId,
  parseCustomId,
  handleInteraction,
  editOriginalResponse,
  INTERACTION_TYPE,
  INTERACTION_RESPONSE,
} from '../src/services/discordInteractions.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
// Discord hands out the raw 32-byte key as hex; strip the 12-byte SPKI header.
const PUBLIC_KEY_HEX = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');

function sign(timestamp, body) {
  return crypto.sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
}

test('verifyDiscordRequest accepts a genuine signature', () => {
  const timestamp = '1700000000';
  const rawBody = JSON.stringify({ type: 1 });
  assert.equal(
    verifyDiscordRequest({ publicKey: PUBLIC_KEY_HEX, signature: sign(timestamp, rawBody), timestamp, rawBody }),
    true,
  );
});

test('verifyDiscordRequest rejects tampering, replay across bodies and bad input', () => {
  const timestamp = '1700000000';
  const rawBody = JSON.stringify({ type: 1 });
  const signature = sign(timestamp, rawBody);

  const cases = [
    ['tampered body', { signature, timestamp, rawBody: JSON.stringify({ type: 3 }) }],
    ['tampered timestamp', { signature, timestamp: '1700000001', rawBody }],
    ['garbage signature', { signature: 'zz'.repeat(64), timestamp, rawBody }],
    ['short signature', { signature: 'ab', timestamp, rawBody }],
    ['missing signature', { timestamp, rawBody }],
    ['missing body', { signature, timestamp }],
  ];

  for (const [label, overrides] of cases) {
    assert.equal(
      verifyDiscordRequest({ publicKey: PUBLIC_KEY_HEX, ...overrides }),
      false,
      `must reject: ${label}`,
    );
  }
});

test('verifyDiscordRequest rejects a malformed public key instead of throwing', () => {
  const timestamp = '1700000000';
  const rawBody = '{}';
  assert.equal(verifyDiscordRequest({ publicKey: 'nothex', signature: sign(timestamp, rawBody), timestamp, rawBody }), false);
  assert.equal(verifyDiscordRequest({ publicKey: '', signature: 'a', timestamp, rawBody }), false);
});

test('verifyDiscordRequest rejects a signature from a different key', () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const timestamp = '1700000000';
  const rawBody = '{"type":1}';
  const foreign = crypto.sign(null, Buffer.from(timestamp + rawBody), other.privateKey).toString('hex');
  assert.equal(verifyDiscordRequest({ publicKey: PUBLIC_KEY_HEX, signature: foreign, timestamp, rawBody }), false);
});

test('extractDiscordUserId reads guild and DM shapes', () => {
  assert.equal(extractDiscordUserId({ member: { user: { id: '1' } } }), '1');
  assert.equal(extractDiscordUserId({ user: { id: '2' } }), '2');
  assert.equal(extractDiscordUserId({}), null);
});

test('isAuthorizedDiscordUser allows only listed owners', () => {
  assert.equal(isAuthorizedDiscordUser({ member: { user: { id: '42' } } }, ['42']), true);
  assert.equal(isAuthorizedDiscordUser({ member: { user: { id: '43' } } }, ['42']), false);
  assert.equal(isAuthorizedDiscordUser({ member: { user: { id: '42' } } }, []), false, 'empty allow-list denies everyone');
  assert.equal(isAuthorizedDiscordUser({}, ['42']), false);
});

test('parseCustomId splits on the first separator only', () => {
  assert.deepEqual(parseCustomId('buy:abc:def'), { action: 'buy', value: 'abc:def' });
  assert.deepEqual(parseCustomId('ping'), { action: 'ping', value: '' });
});

test('handleInteraction answers PING with PONG', () => {
  const { response } = handleInteraction({ interaction: { type: INTERACTION_TYPE.PING } });
  assert.deepEqual(response, { type: INTERACTION_RESPONSE.PONG });
});

test('handleInteraction refuses an unauthorised presser before touching the handler', () => {
  let called = false;
  const { response, followUp } = handleInteraction({
    interaction: { type: INTERACTION_TYPE.MESSAGE_COMPONENT, data: { custom_id: 'buy:t' }, member: { user: { id: 'intruder' } } },
    ownerIds: ['owner'],
    onBuy: async () => { called = true; return 'ok'; },
  });
  assert.match(response.data.content, /not authorised/);
  assert.equal(response.data.flags, 64, 'refusal is ephemeral');
  assert.equal(followUp, undefined);
  assert.equal(called, false);
});

test('handleInteraction defers a buy and delivers the result via follow-up', async () => {
  const patched = [];
  const interaction = {
    type: INTERACTION_TYPE.MESSAGE_COMPONENT,
    data: { custom_id: 'buy:token-123' },
    member: { user: { id: 'owner' } },
    application_id: 'app',
    token: 'itoken',
  };

  const { response, followUp } = handleInteraction({
    interaction,
    ownerIds: ['owner'],
    onBuy: async ({ token }) => `staged ${token}`,
  });

  // Staging needs a browser, so Discord must be answered inside 3 seconds.
  assert.equal(response.type, INTERACTION_RESPONSE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
  assert.equal(response.data.flags, 64);

  globalThis.fetch = async (url, options) => {
    patched.push({ url, body: JSON.parse(options.body) });
    return { ok: true };
  };
  await followUp();
  assert.match(patched[0].url, /webhooks\/app\/itoken\/messages\/@original$/);
  assert.equal(patched[0].body.content, 'staged token-123');
});

test('handleInteraction surfaces a handler failure instead of hanging the reply', async () => {
  const patched = [];
  globalThis.fetch = async (url, options) => {
    patched.push(JSON.parse(options.body));
    return { ok: true };
  };

  const { followUp } = handleInteraction({
    interaction: {
      type: INTERACTION_TYPE.MESSAGE_COMPONENT,
      data: { custom_id: 'buy:t' },
      member: { user: { id: 'owner' } },
      application_id: 'app',
      token: 'itoken',
    },
    ownerIds: ['owner'],
    onBuy: async () => { throw new Error('browser crashed'); },
  });

  await followUp();
  assert.match(patched[0].content, /browser crashed/);
});

test('handleInteraction rejects unknown actions and unsupported types', () => {
  const unknown = handleInteraction({
    interaction: { type: INTERACTION_TYPE.MESSAGE_COMPONENT, data: { custom_id: 'delete:1' }, member: { user: { id: 'o' } } },
    ownerIds: ['o'],
    onBuy: async () => 'x',
  });
  assert.match(unknown.response.data.content, /Unknown action/);

  const unsupported = handleInteraction({ interaction: { type: 99 } });
  assert.match(unsupported.response.data.content, /Unsupported/);
});

test('editOriginalResponse no-ops without interaction identifiers', async () => {
  assert.equal(await editOriginalResponse({}, 'hi'), false);
});
