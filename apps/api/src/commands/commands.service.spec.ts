import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CommandsService, ticketComment } from './commands.service';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_ANON_KEY;

function setup(handler: (url: URL, init?: RequestInit) => Response) {
  process.env.SUPABASE_URL = 'https://example.supabase.co/';
  process.env.SUPABASE_ANON_KEY = 'anon-key';
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) =>
    handler(new URL(String(input)), init)) as typeof fetch;
}
function restore() {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = originalKey;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('create sends the typed command with the user token and defaults', async () => {
  let url: URL | undefined;
  let body: Record<string, unknown> = {};
  let auth = '';
  setup((u, init) => {
    url = u;
    body = JSON.parse(String(init?.body));
    auth = new Headers(init?.headers).get('authorization') ?? '';
    return json('cmd-1');
  });
  try {
    const result = await new CommandsService().create('site', 'router', { operation: 'health.check' }, 'user-token');
    assert.deepEqual(result, { commandId: 'cmd-1' });
    assert.equal(url?.pathname, '/rest/v1/rpc/create_gateway_command');
    assert.equal(auth, 'Bearer user-token');
    assert.deepEqual(body, {
      p_site_id: 'site', p_router_id: 'router', p_operation: 'health.check',
      p_payload: {}, p_ttl_seconds: 300, p_idempotency_key: null,
    });
  } finally {
    restore();
  }
});

test('create maps database errors to HTTP exceptions', async () => {
  const svc = new CommandsService();
  const dto = { operation: 'health.check' as const };
  try {
    setup(() => json({ code: '42501' }, 403));
    await assert.rejects(() => svc.create('s', 'r', dto, 't'), /Insufficient permission/);
    setup(() => json({ code: 'P0002' }, 404));
    await assert.rejects(() => svc.create('s', 'r', dto, 't'), /not found/);
    setup(() => json({ code: '23505' }, 409));
    await assert.rejects(() => svc.create('s', 'r', dto, 't'), /Idempotency key/);
    setup(() => json({ code: '53400' }, 400));
    await assert.rejects(() => svc.create('s', 'r', dto, 't'), /Too many open commands/);
    setup(() => json({ code: '22023' }, 400));
    await assert.rejects(() => svc.create('s', 'r', dto, 't'), /Invalid command/);
    setup(() => json({ code: 'XX000' }, 500));
    await assert.rejects(() => svc.create('s', 'r', dto, 't'), /Command operation failed/);
  } finally {
    restore();
  }
});

test('claim sends only the SHA-256 hash with the anon key and returns the batch', async () => {
  const token = 'a'.repeat(64);
  let body: Record<string, unknown> = {};
  let auth = '';
  setup((_u, init) => {
    body = JSON.parse(String(init?.body));
    auth = new Headers(init?.headers).get('authorization') ?? '';
    return json([{ command_id: 'c1', operation: 'health.check', payload: {} }]);
  });
  try {
    const { commands } = await new CommandsService().claim(token, 5);
    assert.equal(commands.length, 1);
    assert.equal(body.p_gateway_token_hash, createHash('sha256').update(token).digest('hex'));
    assert.equal(body.p_limit, 5);
    assert.equal(JSON.stringify(body).includes(token), false);
    assert.equal(auth, 'Bearer anon-key');
  } finally {
    restore();
  }
});

test('gateway endpoints reject revoked credentials and map state conflicts', async () => {
  const svc = new CommandsService();
  const token = 'b'.repeat(64);
  try {
    setup(() => json({ code: '28000' }, 403));
    await assert.rejects(() => svc.claim(token), /invalid, revoked, or suspended/);
    setup(() => json({ code: '42501' }, 403));
    await assert.rejects(() => svc.claim(token), /invalid, revoked, or suspended/);
    setup(() => json({ code: '22023' }, 400));
    await assert.rejects(() => svc.report(token, 'c', true, undefined, undefined), /not awaiting a result/);
    setup(() => json({ code: 'P0002' }, 404));
    await assert.rejects(() => svc.report(token, 'c', true, undefined, undefined), /not found/);
  } finally {
    restore();
  }
});

test('report forwards the outcome and validates the status', async () => {
  let body: Record<string, unknown> = {};
  setup((_u, init) => {
    body = JSON.parse(String(init?.body));
    return json('failed');
  });
  try {
    const out = await new CommandsService().report('c'.repeat(64), 'cmd', false, { a: 1 }, 'boom');
    assert.deepEqual(out, { commandId: 'cmd', status: 'failed' });
    assert.equal(body.p_success, false);
    assert.deepEqual(body.p_result, { a: 1 });
    assert.equal(body.p_error, 'boom');
    setup(() => json('delivered'));
    await assert.rejects(() => new CommandsService().report('c'.repeat(64), 'cmd', true, undefined, undefined), /invalid result status/);
  } finally {
    restore();
  }
});

test('list reports an overdue pending command as expired and filters by status', async () => {
  const past = new Date(Date.now() - 60000).toISOString();
  const future = new Date(Date.now() + 60000).toISOString();
  let url: URL | undefined;
  setup(u => {
    url = u;
    return json([
      { id: '1', status: 'pending', expires_at: past },
      { id: '2', status: 'pending', expires_at: future },
      { id: '3', status: 'expired', expires_at: past },
    ]);
  });
  try {
    const svc = new CommandsService();
    const expired = await svc.list('site', 't', { status: 'expired' });
    assert.deepEqual(expired.map(r => r.id), ['1', '3']);
    assert.equal(url?.searchParams.get('status'), 'in.(pending,expired)');
    const pending = await svc.list('site', 't', { status: 'pending', routerId: 'router' });
    assert.deepEqual(pending.map(r => r.id), ['2']);
    assert.equal(url?.searchParams.get('router_id'), 'eq.router');
    await assert.rejects(() => svc.list('site', 't', { status: 'bogus' }), /status is invalid/);
  } finally {
    restore();
  }
});

function voucherFetch(plan: Record<string, unknown> | null, sent: { payload?: Record<string, unknown>; key?: string }) {
  setup((url, init) => {
    if (url.pathname === '/rest/v1/plans') return json(plan ? [plan] : []);
    if (url.pathname === '/rest/v1/sites') return json([{ timezone: 'Africa/Lubumbashi' }]);
    const body = JSON.parse(String(init?.body));
    sent.payload = body.p_payload;
    sent.key = body.p_idempotency_key;
    return json('cmd-v');
  });
}

test('a Cloud ticket takes its usage time limit, data limit and profile from the plan', async () => {
  const sent: { payload?: Record<string, unknown>; key?: string } = {};
  voucherFetch({ duration_minutes: 1440, hotspot_profile: '24h', data_limit_mb: 2048 }, sent);
  try {
    const result = await new CommandsService().createVoucher('s', 'r', { code: 'AB12', planId: 'plan' }, 't');
    assert.equal(result.commandId, 'cmd-v');
    assert.equal(result.usageLimitMinutes, 1440);
    assert.equal(result.dataLimitMb, 2048);
    assert.deepEqual(sent.payload, {
      code: 'AB12', comment: result.comment, duration_minutes: 1440, data_limit_mb: 2048, profile: '24h',
    });
    assert.match(result.comment, /^vc-\d{6}-\d{4} cloud$/);
    assert.equal(sent.key, 'voucher-r-AB12');
  } finally {
    restore();
  }
});

test('an explicit usage limit overrides the plan, and unlimited is only accepted when explicit', async () => {
  const sent: { payload?: Record<string, unknown>; key?: string } = {};
  voucherFetch({ duration_minutes: 1440, hotspot_profile: null, data_limit_mb: null }, sent);
  try {
    const svc = new CommandsService();
    const overridden = await svc.createVoucher('s', 'r', { code: 'A', planId: 'p', usageLimitMinutes: 90, dataLimitMb: 300 }, 't');
    assert.equal(overridden.usageLimitMinutes, 90);
    assert.equal(sent.payload?.duration_minutes, 90);
    assert.equal(sent.payload?.data_limit_mb, 300);
    assert.equal('profile' in (sent.payload ?? {}), false);

    const unlimited = await svc.createVoucher('s', 'r', { code: 'B', planId: 'p', unlimited: true }, 't');
    assert.equal(unlimited.usageLimitMinutes, null);
    assert.equal('duration_minutes' in (sent.payload ?? {}), false);

    await assert.rejects(() => svc.createVoucher('s', 'r', { code: 'C' }, 't'), /Choose the usage time limit/);
    await assert.rejects(
      () => svc.createVoucher('s', 'r', { code: 'D', unlimited: true, usageLimitMinutes: 5 }, 't'),
      /cannot be combined/,
    );
    const manual = await svc.createVoucher('s', 'r', { code: 'E', usageLimitMinutes: 60, profile: 'p1', note: 'Client Jean' }, 't');
    assert.equal(sent.payload?.profile, 'p1');
    assert.match(manual.comment, /^vc-\d{6}-\d{4} Client Jean$/);
  } finally {
    restore();
  }
});

test('a plan of another site is not found', async () => {
  voucherFetch(null, {});
  try {
    await assert.rejects(() => new CommandsService().createVoucher('s', 'r', { code: 'A', planId: 'p' }, 't'), /Plan not found/);
  } finally {
    restore();
  }
});

test('the ticket comment follows the site time zone and the Mikhmon format', () => {
  const at = new Date('2026-11-22T22:30:00Z'); // 00:30 on the 23rd in Africa/Lubumbashi (UTC+2)
  assert.equal(ticketComment(at, 'Africa/Lubumbashi', 'cloud'), 'vc-231126-0030 cloud');
  assert.equal(ticketComment(at, 'UTC', 'cloud'), 'vc-221126-2230 cloud');
  assert.equal(ticketComment(at, 'UTC', ''), 'vc-221126-2230');
  assert.equal(ticketComment(at, 'UTC', 'a;b"c  d'), 'vc-221126-2230 abc d');
  assert.equal(ticketComment(at, 'UTC', 'x'.repeat(50)).length, 'vc-221126-2230 '.length + 30);
});
