import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RoutersService } from './routers.service';

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

test('register sends only the SHA-256 hash and returns the one-time enrollment token', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co/';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key';

  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify('router-uuid'), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await new RoutersService().register(
      'site-uuid',
      { name: 'Main router', routerIdentity: 'MikroTik-Kindu', gatewayKind: 'linux' },
      'user-access-token',
    );

    assert.equal(requestUrl, 'https://example.supabase.co/rest/v1/rpc/register_router');
    assert.equal(requestInit?.method, 'POST');
    const headers = new Headers(requestInit?.headers);
    assert.equal(headers.get('apikey'), 'public-anon-key');
    assert.equal(headers.get('authorization'), 'Bearer user-access-token');

    const body = JSON.parse(String(requestInit?.body)) as Record<string, string>;
    assert.equal(body.p_site_id, 'site-uuid');
    assert.equal(body.p_name, 'Main router');
    assert.equal(body.p_router_identity, 'MikroTik-Kindu');
    assert.equal(body.p_gateway_kind, 'linux');
    assert.match(body.p_enrollment_token_hash, /^[a-f0-9]{64}$/);

    assert.equal(result.routerId, 'router-uuid');
    assert.match(result.enrollmentToken, /^[a-f0-9]{64}$/);
    assert.equal(
      createHash('sha256').update(result.enrollmentToken).digest('hex'),
      body.p_enrollment_token_hash,
    );
    assert.equal(result.expiresInSeconds, 900);
    assert.equal(JSON.stringify(body).includes(result.enrollmentToken), false);
  } finally {
    restoreEnvironment();
  }
});

test('register fails safely when Supabase configuration is missing', async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;

  try {
    await assert.rejects(
      new RoutersService().register(
        'site-uuid',
        { name: 'Main router', routerIdentity: 'MikroTik-Kindu', gatewayKind: 'linux' },
        'user-access-token',
      ),
      /Supabase is not configured/,
    );
  } finally {
    restoreEnvironment();
  }
});

test('register rejects a non-UUID response from Supabase', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key';
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'router-uuid' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

  try {
    await assert.rejects(
      new RoutersService().register(
        'site-uuid',
        { name: 'Main router', routerIdentity: 'MikroTik-Kindu', gatewayKind: 'linux' },
        'user-access-token',
      ),
      /invalid router identifier/,
    );
  } finally {
    restoreEnvironment();
  }
});
