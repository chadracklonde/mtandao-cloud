import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HealthController } from './health.controller';

test('health controller returns a stable response', () => {
  const controller = new HealthController();
  assert.deepEqual(controller.check(), {
    status: 'ok',
    service: 'mtandao-cloud-api',
  });
});
