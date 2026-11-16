import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';

const valid = { CONTROL_DIRECTORY: '/private/tmp/credspan-unit-control', CREDSPAN_SANDBOX: '1', PUBLIC_URL: 'http://localhost:3000', MANAGEMENT_API_KEY: 'x'.repeat(32), ASKAR_STORE_ID: 'credspan_test', ASKAR_STORE_KEY: 'y'.repeat(32), POSTGRES_HOST: '127.0.0.1:5432', POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'synthetic-test-only' };
test('startup requires explicit local sandbox, non-placeholder secrets and bounded ports', () => {
  assert.equal(readConfig(valid).publicUrl, 'http://localhost:3000');
  for (const overrides of [{ CREDSPAN_SANDBOX: '0' }, { PUBLIC_URL: 'https://example.com' }, { PUBLIC_URL: 'http://localhost:3000/path' }, { MANAGEMENT_API_KEY: 'short' }, { ASKAR_STORE_KEY: '<placeholder>' }, { ASKAR_STORE_ID: '../store' }, { PORT: '65536' }, { POSTGRES_PASSWORD: '' }, { TRUSTED_ISSUER_DIDS: '{}' }, { TRUSTED_ISSUER_DIDS: '[null]' }, { TRUSTED_ISSUER_DIDS: '["did:web:example.com"]' }]) assert.throws(() => readConfig({ ...valid, ...overrides }));
});

test('shared verification boundary never delegates when durable storage fails', async () => {
  const { installVerificationBoundary } = await import('../src/runtime.js');
  let delegated = 0;
  const service = { async updateState() {}, async verifyAuthorizationResponse() { delegated++; } };
  installVerificationBoundary(service as unknown as import('@credo-ts/openid4vc').OpenId4VpVerifierService);
  const context = { dependencyManager: { resolve: () => ({ save: async () => { throw Error('storage unavailable'); } }) } };
  await assert.rejects((service.verifyAuthorizationResponse as Function)(context, { verificationSession: { id: 'stored-id', verifierId: 'stored-verifier', openId4VpVersion: 'v1' } }), /Unable to reserve/);
  assert.equal(delegated, 0);
});

test('native Ed25519 signing verifies and rejects tampered messages', async () => {
  const { Key, KeyAlgorithm } = await import('@openwallet-foundation/askar-nodejs');
  const key = Key.generate(KeyAlgorithm.Ed25519);
  try {
    const message = Buffer.from('Credspan synthetic native check');
    const signature = key.signMessage({ message });
    assert.ok(key.verifySignature({ message, signature }));
    assert.ok(!key.verifySignature({ message: Buffer.from('tampered'), signature }));
  } finally { key.handle.free(); }
});

test('membership inputs accept only bounded profile fields, never caller identifiers or expiry', async () => {
  const { validateMembership } = await import('../src/issuance.js');
  assert.deepEqual(validateMembership({ name: ' Synthetic ', memberId: 'member-1' }), { name: 'Synthetic', memberId: 'member-1' });
  for (const value of [null, [], {}, { name: '', memberId: 'a' }, { name: 'x'.repeat(101), memberId: 'a' }, { name: 'Synthetic\n', memberId: 'a' }, { name: 'Synthetic', memberId: '../a' }, { name: 'Synthetic', memberId: 'a', exp: 1 }, { name: 'Synthetic', memberId: 'a', credentialId: 'forged' }]) assert.throws(() => validateMembership(value));
});

test('issuer claims fail closed before token state changes or credential signing', async () => {
  const { installIssuanceBoundaries } = await import('../src/issuance.js');
  const { OpenId4VcIssuanceSessionState } = await import('@credo-ts/openid4vc');
  let delegated = 0;
  const service = { async updateState() { delegated++; }, async createCredentialResponse() { delegated++; } };
  installIssuanceBoundaries(service as unknown as import('@credo-ts/openid4vc').OpenId4VcIssuerService, 'active');
  const context = { dependencyManager: { resolve: () => ({ save: async () => { throw Error('storage unavailable'); } }) } };
  const session = { id: 'stored', issuerId: 'active', openId4VciVersion: 'v1', issuanceMetadata: { credentialId: 'urn:uuid:00000000-0000-4000-8000-000000000000', expiresAt: 2000000000, membership: { name: 'Synthetic', memberId: 'member' } } };
  await assert.rejects((service.updateState as Function)(context, session, OpenId4VcIssuanceSessionState.AccessTokenRequested), /Unable to reserve/);
  await assert.rejects((service.createCredentialResponse as Function)(context, { issuanceSession: session }), /Unable to reserve/);
  assert.equal(delegated, 0);
});

