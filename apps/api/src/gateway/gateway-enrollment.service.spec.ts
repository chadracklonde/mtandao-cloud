import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

test('gateway enrollment credentials use independent 256-bit secrets and SHA-256 hashes', () => {
  const enrollmentToken = randomBytes(32).toString('hex');
  const gatewayToken = randomBytes(32).toString('hex');
  const enrollmentHash = createHash('sha256').update(enrollmentToken).digest('hex');
  const gatewayHash = createHash('sha256').update(gatewayToken).digest('hex');

  assert.equal(enrollmentToken.length, 64);
  assert.equal(gatewayToken.length, 64);
  assert.notEqual(enrollmentToken, gatewayToken);
  assert.match(enrollmentHash, /^[a-f0-9]{64}$/);
  assert.match(gatewayHash, /^[a-f0-9]{64}$/);
  assert.notEqual(enrollmentHash, enrollmentToken);
  assert.notEqual(gatewayHash, gatewayToken);
});
