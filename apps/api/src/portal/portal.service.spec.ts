import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PortalService } from './portal.service';
import { RateLimiter } from './rate-limiter';

const originalFetch = globalThis.fetch;
const saved = { ...process.env };

function setup(handler: (url: URL, init?: RequestInit) => Response) {
  process.env.SUPABASE_URL = 'https://example.supabase.co/';
  process.env.SUPABASE_ANON_KEY = 'anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) =>
    handler(new URL(String(input)), init)) as typeof fetch;
}
function restore() {
  globalThis.fetch = originalFetch;
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const created = {
  payment_id: 'p1', provider_ref: 'MTD-1', amount: 500, currency: 'CDF',
  status: 'pending', expires_at: '2026-11-22T10:30:00Z', access_expires_at: '2026-11-22T12:00:00Z',
};
const dto = { planId: 'plan', routerId: 'router', customerPhone: '+243970000001', idempotencyKey: 'visit-12345' };

test('creating a payment stores only the token hash and returns the token once', async () => {
  let body: Record<string, unknown> = {};
  let auth = '';
  setup((_u, init) => {
    body = JSON.parse(String(init?.body));
    auth = new Headers(init?.headers).get('authorization') ?? '';
    return json(created);
  });
  try {
    const result = await new PortalService().createPayment('site', dto);
    assert.match(result.accessToken, /^[a-f0-9]{64}$/);
    assert.equal(body.p_token_hash, createHash('sha256').update(result.accessToken).digest('hex'));
    assert.equal(JSON.stringify(body).includes(result.accessToken), false);
    assert.equal(auth, 'Bearer service-key');
    assert.equal(result.paymentId, 'p1');
    assert.equal(result.providerRef, 'MTD-1');
    assert.equal(body.p_customer_phone, '+243970000001');
  } finally {
    restore();
  }
});

test('every payment gets a different random token', async () => {
  setup(() => json(created));
  try {
    const tokens = new Set<string>();
    for (let i = 0; i < 20; i++) tokens.add((await new PortalService().createPayment('site', dto)).accessToken);
    assert.equal(tokens.size, 20);
  } finally {
    restore();
  }
});

test('status sends the hash of the presented token, never the token', async () => {
  let body: Record<string, unknown> = {};
  setup((url, init) => {
    assert.equal(url.pathname, '/rest/v1/rpc/portal_payment_status');
    body = JSON.parse(String(init?.body));
    return json({ status: 'paid', ticket: null });
  });
  try {
    const token = 'a'.repeat(64);
    await new PortalService().status('pay-1', token);
    assert.equal(body.p_payment_id, 'pay-1');
    assert.equal(body.p_token_hash, createHash('sha256').update(token).digest('hex'));
    assert.equal(JSON.stringify(body).includes(token), false);
  } finally {
    restore();
  }
});

test('database errors map to safe HTTP errors', async () => {
  try {
    const svc = new PortalService();
    setup(() => json({ code: 'P0002' }, 404));
    await assert.rejects(() => svc.status('p', 'a'.repeat(64)), /Not found/);
    setup(() => json({ code: '22023' }, 400));
    await assert.rejects(() => svc.createPayment('s', dto), /Invalid request/);
    setup(() => json({ code: '23505' }, 409));
    await assert.rejects(() => svc.createPayment('s', dto), /conflicts/);
    setup(() => json({ code: '53400' }, 400));
    await assert.rejects(
      () => svc.createPayment('s', dto),
      (error: { getStatus?: () => number }) => error.getStatus?.() === 429,
    );
    setup(() => json({ code: 'XX000', message: 'secret internal detail' }, 500));
    await assert.rejects(
      () => svc.catalog('s'),
      (error: Error) => /could not complete/.test(error.message) && !/secret/.test(error.message),
    );
    setup(() => json({ plans: 'nope' }));
    await assert.rejects(() => svc.catalog('s'), /invalid catalog/);
    setup(() => json({ nope: 1 }));
    await assert.rejects(() => svc.createPayment('s', dto), /invalid payment/);
  } finally {
    restore();
  }
});

test('the portal fails closed without the service role key', async () => {
  setup(() => json(created));
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    await assert.rejects(() => new PortalService().catalog('s'), /not configured/);
    await assert.rejects(() => new PortalService().createPayment('s', dto), /not configured/);
  } finally {
    restore();
  }
});

test('rate limiter allows the limit then blocks until the window ends', () => {
  const limiter = new RateLimiter();
  assert.equal(limiter.allow('ip', 3, 1000, 0), true);
  assert.equal(limiter.allow('ip', 3, 1000, 10), true);
  assert.equal(limiter.allow('ip', 3, 1000, 20), true);
  assert.equal(limiter.allow('ip', 3, 1000, 30), false);
  assert.equal(limiter.allow('other', 3, 1000, 30), true);
  assert.equal(limiter.allow('ip', 3, 1000, 1001), true);
});

test('rate limiter memory stays bounded', () => {
  const limiter = new RateLimiter(100);
  for (let i = 0; i < 1000; i++) limiter.allow(`k${i}`, 5, 60_000, i);
  assert.ok((limiter as unknown as { windows: Map<string, unknown> }).windows.size <= 100);
});
