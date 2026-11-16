import { randomInt } from 'node:crypto';
import { Agent, GenericRecord, InjectionSymbols, RecordDuplicateError, RecordNotFoundError, type StorageService } from '@credo-ts/core';

export const STATUS_LENGTH = 1024;
export const STATUS_TTL = 30;
export const VCT = 'urn:credspan:sandbox-membership';
export const STATUS_PATH = '/status-lists/membership';
const allocationId = (cohort: string, index: number) => `credspan:status-index:${cohort}:${index}`;
const revocationId = (cohort: string, index: number) => `credspan:revocation:${cohort}:${index}`;
export const credentialRecordId = (id: string) => `credspan:credential:${id}`;
const receiptId = (id: string) => `credspan:verification-receipt:${id}`;

function jwtPart(compact: string, part: number): Record<string, any> {
  const value = JSON.parse(Buffer.from(compact.split('.')[part], 'base64url').toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid JWT');
  return value;
}
export function validateStatusToken(token: string, uri: string, issuer: string, kid: string, now = Math.floor(Date.now() / 1000)) {
  if (Buffer.byteLength(token) > 16_384 || token.split('.').length !== 3) throw Error('Invalid status token');
  const header = jwtPart(token, 0), payload = jwtPart(token, 1);
  if (![kid, '#' + kid.split('#')[1]].includes(header.kid) || header.typ !== 'statuslist+jwt' || header.alg !== 'EdDSA' || payload.sub !== uri || payload.iss !== issuer || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.iat > now || payload.iat < now - STATUS_TTL || payload.exp <= now || payload.exp > payload.iat + STATUS_TTL || payload.ttl !== STATUS_TTL || payload.status_list?.bits !== 1) throw Error('Status token violates freshness/profile policy');
  // This is a bounds/freshness gate only. Credo still verifies the JWT signature and status bit.
}

export function createVerificationPolicy(agent: Agent, publicUrl: string, did: string, kid: string, configuredTrust: string[] | undefined, cohort = 'legacy') {
  const uri = `${publicUrl}/status-lists/${cohort}`;
  const storage = agent.dependencyManager.resolve<StorageService<GenericRecord>>(InjectionSymbols.StorageService);
  const insert = (options: ConstructorParameters<typeof GenericRecord>[0]) => storage.save(agent.context, new GenericRecord(options));
  const trusted = configuredTrust ?? [did];
  const trustedIssuers = () => trusted.map(issuance => ({ method: 'did' as const, issuance }));
  async function allocate(credentialId: string) {
    const start = randomInt(STATUS_LENGTH);
    for (let offset = 0; offset < STATUS_LENGTH; offset++) {
      const index = (start + offset) % STATUS_LENGTH;
      try { await insert({ id: allocationId(cohort, index), tags: { kind: 'status-index' }, content: { credentialId, index } }); return index; }
      catch (error) { if (!(error instanceof RecordDuplicateError)) throw error; }
    }
    throw Error('Sandbox status list exhausted');
  }
  async function statusToken() {
    const records = await agent.genericRecords.findAllByQuery({ kind: 'revocation', cohort });
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const options = { format: 'jwt' as const, signer: { method: 'did' as const, didUrl: kid }, alg: 'EdDSA' as const, issuedAt: now, expiresAt: new Date(now.getTime() + STATUS_TTL * 1000), timeToLive: STATUS_TTL };
    const created = await agent.tokenStatusList.createTokenStatusList({ ...options, statusList: { statusListLength: STATUS_LENGTH, bitsPerStatus: 1 }, statusListUri: uri });
    if (created.format !== 'jwt') throw Error('Unexpected status format');
    if (!records.length) return created.statusList;
    const status = records.map(record => { const index = record.content.index; if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= STATUS_LENGTH) throw Error('Invalid durable revocation'); return { index: Number(index), status: 1 }; });
    const updated = await agent.tokenStatusList.updateTokenStatusList({ ...options, token: created.statusList, status });
    if (updated.format !== 'jwt') throw Error('Unexpected status format');
    return updated.statusList;
  }
  async function credential(id: string) {
    const record = await agent.genericRecords.findById(credentialRecordId(id));
    if (!record) throw new RecordNotFoundError('Unknown credential', { recordType: 'Credential' });
    return record;
  }
  async function revoke(id: string) {
    const record = await credential(id);
    const index = Number(record.content.index);
    if (!Number.isInteger(index) || index < 0 || index >= STATUS_LENGTH || (await agent.genericRecords.findById(allocationId(cohort, index)))?.content.credentialId !== id) throw Error('Invalid credential allocation');
    try { await insert({ id: revocationId(cohort, index), tags: { kind: 'revocation', cohort }, content: { index, credentialId: id } }); }
    catch (error) { if (!(error instanceof RecordDuplicateError)) throw error; }
    return { credentialId: id, revoked: true };
  }
  async function verify(compact: string, audience: string, nonce: string) {
    const decoded = agent.sdJwtVc.fromCompact(compact);
    const payload = decoded.prettyClaims;
    const signed = jwtPart(compact.split('~')[0], 1);
    if (JSON.stringify(signed.status) !== JSON.stringify(payload.status) || signed.status === undefined || signed.jti !== payload.jti || signed.exp !== payload.exp || signed.vct !== payload.vct || signed.cnf?.jwk?.kty !== 'EC' || signed.cnf?.jwk?.crv !== 'P-256') throw Error('Required claims must be signed and nonselective with P-256 holder binding');
    const status = payload.status as { status_list?: { uri?: unknown; idx?: unknown } } | undefined;
    const index = status?.status_list?.idx;
    if (decoded.header.typ !== 'dc+sd-jwt' || decoded.header.alg !== 'EdDSA' || payload.vct !== VCT || payload.iss !== did || ![kid, '#' + kid.split('#')[1]].includes(String(decoded.header.kid)) || !trusted.includes(String(payload.iss)) || typeof payload.jti !== 'string' || !/^urn:uuid:[a-f0-9-]{36}$/.test(payload.jti) || !Number.isInteger(payload.exp) || Number(payload.exp) <= Math.floor(Date.now() / 1000) || typeof payload.memberId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(payload.memberId) || decoded.kbJwt?.header.alg !== 'ES256' || decoded.kbJwt.header.typ !== 'kb+jwt' || status?.status_list?.uri !== uri || !Number.isInteger(index) || Number(index) < 0 || Number(index) >= STATUS_LENGTH) throw Error('Credential violates membership profile');
    const allocation = await agent.genericRecords.findById(allocationId(cohort, Number(index)));
    if (allocation?.content.credentialId !== payload.jti || await agent.genericRecords.findById(revocationId(cohort, Number(index)))) throw Error('Credential revoked or allocation unknown');
    const result = await agent.sdJwtVc.verify({ compactSdJwtVc: compact, keyBinding: { audience, nonce }, trustedIssuers: trustedIssuers(), requiredClaimKeys: ['memberId', 'status', 'jti', 'exp', 'vct'] });
    if (!result.isValid || await agent.genericRecords.findById(revocationId(cohort, Number(index))) || Number(payload.exp) <= Math.floor(Date.now() / 1000)) throw Error('Credential proof/status verification failed');
    return { credentialId: payload.jti, memberId: payload.memberId, expiresAt: new Date(Number(payload.exp) * 1000).toISOString() };
  }
  async function receipt(sessionId: string, compact: string, audience: string, nonce: string, expiresAt: Date) {
    const claims = await verify(compact, audience, nonce);
    const deadline = Math.min(expiresAt.getTime(), Date.parse(claims.expiresAt));
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw Error('Presentation authorization or credential expired');
    const verifiedAt = new Date().toISOString();
    await agent.genericRecords.save({ id: receiptId(sessionId), content: { verifiedAt, authorizationExpiresAt: expiresAt.toISOString(), ...claims } });
    if (deadline <= Date.now()) throw Error('Presentation authorization or credential expired while persisting receipt');
    return deadline;
  }
  async function result(sessionId: string, compact: string | undefined, audience: string, nonce: string, originalExpiresAt: Date) {
    const receipt = await agent.genericRecords.findById(receiptId(sessionId));
    const checkedAt = new Date().toISOString();
    if (!receipt) return { id: sessionId, accepted: false, checkedAt };
    const verifiedAt = receipt.content.verifiedAt, authorizationExpiresAt = receipt.content.authorizationExpiresAt;
    if (typeof verifiedAt !== 'string' || typeof authorizationExpiresAt !== 'string' || !Number.isFinite(Date.parse(verifiedAt)) || !Number.isFinite(Date.parse(authorizationExpiresAt)) || new Date(verifiedAt).toISOString() !== verifiedAt || new Date(authorizationExpiresAt).toISOString() !== authorizationExpiresAt || Date.parse(verifiedAt) > Date.now() || Date.parse(verifiedAt) > Date.parse(authorizationExpiresAt) || Date.parse(authorizationExpiresAt) !== originalExpiresAt.getTime()) throw Error('Invalid persisted verification receipt');
    const historical = { id: sessionId, verifiedAt: receipt.content.verifiedAt, authorizationExpiresAt: receipt.content.authorizationExpiresAt, checkedAt };
    if (!compact || Date.parse(String(receipt.content.authorizationExpiresAt)) <= Date.now()) return { ...historical, checkedAt: new Date().toISOString(), accepted: false };
    try { const claims = await verify(compact, audience, nonce); if (Date.parse(String(receipt.content.authorizationExpiresAt)) <= Date.now()) return { ...historical, checkedAt: new Date().toISOString(), accepted: false }; return { ...historical, checkedAt: new Date().toISOString(), accepted: true, ...claims }; }
    catch { return { ...historical, checkedAt: new Date().toISOString(), accepted: false }; }
  }
  return { uri, cohort, credential, allocate, statusToken, revoke, verify, receipt, result, trustedIssuers };
}
export type VerificationPolicy = ReturnType<typeof createVerificationPolicy>;
