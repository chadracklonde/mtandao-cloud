import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { GatewayHeartbeatService } from './gateway-heartbeat.service';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalAnonKey = process.env.SUPABASE_ANON_KEY;

function restoreEnvironment() {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalAnonKey === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = originalAnonKey;
}

test('heartbeat hashes the permanent credential and records RouterOS state', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co/';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key';
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify([{
      router_id: 'router-uuid',
      site_id: 'site-uuid',
      status: 'online',
      last_seen_at: '2026-11-15T12:00:00Z',
      router_connection_status: 'unavailable',
      router_last_seen_at: null,
    }]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const token = randomBytes(32).toString('hex');
    const result = await new GatewayHeartbeatService().heartbeat(token, 'unavailable');
    assert.equal(requestUrl, 'https://example.supabase.co/rest/v1/rpc/record_gateway_heartbeat');
    assert.equal(requestInit?.method, 'POST');
    const headers = new Headers(requestInit?.headers);
    assert.equal(headers.get('apikey'), 'public-anon-key');
    assert.equal(headers.get('authorization'), 'Bearer public-anon-key');
    const body = JSON.parse(String(requestInit?.body)) as Record<string, string>;
    assert.equal(body.p_gateway_token_hash, createHash('sha256').update(token).digest('hex'));
    assert.equal(body.p_router_connection_status, 'unavailable');
    assert.equal(JSON.stringify(body).includes(token), false);
    assert.deepEqual(result, {
      routerId: 'router-uuid',
      siteId: 'site-uuid',
      status: 'online',
      lastSeenAt: '2026-11-15T12:00:00Z',
      routerConnectionStatus: 'unavailable',
      routerLastSeenAt: null,
    });
  } finally {
    restoreEnvironment();
  }
});

test('heartbeat rejects revoked or suspended Gateway credentials', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key';
  globalThis.fetch = (async () => new Response('{"message":"invalid"}', { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(
      new GatewayHeartbeatService().heartbeat('a'.repeat(64)),
      /Gateway credential is invalid, revoked, or suspended/,
    );
  } finally {
    restoreEnvironment();
  }
});

test('heartbeat reports Supabase transport failures as unavailable', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key';
  globalThis.fetch = (async () => { throw new Error('network detail'); }) as typeof fetch;
  try {
    await assert.rejects(
      new GatewayHeartbeatService().heartbeat('a'.repeat(64)),
      /Supabase is unavailable/,
    );
  } finally {
    restoreEnvironment();
  }
});

test('heartbeat rejects malformed JSON and malformed result rows', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key';
  try {
    globalThis.fetch = (async () => new Response('not-json', { status: 200 })) as typeof fetch;
    await assert.rejects(
      new GatewayHeartbeatService().heartbeat('a'.repeat(64)),
      /invalid heartbeat response/,
    );
    globalThis.fetch = (async () => new Response(JSON.stringify([{ router_id: 'router-uuid' }]), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await assert.rejects(
      new GatewayHeartbeatService().heartbeat('a'.repeat(64)),
      /invalid heartbeat data/,
    );
  } finally {
    restoreEnvironment();
  }
});

test('Gateway bearer format rejects malformed and non-hex credentials', () => {
  const valid = 'a'.repeat(64);
  assert.match(`Bearer ${valid}`, /^Bearer ([a-f0-9]{64})$/);
  assert.doesNotMatch('Bearer short', /^Bearer ([a-f0-9]{64})$/);
  assert.doesNotMatch(`Bearer ${'g'.repeat(64)}`, /^Bearer ([a-f0-9]{64})$/);
});
