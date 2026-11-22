import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditService } from './audit.service';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalAnonKey = process.env.SUPABASE_ANON_KEY;

function restore() {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalAnonKey === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = originalAnonKey;
}

test('list queries the audit log with the user token, newest first and keyset pagination', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co/';
  process.env.SUPABASE_ANON_KEY = 'anon';
  let url = '';
  let init: RequestInit | undefined;
  globalThis.fetch = (async (input: URL | RequestInfo, i?: RequestInit) => {
    url = String(input);
    init = i;
    return new Response(JSON.stringify([{ id: 9, action: 'member.added' }]), { status: 200 });
  }) as typeof fetch;
  try {
    const rows = await new AuditService().list('site-1', 'user-token', 10, 42);
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/rest/v1/audit_log');
    assert.equal(parsed.searchParams.get('site_id'), 'eq.site-1');
    assert.equal(parsed.searchParams.get('order'), 'id.desc');
    assert.equal(parsed.searchParams.get('limit'), '10');
    assert.equal(parsed.searchParams.get('id'), 'lt.42');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer user-token');
    assert.equal(rows.length, 1);
  } finally {
    restore();
  }
});

test('list clamps the limit and does not add a cursor by default', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon';
  let url = '';
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    url = String(input);
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  try {
    await new AuditService().list('site-1', 't', 100000);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('limit'), '200');
    assert.equal(parsed.searchParams.get('id'), null);
  } finally {
    restore();
  }
});

test('list reports storage failures and invalid responses as bad gateway', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon';
  try {
    globalThis.fetch = (async () => new Response('{}', { status: 403 })) as typeof fetch;
    await assert.rejects(() => new AuditService().list('s', 't'), /Unable to read the audit log/);
    globalThis.fetch = (async () => new Response('{"x":1}', { status: 200 })) as typeof fetch;
    await assert.rejects(() => new AuditService().list('s', 't'), /invalid audit log/);
    globalThis.fetch = (async () => {
      throw new Error('network');
    }) as typeof fetch;
    await assert.rejects(() => new AuditService().list('s', 't'), /unavailable/);
  } finally {
    restore();
  }
});

test('list fails safely when Supabase is not configured', async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  try {
    await assert.rejects(() => new AuditService().list('s', 't'), /not configured/);
  } finally {
    restore();
  }
});
