import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommerceService } from './commerce.service';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_ANON_KEY;

function setup(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  process.env.SUPABASE_URL = 'https://example.supabase.co/';
  process.env.SUPABASE_ANON_KEY = 'anon';
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

test('list sales is site-scoped, newest first, uses the user token and returns a cursor', async () => {
  let seen: URL | undefined;
  let auth = '';
  setup((url, init) => {
    seen = url;
    auth = new Headers(init?.headers).get('authorization') ?? '';
    return json([
      { id: '00000000-0000-0000-0000-000000000002', sold_at: '2026-11-16T10:00:00+00:00' },
      { id: '00000000-0000-0000-0000-000000000001', sold_at: '2026-11-16T09:00:00+00:00' },
    ]);
  });
  try {
    const page = await new CommerceService().list('sales', 'site-1', 'tok', { limit: 2 });
    assert.equal(seen?.pathname, '/rest/v1/sales');
    assert.equal(seen?.searchParams.get('site_id'), 'eq.site-1');
    assert.equal(seen?.searchParams.get('order'), 'sold_at.desc,id.desc');
    assert.equal(seen?.searchParams.get('limit'), '2');
    assert.equal(auth, 'Bearer tok');
    assert.equal(page.items.length, 2);
    assert.equal(page.next_cursor, '2026-11-16T09:00:00+00:00|00000000-0000-0000-0000-000000000001');
  } finally {
    restore();
  }
});

test('list returns no cursor on a short page', async () => {
  setup(() => json([{ id: '00000000-0000-0000-0000-000000000001', sold_at: '2026-11-16T09:00:00Z' }]));
  try {
    const page = await new CommerceService().list('sales', 's', 't', { limit: 5 });
    assert.equal(page.next_cursor, null);
  } finally {
    restore();
  }
});

test('list applies date range and a composite keyset cursor', async () => {
  let seen: URL | undefined;
  setup((url) => {
    seen = url;
    return json([]);
  });
  try {
    await new CommerceService().list('cash-entries', 's', 't', {
      from: '2026-11-01',
      to: '2026-12-01T00:00:00Z',
      cursor: '2026-11-16T09:00:00+00:00|00000000-0000-0000-0000-000000000001',
    });
    assert.equal(seen?.pathname, '/rest/v1/cash_entries');
    assert.deepEqual(seen?.searchParams.getAll('occurred_at'), [
      'gte.2026-11-01T00:00:00.000Z',
      'lt.2026-12-01T00:00:00.000Z',
    ]);
    assert.equal(
      seen?.searchParams.get('or'),
      '(occurred_at.lt.2026-11-16T09:00:00+00:00,and(occurred_at.eq.2026-11-16T09:00:00+00:00,id.lt.00000000-0000-0000-0000-000000000001))',
    );
  } finally {
    restore();
  }
});

test('list rejects malformed cursors, dates and injection attempts', async () => {
  setup(() => json([]));
  try {
    const svc = new CommerceService();
    await assert.rejects(() => svc.list('sales', 's', 't', { cursor: 'x),id.gt.0' }), /cursor is invalid/);
    await assert.rejects(() => svc.list('sales', 's', 't', { from: 'yesterday' }), /from must be/);
    await assert.rejects(() => svc.list('tickets', 's', 't', { to: '2026-13-45' }), /to must be/);
  } finally {
    restore();
  }
});

test('list maps storage failures to bad gateway and unavailable', async () => {
  try {
    setup(() => json({}, 500));
    await assert.rejects(() => new CommerceService().list('tickets', 's', 't'), /Unable to list tickets/);
    setup(() => json({ not: 'array' }));
    await assert.rejects(() => new CommerceService().list('tickets', 's', 't'), /invalid tickets list/);
    setup(() => {
      throw new Error('down');
    });
    await assert.rejects(() => new CommerceService().list('tickets', 's', 't'), /unavailable/);
  } finally {
    restore();
  }
});

test('createPlan sends the RPC payload and maps database errors', async () => {
  let body: Record<string, unknown> = {};
  setup((url, init) => {
    assert.equal(url.pathname, '/rest/v1/rpc/create_plan');
    body = JSON.parse(String(init?.body));
    return json('plan-id');
  });
  try {
    const svc = new CommerceService();
    const result = await svc.createPlan(
      'site',
      { name: ' 1 heure ', price: 500, currency: 'CDF', durationMinutes: 60 },
      'tok',
    );
    assert.deepEqual(result, { planId: 'plan-id' });
    assert.equal(body.p_name, '1 heure');
    assert.equal(body.p_data_limit_mb, null);

    setup(() => json({ code: '42501' }, 403));
    await assert.rejects(
      () => svc.createPlan('site', { name: 'a', price: 1, currency: 'USD', durationMinutes: 1 }, 't'),
      /Insufficient permission/,
    );
    setup(() => json({ code: '23505' }, 409));
    await assert.rejects(
      () => svc.createPlan('site', { name: 'a', price: 1, currency: 'USD', durationMinutes: 1 }, 't'),
      /already exists/,
    );
  } finally {
    restore();
  }
});

test('importTicketStock validates the RPC result', async () => {
  setup(() => json({ submitted: 3, inserted: 2, skipped: 1 }));
  try {
    const svc = new CommerceService();
    assert.deepEqual(await svc.importTicketStock('s', 'p', ['a', 'b', 'c'], 't'), {
      submitted: 3,
      inserted: 2,
      skipped: 1,
    });
    setup(() => json({ inserted: 'many' }));
    await assert.rejects(() => svc.importTicketStock('s', 'p', ['a'], 't'), /invalid import result/);
    setup(() => json({ code: 'P0002' }, 404));
    await assert.rejects(() => svc.importTicketStock('s', 'p', ['a'], 't'), /Plan not found/);
  } finally {
    restore();
  }
});

test('setPlanActive and stockSummary check their results', async () => {
  try {
    const svc = new CommerceService();
    setup(() => json('plan-1'));
    assert.deepEqual(await svc.setPlanActive('s', 'plan-1', false, 't'), { planId: 'plan-1', active: false });
    setup(() => json('other'));
    await assert.rejects(() => svc.setPlanActive('s', 'plan-1', true, 't'), /invalid plan result/);
    setup(() => json([{ plan_id: 'p', available: 3 }]));
    assert.equal((await svc.stockSummary('s', 't')).length, 1);
    setup(() => json({}));
    await assert.rejects(() => svc.stockSummary('s', 't'), /invalid stock summary/);
  } finally {
    restore();
  }
});
