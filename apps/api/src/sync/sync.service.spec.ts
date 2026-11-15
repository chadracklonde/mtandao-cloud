import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncService } from './sync.service';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalAnonKey = process.env.SUPABASE_ANON_KEY;
const eventId = '11111111-1111-4111-8111-111111111111';
const siteId = '22222222-2222-4222-8222-222222222222';

function restore() {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalAnonKey === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = originalAnonKey;
}

function batch() {
  return {
    events: [{
      id: eventId,
      site_id: siteId,
      device_id: '33333333-3333-4333-8333-333333333333',
      event_type: 'ticket.created',
      schema_version: 1,
      occurred_at: '2026-11-15T08:00:00.000Z',
      payload: { ticketId: 'ticket-1' },
    }],
  };
}

test('ingest sends the authenticated batch and returns server acknowledgements', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co/';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key';
  let url = '';
  let init: RequestInit | undefined;
  globalThis.fetch = (async (input: URL | RequestInfo, options?: RequestInit) => {
    url = String(input);
    init = options;
    return new Response(JSON.stringify({
      site_id: siteId,
      received_count: 1,
      inserted_count: 1,
      acknowledged_event_ids: [eventId],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const result = await new SyncService().ingest(siteId, batch(), 'user-jwt');
    assert.equal(url, 'https://example.supabase.co/rest/v1/rpc/ingest_sync_events');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('apikey'), 'public-anon-key');
    assert.equal(headers.get('authorization'), 'Bearer user-jwt');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      p_site_id: siteId,
      p_events: batch().events,
    });
    assert.deepEqual(result.acknowledged_event_ids, [eventId]);
  } finally {
    restore();
  }
});

test('ingest refuses events belonging to another site before making a request', async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}');
  }) as typeof fetch;
  try {
    await assert.rejects(
      new SyncService().ingest(siteId, {
        events: [{ ...batch().events[0], site_id: '44444444-4444-4444-8444-444444444444' }],
      }, 'user-jwt'),
      /Every event must belong to the requested site/,
    );
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test('ingest rejects incomplete server acknowledgements', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key';
  globalThis.fetch = (async () => new Response(JSON.stringify({
    site_id: siteId,
    received_count: 1,
    inserted_count: 1,
    acknowledged_event_ids: [],
  }), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(
      new SyncService().ingest(siteId, batch(), 'user-jwt'),
      /Sync acknowledgement is incomplete/,
    );
  } finally {
    restore();
  }
});

test('ingest reports storage failures without acknowledging events', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key';
  globalThis.fetch = (async () => new Response('failure', { status: 503 })) as typeof fetch;
  try {
    await assert.rejects(
      new SyncService().ingest(siteId, batch(), 'user-jwt'),
      /Unable to persist synchronization events/,
    );
  } finally {
    restore();
  }
});
