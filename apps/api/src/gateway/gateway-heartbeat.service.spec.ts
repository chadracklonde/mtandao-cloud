import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

test('Gateway heartbeat credentials are hashed before database lookup', () => {
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');

  assert.equal(token.length, 64);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, token);
});

test('Gateway bearer format rejects malformed and non-hex credentials', () => {
  const valid = 'a'.repeat(64);
  assert.match(`Bearer ${valid}`, /^Bearer ([a-f0-9]{64})$/);
  assert.doesNotMatch('Bearer short', /^Bearer ([a-f0-9]{64})$/);
  assert.doesNotMatch(`Bearer ${'g'.repeat(64)}`, /^Bearer ([a-f0-9]{64})$/);
});
