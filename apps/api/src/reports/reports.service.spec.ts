import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReportsService } from './reports.service';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_ANON_KEY;

function setup(handler: (url: URL, init?: RequestInit) => Response) {
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

test('sales report calls the RPC with the user token, normalized dates and grouping', async () => {
  let url: URL | undefined;
  let body: Record<string, unknown> = {};
  let auth = '';
  setup((u, init) => {
    url = u;
    body = JSON.parse(String(init?.body));
    auth = new Headers(init?.headers).get('authorization') ?? '';
    return json([{ period: '2026-11-10', currency: 'USD', sales_count: 2 }]);
  });
  try {
    const rows = await new ReportsService().sales('site-1', 'tok', {
      from: '2026-11-01',
      to: '2026-12-01T00:00:00Z',
      group: 'month',
    });
    assert.equal(url?.pathname, '/rest/v1/rpc/sales_report');
    assert.deepEqual(body, {
      p_site_id: 'site-1',
      p_from: '2026-11-01T00:00:00.000Z',
      p_to: '2026-12-01T00:00:00.000Z',
      p_group: 'month',
    });
    assert.equal(auth, 'Bearer tok');
    assert.equal(rows.length, 1);
  } finally {
    restore();
  }
});

test('sales report defaults to day grouping and open period', async () => {
  let body: Record<string, unknown> = {};
  setup((_u, init) => {
    body = JSON.parse(String(init?.body));
    return json([]);
  });
  try {
    await new ReportsService().sales('s', 't');
    assert.equal(body.p_group, 'day');
    assert.equal(body.p_from, null);
    assert.equal(body.p_to, null);
  } finally {
    restore();
  }
});

test('reports reject invalid input before calling the database', async () => {
  let called = false;
  setup(() => {
    called = true;
    return json([]);
  });
  try {
    const svc = new ReportsService();
    await assert.rejects(() => svc.sales('s', 't', { group: 'year' }), /group must be/);
    await assert.rejects(() => svc.sales('s', 't', { from: 'hier' }), /from must be/);
    await assert.rejects(() => svc.reconciliation('s', 't', { to: '2026-99-99' }), /to must be/);
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test('reconciliation summarizes discrepancies by kind and flags truncation', async () => {
  setup(() =>
    json([
      { kind: 'cash_entry_missing', reference_id: 'a', occurred_at: 'x', details: {} },
      { kind: 'cash_entry_missing', reference_id: 'b', occurred_at: 'x', details: {} },
      { kind: 'sync_conflict_open', reference_id: 'c', occurred_at: 'x', details: {} },
    ]),
  );
  try {
    const report = await new ReportsService().reconciliation('s', 't');
    assert.deepEqual(report.summary, { cash_entry_missing: 2, sync_conflict_open: 1 });
    assert.equal(report.items.length, 3);
    assert.equal(report.truncated, false);
  } finally {
    restore();
  }
  setup(() =>
    json(Array.from({ length: 500 }, (_, i) => ({ kind: 'k', reference_id: String(i), occurred_at: 'x', details: {} }))),
  );
  try {
    assert.equal((await new ReportsService().reconciliation('s', 't')).truncated, true);
  } finally {
    restore();
  }
});

test('database errors map to HTTP exceptions', async () => {
  try {
    const svc = new ReportsService();
    setup(() => json({ code: '42501' }, 403));
    await assert.rejects(() => svc.sales('s', 't'), /Insufficient permission/);
    setup(() => json({ code: '22023' }, 400));
    await assert.rejects(() => svc.reconciliation('s', 't'), /Invalid report period/);
    setup(() => json({ code: 'XX000' }, 500));
    await assert.rejects(() => svc.sales('s', 't'), /Unable to build the report/);
    setup(() => json({ not: 'array' }));
    await assert.rejects(() => svc.sales('s', 't'), /invalid report/);
    setup(() => {
      throw new Error('down');
    });
    await assert.rejects(() => svc.sales('s', 't'), /unavailable/);
  } finally {
    restore();
  }
});

test('conflicts default to open ones and are scoped to the site with the user token', async () => {
  let url: URL | undefined;
  let auth = '';
  setup((u, init) => {
    url = u;
    auth = new Headers(init?.headers).get('authorization') ?? '';
    return json([{ id: 'c1', conflict_type: 'sale_mismatch' }]);
  });
  try {
    const rows = await new ReportsService().conflicts('site-1', 'tok', undefined);
    assert.equal(url?.pathname, '/rest/v1/sync_conflicts');
    assert.equal(url?.searchParams.get('site_id'), 'eq.site-1');
    assert.equal(url?.searchParams.get('resolved_at'), 'is.null');
    assert.equal(auth, 'Bearer tok');
    assert.equal(rows.length, 1);
    await assert.rejects(() => new ReportsService().conflicts('site-1', 'tok', 'bogus'), /status must be/);
  } finally {
    restore();
  }
});

test('resolving a conflict maps database errors to HTTP errors', async () => {
  for (const [code, name] of [['42501', 'ForbiddenException'], ['P0002', 'NotFoundException'], ['23505', 'ConflictException'], ['22023', 'BadRequestException']] as const) {
    setup(() => json({ code }, 400));
    try {
      await assert.rejects(
        () => new ReportsService().resolveConflict('s', 'c', 'dismissed', undefined, 'tok'),
        (error: Error) => error.constructor.name === name,
      );
    } finally {
      restore();
    }
  }
  let body: Record<string, unknown> = {};
  setup((_u, init) => {
    body = JSON.parse(String(init?.body));
    return json({ id: 'c', resolved: true });
  });
  try {
    await new ReportsService().resolveConflict('s', 'c', 'keep_cloud', 'ok', 'tok');
    assert.deepEqual(body, { p_site_id: 's', p_conflict_id: 'c', p_resolution: 'keep_cloud', p_note: 'ok' });
  } finally {
    restore();
  }
});