test('status policy rejects stale, future, missing-expiry, malformed and impersonating tokens', async () => {
  const { validateStatusToken } = await import('../src/verification.js');
  const uri = 'http://localhost/status-lists/membership', did = 'did:key:zSynthetic', kid = `${did}#zSynthetic`, now = 2_000_000_000;
  const payload = { iss: did, sub: uri, iat: now, exp: now + 30, ttl: 30, status_list: { bits: 1, lst: 'synthetic' } };
  const token = (body: unknown, header: unknown = { alg: 'EdDSA', typ: 'statuslist+jwt', kid }) => [header, body].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.synthetic';
  validateStatusToken(token(payload), uri, did, kid, now);
  validateStatusToken(token(payload, { alg: 'EdDSA', typ: 'statuslist+jwt', kid: '#zSynthetic' }), uri, did, kid, now);
  for (const patch of [{ iat: now - 31 }, { iat: now + 1 }, { exp: now }, { exp: now + 31 }, { exp: undefined }, { ttl: 300 }, { sub: 'http://unapproved' }, { iss: 'did:key:another' }, { status_list: { bits: 2 } }, { iat: null }]) assert.throws(() => validateStatusToken(token({ ...payload, ...patch }), uri, did, kid, now));
  assert.throws(() => validateStatusToken(token(payload, { alg: 'EdDSA', typ: 'statuslist+jwt', kid: 'did:key:attacker#key' }), uri, did, kid, now));
});

test('status allocation retries only native duplicates and never hides storage errors', async () => {
  const { createVerificationPolicy } = await import('../src/verification.js');
  const { RecordDuplicateError } = await import('@credo-ts/core');
  let attempts = 0;
  const ids: string[] = [];
  const storage = { async save(_context: unknown, record: { id: string }) { ids.push(record.id); if (++attempts === 1) throw new RecordDuplicateError('occupied', { recordType: 'GenericRecord' }); } };
  const agent = { context: {}, dependencyManager: { resolve: () => storage } } as unknown as import('@credo-ts/core').Agent;
  const policy = createVerificationPolicy(agent, 'http://localhost', 'did:key:synthetic', 'did:key:synthetic#key', undefined);
  await policy.allocate('synthetic'); assert.equal(attempts, 2); assert.notEqual(ids[0], ids[1]);
  storage.save = async () => { throw Error('storage unavailable'); };
  await assert.rejects(policy.allocate('synthetic'), /storage unavailable/);
});

test('private control/secret files enforce modes and fresh atomic generation fences', async () => {
  const { mkdtemp, writeFile, chmod, rename, rm, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { createFence, readControl, acquireMaintenanceLock } = await import('../src/control.js');
  const { readSecretFile } = await import('../src/config.js');
  const directory = await mkdtemp(join(tmpdir(), 'credspan-private-unit-')); await chmod(directory, 0o700);
  try {
    const path = join(directory, 'generation.json'), generation = randomUUID();
    await writeFile(path, JSON.stringify({ generation, state: 'active' }), { mode: 0o600 });
    const fence = createFence(directory, 'active'); fence.assert();
    const lock = acquireMaintenanceLock(directory, 'test'); assert.throws(() => acquireMaintenanceLock(directory, 'test')); lock.release();
    await chmod(directory, 0o755); assert.throws(() => readControl(directory)); await chmod(directory, 0o700);
    await chmod(path, 0o644); assert.throws(() => readControl(directory)); await chmod(path, 0o600);
    await writeFile(path + '.next', JSON.stringify({ generation: randomUUID(), state: 'active' }), { mode: 0o600 }); await rename(path + '.next', path); assert.throws(fence.assert);
    const secret = join(directory, 'secret'); await writeFile(secret, 'a'.repeat(32), { mode: 0o600 }); assert.equal(readSecretFile(secret), 'a'.repeat(32));
    await symlink(secret, secret + '-link'); assert.throws(() => readSecretFile(secret + '-link'));
    await chmod(secret, 0o644); assert.throws(() => readSecretFile(secret)); await chmod(secret, 0o600);
    await writeFile(secret, '<replace-me>'); assert.throws(() => readSecretFile(secret));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('hosted profile permits only the fixed HTTPS origin with native verify-full CA configuration', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'credspan-hosted-config-'));
  try {
    const ca = join(directory, 'ca.crt'); await writeFile(ca, 'synthetic configuration-only CA');
    const hosted = { ...valid, CREDSPAN_HOSTED_SANDBOX: '1', PUBLIC_URL: 'https://credspan-sandbox.m1ngshum.com', PGSSLMODE: 'verify-full', PGSSLROOTCERT: ca, POSTGRES_HOST: 'aws-1-ap-southeast-1.pooler.supabase.com:5432' };
    assert.equal(readConfig(hosted).host, '::');
    for (const overrides of [{ PUBLIC_URL: 'http://credspan-sandbox.m1ngshum.com' }, { PUBLIC_URL: 'https://credspan-sandbox.m1ngshum.com:444' }, { PUBLIC_URL: 'https://credspan-wallet.m1ngshum.com' }, { PUBLIC_URL: 'https://credspan-sandbox.m1ngshum.com.evil.test' }, { PGSSLMODE: 'require' }, { PGSSLROOTCERT: '/missing-ca.crt' }, { CONSOLE_DEV_ORIGIN: 'http://localhost:3001' }, { POSTGRES_HOST: 'host:5432?sslmode=disable' }, { POSTGRES_HOST: 'aws-1-ap-southeast-1.pooler.supabase.com:6543' }]) assert.throws(() => readConfig({ ...hosted, ...overrides }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
