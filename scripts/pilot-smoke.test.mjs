import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readConfig, run, signWebhook } from './pilot-smoke.mjs';

const require = createRequire(import.meta.url);
const SECRET = 's'.repeat(40);
const goodEnv = {
  API_URL: 'https://api.example.com/',
  ACCESS_TOKEN: 'tok',
  SITE_ID: 'site',
  ROUTER_ID: 'router',
  PLAN_ID: 'plan',
  PAYMENT_WEBHOOK_SECRET: SECRET,
};
const FLAG = ['--yes-this-uses-the-sandbox'];

test('the configuration is strict and requires explicit consent', () => {
  assert.equal(readConfig(goodEnv, FLAG).apiUrl, 'https://api.example.com');
  assert.throws(() => readConfig({ ...goodEnv, PLAN_ID: '' }, FLAG), /PLAN_ID/);
  assert.throws(() => readConfig(goodEnv, []), /yes-this-uses-the-sandbox/);
  assert.throws(() => readConfig({ ...goodEnv, PAYMENT_WEBHOOK_SECRET: 'short' }, FLAG), /32 caractères/);
  assert.throws(() => readConfig({ ...goodEnv, API_URL: 'api.example.com' }, FLAG), /http/);
});

test('signatures produced by the script are accepted by the API verification code, and only with the right secret', () => {
  const { SandboxPaymentProvider } = require('../apps/api/dist/payments/payment-provider.js');
  const provider = new SandboxPaymentProvider({ PAYMENT_SANDBOX_WEBHOOK_SECRET: SECRET });
  const body = Buffer.from(JSON.stringify({ event_id: 'e1', provider_ref: 'MTD-abc12345', status: 'succeeded', amount: 500, currency: 'CDF' }));
  const now = new Date();
  const stamp = Math.floor(now.getTime() / 1000);
  const parsed = provider.verifyAndParse(body, { 'x-mtandao-signature': signWebhook(SECRET, body, stamp) }, now);
  assert.equal(parsed.eventId, 'e1');
  assert.throws(() => provider.verifyAndParse(body, { 'x-mtandao-signature': signWebhook('x'.repeat(40), body, stamp) }, now));
});

/** A fake API that behaves like the real one, with switches to break one behaviour at a time. */
function fakeApi(options = {}) {
  const state = { seen: new Set(), paid: false, fulfillment: options.fulfillment ?? 'activated', calls: [] };
  const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace('https://api.test', '');
    state.calls.push(`${init.method ?? 'GET'} ${path}`);
    if (path.endsWith('/readiness')) return json({ ready: options.ready ?? true, checks: [{ status: 'fail', label: 'Stock de tickets' }] });
    if (path.endsWith('/payments') && init.method === 'POST')
      return json({ payment_id: 'pay-1', provider_ref: 'MTD-abc12345', amount: 500, currency: 'CDF', status: 'pending' });
    if (path.startsWith('/v1/webhooks/payments/sandbox')) {
      const sig = init.headers?.['X-Mtandao-Signature'];
      const valid = sig && sig.includes(createHexOf(init.body, SECRET, sig));
      if (!valid && !options.acceptForged) return json({}, 401);
      const event = JSON.parse(init.body);
      if (state.seen.has(event.event_id)) return json({ outcome: options.duplicateOutcome ?? 'duplicate' });
      state.seen.add(event.event_id);
      return json({ outcome: 'paid' });
    }
    if (path.includes('/payments?limit')) return json({ items: [{ id: 'pay-1', fulfillment_status: state.fulfillment }] });
    return json({}, 404);
  };
  return { fetchImpl, state };
}
import { createHmac } from 'node:crypto';
function createHexOf(body, secret, header) {
  const t = /t=(\d+)/.exec(header)[1];
  return createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
}

const clock = () => {
  let t = 1_800_000_000_000;
  return { now: () => t, sleep: async ms => { t += ms; } };
};
const run1 = (api, extra = {}) => {
  const c = clock();
  return run({ ...readConfig(goodEnv, FLAG), apiUrl: 'https://api.test', activationTimeoutSeconds: 20, ...extra }, api.fetchImpl, c.now, c.sleep, () => {});
};
const byName = (results, name) => results.find(r => r.name.startsWith(name));

test('a healthy deployment passes every check', async () => {
  const api = fakeApi();
  const results = await run1(api);
  assert.ok(results.every(r => r.ok), JSON.stringify(results));
  assert.equal(results.length, 6);
  // The genuine event was sent once, then once more (duplicate), forged ones came first.
  assert.equal(api.state.calls.filter(c => c.startsWith('POST /v1/webhooks')).length, 4);
});

test('a site that cannot sell stops the test before any payment is created', async () => {
  const api = fakeApi({ ready: false });
  const results = await run1(api);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].detail, /Stock de tickets/);
  assert.equal(api.state.calls.some(c => c.startsWith('POST /v1/sites')), false);
});

test('an API that accepts a forged webhook is reported as a failure', async () => {
  const results = await run1(fakeApi({ acceptForged: true }));
  assert.equal(byName(results, 'Faux webhook').ok, false);
});

test('a duplicated webhook that is not recognized as a duplicate is reported', async () => {
  const results = await run1(fakeApi({ duplicateOutcome: 'paid' }));
  assert.equal(byName(results, 'Webhook dupliqué').ok, false);
});

test('a Gateway that never confirms leaves the ticket pending and says why', async () => {
  const results = await run1(fakeApi({ fulfillment: 'activation_pending' }));
  const activation = byName(results, 'Ticket activé');
  assert.equal(activation.ok, false);
  assert.match(activation.detail, /GATEWAY_COMMANDS_ENABLED/);
});

test('an out-of-stock or failed activation is reported with its state', async () => {
  const results = await run1(fakeApi({ fulfillment: 'out_of_stock' }));
  assert.equal(byName(results, 'Ticket activé').detail, 'out_of_stock');
});
