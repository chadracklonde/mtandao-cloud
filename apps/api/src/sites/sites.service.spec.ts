import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBearerToken } from '../auth/auth.guard';

test('bearer token parser accepts a valid Authorization header', () => {
  assert.equal(readBearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
});

test('bearer token parser is case-insensitive and trims whitespace', () => {
  assert.equal(readBearerToken('  bearer token-value  '), 'token-value');
});

test('bearer token parser rejects missing and malformed headers', () => {
  assert.equal(readBearerToken(undefined), null);
  assert.equal(readBearerToken('Basic abc'), null);
  assert.equal(readBearerToken('Bearer two tokens'), null);
});
