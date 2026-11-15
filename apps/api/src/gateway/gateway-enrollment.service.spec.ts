import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GatewayEnrollmentService } from './gateway-enrollment.service';

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

test('redeem exchanges a one-time token for a distinct permanent Gateway credential', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co/';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key';

  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify([{ router_id: 'router-uuid', site_id: 'site-uuid' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const enrollmentToken = 'a'.repeat(64);
    const result = await new GatewayEnrollmentService().redeem(enrollmentToken);

    assert.equal(requestUrl, 'https://example.supabase.co/rest/v1/rpc/redeem_gateway_enrollment');
    assert.equal(requestInit?.method, 'POST');
    const headers = new Headers(requestInit?.headers);
    assert.equal(headers.get('apikey'), 'public-anon-key');
    assert.equal(headers.get('authorization'), 'Bearer public-anon-key');

    const body = JSON.parse(String(requestInit?.body)) as Record<string, string>;
    assert.equal(body.p_enrollment_token_hash, createHash('sha256').update(enrollmentToken).digest('hex'));
    assert.match(body.p_gateway_token_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(body).includes(enrollmentToken), false);

    assert.equal(result.routerId, 'router-uuid');
    assert.equal(result.siteId, 'site-uuid');
    assert.match(result.gatewayToken, /^[a-f0-9]{64}$/);
    assert.notEqual(result.gatewayToken, enrollmentToken);
    assert.equal(
      createHash('sha256').update(result.gatewayToken).digest('hex'),
      body.p_gateway_token_hash,
    );
  } finally {
    restoreEnvironment();
  }
});

test('redeem rejects invalid, expired, or already-used enrollment tokens', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key';
  globalThis.fetch = (async () => new Response('{"message":"invalid enrollment"}', { status: 401 })) as typeof fetch;

  try {
    await assert.rejects(
      new GatewayEnrollmentService().redeem('b'.repeat(64)),
      /Enrollment token is invalid, expired, or already used/,
    );
  } finally {
    restoreEnvironment();
  }
});

test('redeem rejects malformed Supabase responses without issuing a credential', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key';
  globalThis.fetch = (async () => new Response(JSON.stringify([{ router_id: 'router-uuid' }]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

  try {
    await assert.rejects(
      new GatewayEnrollmentService().redeem('c'.repeat(64)),
      /invalid Gateway identifiers/,
    );
  } finally {
    restoreEnvironment();
  }
});
