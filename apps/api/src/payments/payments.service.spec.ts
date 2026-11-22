import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PaymentsService } from './payments.service';
import { WebhookService } from './webhook.service';

const originalFetch = globalThis.fetch;
const saved = { ...process.env };
const SECRET = 'w'.repeat(40);

function setup(handler: (url: URL, init?: RequestInit) => Response) {
  process.env.SUPABASE_URL = 'https://example.supabase.co/';
  process.env.SUPABASE_ANON_KEY = 'anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET = SECRET;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) =>
    handler(new URL(String(input)), init)) as typeof fetch;
}
function restore() {
  globalThis.fetch = originalFetch;
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'PAYMENT_SANDBOX_WEBHOOK_SECRET']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function signed(overrides: Record<string, unknown> = {}, now = new Date()) {
  const raw = Buffer.from(
    JSON.stringify({ event_id: 'evt-1', provider_ref: 'MTD-abc12345', status: 'succeeded', amount: 500, currency: 'CDF', ...overrides }),
  );
  const t = String(Math.floor(now.getTime() / 1000));
  const v1 = createHmac('sha256', SECRET).update(`${t}.`).update(raw).digest('hex');
  return { raw, headers: { 'x-mtandao-signature': `t=${t},v1=${v1}` } };
}

test('a verified webhook is applied with the service role and returns the outcome', async () => {
  let url: URL | undefined;
  let body: Record<string, unknown> = {};
  let auth = '';
  setup((u, init) => {
    url = u;
    body = JSON.parse(String(init?.body));
    auth = new Headers(init?.headers).get('authorization') ?? '';
    return json({ outcome: 'paid' });
  });
  try {
    const { raw, headers } = signed();
    const result = await new WebhookService().handle('sandbox', raw, headers);
    assert.deepEqual(result, { outcome: 'paid' });
    assert.equal(url?.pathname, '/rest/v1/rpc/process_payment_webhook');
    assert.equal(auth, 'Bearer service-key');
    assert.equal(body.p_provider, 'sandbox');
    assert.equal(body.p_event_id, 'evt-1');
    assert.equal(body.p_amount, 500);
  } finally {
    restore();
  }
});

test('an unsigned, forged or stale webhook never reaches the database', async () => {
  let calls = 0;
  setup(() => {
    calls += 1;
    return json({ outcome: 'paid' });
  });
  try {
    const svc = new WebhookService();
    const { raw, headers } = signed();
    await assert.rejects(() => svc.handle('sandbox', raw, {}), /Invalid webhook signature/);
    await assert.rejects(() => svc.handle('sandbox', Buffer.from(raw.toString().replace('500', '1')), headers), /Invalid webhook signature/);
    const stale = signed({}, new Date(Date.now() - 3600_000));
    await assert.rejects(() => svc.handle('sandbox', stale.raw, stale.headers), /Invalid webhook signature/);
    const malformed = signed({ amount: 'free' });
    await assert.rejects(() => svc.handle('sandbox', malformed.raw, malformed.headers), /Invalid webhook payload/);
    await assert.rejects(() => svc.handle('sandbox', undefined, headers), /Request body is required/);
    await assert.rejects(() => svc.handle('stripe', raw, headers), /Unknown payment provider/);
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test('missing configuration fails closed', async () => {
  setup(() => json({ outcome: 'paid' }));
  try {
    const { raw, headers } = signed();
    delete process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET;
    await assert.rejects(() => new WebhookService().handle('sandbox', raw, headers), /not configured/);
    process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET = SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await assert.rejects(() => new WebhookService().handle('sandbox', raw, headers), /Payment processing is not configured/);
  } finally {
    restore();
  }
});

test('database failures are surfaced so the provider retries', async () => {
  try {
    const { raw, headers } = signed();
    setup(() => json({ code: 'XX000' }, 500));
    await assert.rejects(() => new WebhookService().handle('sandbox', raw, headers), /Unable to record the payment event/);
    setup(() => {
      throw new Error('down');
    });
    await assert.rejects(() => new WebhookService().handle('sandbox', raw, headers), /unavailable/);
    setup(() => json({ nope: true }));
    await assert.rejects(() => new WebhookService().handle('sandbox', raw, headers), /invalid result/);
  } finally {
    restore();
  }
});

test('create sends the plan, router and idempotency key with the user token', async () => {
  let body: Record<string, unknown> = {};
  let auth = '';
  setup((_u, init) => {
    body = JSON.parse(String(init?.body));
    auth = new Headers(init?.headers).get('authorization') ?? '';
    return json({ payment_id: 'p1', provider_ref: 'MTD-1', amount: 500, currency: 'CDF', status: 'pending', expires_at: 'x' });
  });
  try {
    const created = await new PaymentsService().create(
      'site',
      { planId: 'plan', routerId: 'router', customerPhone: '+243970000000', idempotencyKey: 'k' },
      'user-token',
    );
    assert.equal(created.payment_id, 'p1');
    assert.equal(auth, 'Bearer user-token');
    assert.deepEqual(body, {
      p_site_id: 'site', p_plan_id: 'plan', p_router_id: 'router',
      p_customer_phone: '+243970000000', p_idempotency_key: 'k',
    });
  } finally {
    restore();
  }
});

test('payment errors map to HTTP exceptions', async () => {
  const dto = { planId: 'p', routerId: 'r' };
  try {
    const svc = new PaymentsService();
    setup(() => json({ code: '42501' }, 403));
    await assert.rejects(() => svc.create('s', dto, 't'), /Insufficient permission/);
    setup(() => json({ code: 'P0002' }, 404));
    await assert.rejects(() => svc.create('s', dto, 't'), /not found/);
    setup(() => json({ code: '23505' }, 409));
    await assert.rejects(() => svc.create('s', dto, 't'), /Idempotency key/);
    setup(() => json({ code: '22023' }, 400));
    await assert.rejects(() => svc.retryActivation('s', 'p', 't'), /Invalid payment/);
    setup(() => json({ nope: 1 }));
    await assert.rejects(() => svc.create('s', dto, 't'), /invalid payment/);
    setup(() => json('activation_pending'));
    assert.deepEqual(await svc.retryActivation('s', 'p', 't'), { paymentId: 'p', fulfillmentStatus: 'activation_pending' });
  } finally {
    restore();
  }
});
