import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateInvitationDto } from './create-invitation.dto';

test('invitation DTO accepts a supported role and valid email', async () => {
  const dto = plainToInstance(CreateInvitationDto, {
    email: 'seller@example.com',
    role: 'seller',
  });
  assert.deepEqual(await validate(dto), []);
});

test('invitation DTO rejects owner role escalation', async () => {
  const dto = plainToInstance(CreateInvitationDto, {
    email: 'person@example.com',
    role: 'owner',
  });
  assert.ok((await validate(dto)).length > 0);
});

test('invitation DTO rejects malformed email addresses', async () => {
  const dto = plainToInstance(CreateInvitationDto, {
    email: 'not-an-email',
    role: 'viewer',
  });
  assert.ok((await validate(dto)).length > 0);
});
