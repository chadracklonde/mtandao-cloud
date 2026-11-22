import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CommandsService } from './commands.service';

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
