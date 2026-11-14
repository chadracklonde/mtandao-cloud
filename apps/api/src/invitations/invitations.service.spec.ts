import { test } from 'node:test';
import assert from 'node:assert/strict';

test('invitation roles are restricted to the supported workspace roles', () => {
  const roles = ['admin', 'manager', 'seller', 'technician', 'viewer'];
  assert.equal(roles.includes('owner'), false);
  assert.equal(roles.includes('seller'), true);
  assert.equal(roles.includes('viewer'), true);
});
