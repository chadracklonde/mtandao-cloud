import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { CommerceService } from '../commerce/commerce.service';
import { ReportsService } from '../reports/reports.service';
import { RoutersService } from '../routers/routers.service';
import { ReadinessService } from './readiness.service';

const NOW = new Date('2026-11-22T10:00:00Z');

const tier = (name: string, overrides: Record<string, unknown> = {}) => ({
  tier: name,
  label: name,
  configured: true,
  active: true,
  stock_available: 100,
  ...overrides,
});
const fiveTiers = (overrides: Record<string, Record<string, unknown>> = {}) =>
  ['1h', '2h', '24h', '1w', '1m'].map(name => tier(name, overrides[name]));
const router = (overrides: Record<string, unknown> = {}) => ({
  name: 'R1',
  status: 'online',
  router_connection_status: 'online',
  ...overrides,
});

function build(parts: { pricing?: unknown; routers?: unknown; reconciliation?: unknown }) {
  const resolve = (value: unknown) => async () => {
    if (value instanceof Error) throw value;
    return value;
  };
  const commerce = {
    sitePricing: resolve(parts.pricing ?? { complete: true, tiers: fiveTiers() }),
  } as unknown as CommerceService;
  const routers = { list: resolve(parts.routers ?? [router()]) } as unknown as RoutersService;
  const reports = {
    reconciliation: resolve(parts.reconciliation ?? { items: [], summary: {}, truncated: false }),
  } as unknown as ReportsService;
  return new ReadinessService(commerce, routers, reports);
}

const statusOf = (result: { checks: Array<{ id: string; status: string }> }, id: string) =>
  result.checks.find(check => check.id === id)?.status;

test('a fully configured site is ready; the sandbox payment mode stays a warning', async () => {
  const result = await build({}).check('site', 'tok', NOW);
  assert.equal(result.ready, true);
  for (const id of ['pricing', 'stock', 'router', 'gateway', 'reconciliation']) assert.equal(statusOf(result, id), 'ok', id);
  assert.equal(statusOf(result, 'payments'), 'warn');
});

test('missing prices: none defined fails, some defined warns and names what is missing', async () => {
  const none = await build({ pricing: { complete: false, tiers: fiveTiers({ '1h': { configured: false, active: false }, '2h': { configured: false, active: false }, '24h': { configured: false, active: false }, '1w': { configured: false, active: false }, '1m': { configured: false, active: false } }) } }).check('s', 't', NOW);
  assert.equal(statusOf(none, 'pricing'), 'fail');
  assert.equal(none.ready, false);

  const some = await build({ pricing: { complete: false, tiers: fiveTiers({ '1m': { configured: false, active: false }, '1w': { active: false } }) } }).check('s', 't', NOW);
  assert.equal(statusOf(some, 'pricing'), 'warn');
  const detail = some.checks.find(c => c.id === 'pricing')!.detail;
  assert.match(detail, /1m/);
  assert.match(detail, /1w/);
  assert.equal(some.ready, true);
});

test('stock: an empty active plan blocks, low stock only warns, inactive plans are ignored', async () => {
  const empty = await build({ pricing: { complete: true, tiers: fiveTiers({ '24h': { stock_available: 0 } }) } }).check('s', 't', NOW);
  assert.equal(statusOf(empty, 'stock'), 'fail');
  assert.match(empty.checks.find(c => c.id === 'stock')!.detail, /24h/);
  assert.equal(empty.ready, false);

  const low = await build({ pricing: { complete: true, tiers: fiveTiers({ '1h': { stock_available: 5 } }) } }).check('s', 't', NOW);
  assert.equal(statusOf(low, 'stock'), 'warn');
  assert.match(low.checks.find(c => c.id === 'stock')!.detail, /1h \(5\)/);
  assert.equal(low.ready, true);

  const ignored = await build({ pricing: { complete: false, tiers: fiveTiers({ '1m': { active: false, stock_available: 0 } }) } }).check('s', 't', NOW);
  assert.equal(statusOf(ignored, 'stock'), 'ok');
});

test('gateway: no router fails, offline gateway fails, unreachable MikroTik warns', async () => {
  const none = await build({ routers: [] }).check('s', 't', NOW);
  assert.equal(statusOf(none, 'router'), 'fail');
  assert.equal(statusOf(none, 'gateway'), 'fail');

  const revoked = await build({ routers: [router({ status: 'revoked' })] }).check('s', 't', NOW);
  assert.equal(statusOf(revoked, 'router'), 'fail');

  const offline = await build({ routers: [router({ status: 'offline' })] }).check('s', 't', NOW);
  assert.equal(statusOf(offline, 'router'), 'ok');
  assert.equal(statusOf(offline, 'gateway'), 'fail');
  assert.match(offline.checks.find(c => c.id === 'gateway')!.detail, /en attente/);
  assert.equal(offline.ready, false);

  const unreachable = await build({ routers: [router({ router_connection_status: 'unavailable' })] }).check('s', 't', NOW);
  assert.equal(statusOf(unreachable, 'gateway'), 'warn');
  assert.equal(unreachable.ready, true);
});

test('reconciliation gaps warn without blocking sales', async () => {
  const gaps = await build({ reconciliation: { items: [{}, {}, {}], summary: {}, truncated: false } }).check('s', 't', NOW);
  assert.equal(statusOf(gaps, 'reconciliation'), 'warn');
  assert.match(gaps.checks.find(c => c.id === 'reconciliation')!.detail, /3 écart/);
  assert.equal(gaps.ready, true);
  const many = await build({ reconciliation: { items: new Array(500).fill({}), summary: {}, truncated: true } }).check('s', 't', NOW);
  assert.match(many.checks.find(c => c.id === 'reconciliation')!.detail, /500 écarts ou plus/);
});

test('a role without access gets "unknown" for that check instead of a failure, and never blocks readiness', async () => {
  const result = await build({
    pricing: new ForbiddenException('no'),
    routers: new ForbiddenException('no'),
    reconciliation: new ForbiddenException('no'),
  }).check('s', 't', NOW);
  for (const id of ['pricing', 'router', 'gateway', 'reconciliation']) assert.equal(statusOf(result, id), 'unknown', id);
  assert.match(result.checks.find(c => c.id === 'pricing')!.detail, /rôle/);
  assert.equal(result.ready, true);
});

test('a backend failure is reported as unknown, not as a crash or a false alarm', async () => {
  const result = await build({ routers: new Error('db down'), reconciliation: new Error('db down') }).check('s', 't', NOW);
  assert.equal(statusOf(result, 'router'), 'unknown');
  assert.match(result.checks.find(c => c.id === 'router')!.detail, /momentanément/);
  assert.equal(statusOf(result, 'pricing'), 'ok');
});

test('the reconciliation window is the last seven days', async () => {
  let seen: { from?: string; to?: string } = {};
  const svc = new ReadinessService(
    { sitePricing: async () => ({ complete: true, tiers: fiveTiers() }) } as unknown as CommerceService,
    { list: async () => [router()] } as unknown as RoutersService,
    { reconciliation: async (_s: string, _t: string, options: { from?: string; to?: string }) => { seen = options; return { items: [], summary: {}, truncated: false }; } } as unknown as ReportsService,
  );
  await svc.check('s', 't', NOW);
  assert.equal(seen.to, '2026-11-22T10:00:00.000Z');
  assert.equal(seen.from, '2026-11-15T10:00:00.000Z');
});
