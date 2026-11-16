import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayNameError, copyCapability } from '../src/validation.ts';
test('name limit counts Unicode code points and rejects invalid names', () => {
  assert.equal(displayNameError('😀'.repeat(100)), undefined);
  assert.match(displayNameError('a'.repeat(101))!, /100/);
  assert.match(displayNameError('😀'.repeat(101))!, /100/);
  assert.ok(displayNameError('  ')); assert.ok(displayNameError('A\u0000B'));
});
test('clipboard denial and missing API produce safe actionable feedback without capability leakage', async () => {
  const secret = 'synthetic-capability';
  assert.equal(await copyCapability(secret, async value => { assert.equal(value, secret); }), 'Copied to clipboard.');
  for (const write of [() => { throw Error(secret); }, async () => { throw Error(secret); }]) {
    const message = await copyCapability(secret, write); assert.match(message, /copy it manually/); assert.ok(!message.includes(secret));
  }
});
