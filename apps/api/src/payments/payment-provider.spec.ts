import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { MAX_WEBHOOK_BYTES, SandboxPaymentProvider, WebhookRejectedError } from './payment-provider';

const SECRET = 's'.repeat(40);
const NOW = new Date('2026-11-22T10:00:00Z');
const provider = new SandboxPaymentProvider({ PAYMENT_SANDBOX_WEBHOOK_SECRET: SECRET });

const body = (overrides: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({ event_id: 'evt-1', provider_ref: 'MTD-abc12345', status: 'succeeded', amount: 500, currency: 'CDF', ...overrides }),
  );

function sign(raw: Buffer, secret = SECRET, at = NOW): Record<string, string> {
  const t = String(Math.floor(at.getTime() / 1000));
  const v1 = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  return { 'x-mtandao-signature': `t=${t},v1=${v1}` };
}

const rejected = (reason: 'signature' | 'malformed') => (error: unknown) =>
  error instanceof WebhookRejectedError && error.reason === reason;

test('a correctly signed webhook is parsed', () => {
  const raw = body();
  const event = provider.verifyAndParse(raw, sign(raw), NOW);
  assert.equal(event.eventId, 'evt-1');
  assert.equal(event.providerRef, 'MTD-abc12345');
  assert.equal(event.status, 'succeeded');
  assert.equal(event.amount, 500);
  assert.equal(event.currency, 'CDF');
});

test('a forged or tampered webhook is rejected', () => {
  const raw = body();
  assert.throws(() => provider.verifyAndParse(raw, sign(raw, 'x'.repeat(40)), NOW), rejected('signature'));
  const signed = sign(raw);
  assert.throws(() => provider.verifyAndParse(body({ amount: 1 }), signed, NOW), rejected('signature'));
  assert.throws(() => provider.verifyAndParse(raw, {}, NOW), rejected('signature'));
  for (const bad of ['', 't=1,v1=zz', 'v1=' + 'a'.repeat(64), `t=${Math.floor(NOW.getTime() / 1000)},v1=${'0'.repeat(64)}`]) {
    assert.throws(() => provider.verifyAndParse(raw, { 'x-mtandao-signature': bad }, NOW), rejected('signature'), bad);
  }
});

test('a captured request cannot be replayed outside the tolerance window', () => {
  const raw = body();
  const old = sign(raw, SECRET, new Date(NOW.getTime() - 6 * 60 * 1000));
  assert.throws(() => provider.verifyAndParse(raw, old, NOW), rejected('signature'));
  const future = sign(raw, SECRET, new Date(NOW.getTime() + 6 * 60 * 1000));
  assert.throws(() => provider.verifyAndParse(raw, future, NOW), rejected('signature'));
  const recent = sign(raw, SECRET, new Date(NOW.getTime() - 4 * 60 * 1000));
  assert.equal(provider.verifyAndParse(raw, recent, NOW).eventId, 'evt-1');
});

test('signed but malformed payloads are refused as malformed', () => {
  const cases: Array<Buffer> = [
    Buffer.from('not json'),
    Buffer.from('[1,2]'),
    body({ status: 'pending' }),
    body({ amount: -1 }),
    body({ amount: '500' }),
    body({ currency: 'EUR' }),
    body({ event_id: '' }),
    body({ provider_ref: 'x'.repeat(101) }),
    Buffer.alloc(MAX_WEBHOOK_BYTES + 1, 'a'),
  ];
  for (const raw of cases) {
    assert.throws(() => provider.verifyAndParse(raw, sign(raw), NOW), rejected('malformed'));
  }
});

test('the provider is disabled without a strong secret', () => {
  assert.equal(new SandboxPaymentProvider({}).isConfigured(), false);
  assert.equal(new SandboxPaymentProvider({ PAYMENT_SANDBOX_WEBHOOK_SECRET: 'short' }).isConfigured(), false);
  assert.equal(provider.isConfigured(), true);
  const raw = body();
  assert.throws(
    () => new SandboxPaymentProvider({}).verifyAndParse(raw, sign(raw), NOW),
    rejected('signature'),
  );
});
