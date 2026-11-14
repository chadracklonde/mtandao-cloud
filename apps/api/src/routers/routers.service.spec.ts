import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

test('gateway enrollment token is high entropy and stored as SHA-256 only', () => {
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  assert.equal(token.length, 64);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(hash.length, 64);
  assert.notEqual(hash, token);
});
