import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  applyStripeEvent,
  createSubscriber,
  findSubscriberByAccessKey,
  normalizeDiscordWebhookUrl,
  verifyStripeSignature
} from '../src/services/accessControl.js';

test('subscriber access keys are returned once and stored as hashes', () => {
  const { subscriber, accessKey } = createSubscriber({ status: 'active' });
  assert.ok(accessKey);
  assert.notEqual(subscriber.accessKeyHash, accessKey);
  assert.equal(findSubscriberByAccessKey([subscriber], accessKey)?.id, subscriber.id);
  assert.equal(findSubscriberByAccessKey([subscriber], 'wrong'), null);
});

test('Stripe signature verification enforces HMAC and timestamp tolerance', () => {
  const raw = '{"id":"evt_1"}';
  const secret = 'whsec_test';
  const timestamp = 1_800_000_000;
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  const header = `t=${timestamp},v1=${signature}`;
  assert.equal(verifyStripeSignature(raw, header, secret, timestamp), true);
  assert.equal(verifyStripeSignature(raw, header, secret, timestamp + 301), false);
  assert.equal(verifyStripeSignature(raw, `${header}bad`, secret, timestamp), false);
});

test('Stripe events activate and deactivate the matching subscriber', () => {
  const { subscriber } = createSubscriber();
  const subscribers = [subscriber];
  applyStripeEvent(subscribers, {
    id: 'evt_checkout',
    type: 'checkout.session.completed',
    created: 100,
    data: { object: { client_reference_id: subscriber.id, payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1' } }
  });
  assert.equal(subscriber.status, 'active');
  applyStripeEvent(subscribers, {
    id: 'evt_deleted',
    type: 'customer.subscription.deleted',
    created: 200,
    data: { object: { metadata: { subscriber_id: subscriber.id }, id: 'sub_1', status: 'canceled' } }
  });
  assert.equal(subscriber.status, 'inactive');
  applyStripeEvent(subscribers, {
    id: 'evt_old_checkout',
    type: 'checkout.session.completed',
    created: 150,
    data: { object: { client_reference_id: subscriber.id, payment_status: 'paid' } }
  });
  assert.equal(subscriber.status, 'inactive');
});

test('same-second Stripe cancellation overrides active updates', () => {
  const { subscriber } = createSubscriber({ status: 'active' });
  const subscribers = [subscriber];
  applyStripeEvent(subscribers, {
    id: 'evt_active',
    type: 'customer.subscription.updated',
    created: 300,
    data: { object: { metadata: { subscriber_id: subscriber.id }, status: 'active' } }
  });
  applyStripeEvent(subscribers, {
    id: 'evt_canceled',
    type: 'customer.subscription.deleted',
    created: 300,
    data: { object: { metadata: { subscriber_id: subscriber.id }, status: 'canceled' } }
  });
  assert.equal(subscriber.status, 'inactive');
  assert.equal(subscriber.stripeEventIds.length, 2);
});

test('unpaid checkout sessions do not activate premium access', () => {
  const { subscriber } = createSubscriber();
  applyStripeEvent([subscriber], {
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: subscriber.id, payment_status: 'unpaid' } }
  });
  assert.equal(subscriber.status, 'pending');
});

test('premium webhooks only accept official Discord endpoints', () => {
  assert.equal(
    normalizeDiscordWebhookUrl('https://discord.com/api/webhooks/123/token'),
    'https://discord.com/api/webhooks/123/token'
  );
  assert.throws(
    () => normalizeDiscordWebhookUrl('http://127.0.0.1:8080/api/webhooks/123/token'),
    /official Discord webhook URL/
  );
  assert.throws(
    () => createSubscriber({ discordWebhook: 'https://example.com/api/webhooks/123/token' }),
    /official Discord webhook URL/
  );
});
