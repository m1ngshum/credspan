import { BadRequestException } from '@nestjs/common';
import { GenericRecord, InjectionSymbols, RecordDuplicateError, type AgentContext, type StorageService } from '@credo-ts/core';
import { OpenId4VcIssuanceSessionState, type OpenId4VcIssuerService, type OpenId4VcIssuanceSessionRecord } from '@credo-ts/openid4vc';
import { Oauth2ServerErrorResponseError } from '@openid4vc/oauth2';

export const CREDENTIAL_LIFETIME_SECONDS = 3600;
export function validateMembership(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Expected membership object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || typeof input.name !== 'string' || typeof input.memberId !== 'string' || !input.name.trim() || Array.from(input.name).length > 100 || /[\u0000-\u001f\u007f]/.test(input.name) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.memberId)) throw new BadRequestException('Only bounded name and memberId fields are accepted');
  return { name: input.name.trim(), memberId: input.memberId };
}
export function membershipMetadata(value: Record<string, unknown> | undefined) {
  if (!value || typeof value.credentialId !== 'string' || !/^urn:uuid:[a-f0-9-]{36}$/.test(value.credentialId) || typeof value.expiresAt !== 'number' || !Number.isInteger(value.expiresAt)) throw new Error('Missing persisted membership metadata');
  return { ...validateMembership(value.membership), credentialId: value.credentialId, expiresAt: value.expiresAt };
}
export function issuanceClaimId(stage: 'token' | 'credential', issuerId: string, sessionId: string) { return `credspan:${stage}-attempt:${issuerId}:${sessionId}`; }
async function reserve(context: AgentContext, stage: 'token' | 'credential', issuerId: string, sessionId: string) {
  const storage = context.dependencyManager.resolve<StorageService<GenericRecord>>(InjectionSymbols.StorageService);
  try { await storage.save(context, new GenericRecord({ id: issuanceClaimId(stage, issuerId, sessionId), content: { purpose: `one-attempt-${stage}` } })); }
  catch (error) { throw new Oauth2ServerErrorResponseError({ error: stage === 'token' ? 'invalid_grant' : 'credential_request_denied', error_description: error instanceof RecordDuplicateError ? 'Issuance stage already attempted; create a fresh offer' : 'Unable to reserve issuance stage' }); }
}

export function installIssuanceBoundaries(service: OpenId4VcIssuerService, issuerId: string, check: () => void = () => {}) {
  const unclaimedRequests = new WeakSet<OpenId4VcIssuanceSessionRecord>();
  const updateState = service.updateState.bind(service);
  service.updateState = async (context, session, state) => {
    check();
    if (state === OpenId4VcIssuanceSessionState.OfferUriRetrieved) return;
    // Credo's endpoint catch must not let a losing request overwrite the winning state.
    if (state === OpenId4VcIssuanceSessionState.Error && unclaimedRequests.has(session)) return;
    // Credo 0.7.5 reaches this transition only after full grant/PIN/client proof validation.
    if (state === OpenId4VcIssuanceSessionState.AccessTokenRequested) {
      if (session.issuerId !== issuerId || session.openId4VciVersion !== 'v1') throw new Oauth2ServerErrorResponseError({ error: 'invalid_grant', error_description: 'Unsupported issuance session' });
      membershipMetadata(session.issuanceMetadata);
      await reserve(context, 'token', issuerId, session.id);
    }
    return updateState(context, session, state);
  };
  const create = service.createCredentialResponse.bind(service);
  service.createCredentialResponse = async (context, options) => {
    check();
    const session = options.issuanceSession;
    if (session.issuerId !== issuerId || session.openId4VciVersion !== 'v1') throw new Oauth2ServerErrorResponseError({ error: 'credential_request_denied', error_description: 'Unsupported issuance session' });
    membershipMetadata(session.issuanceMetadata);
    // The HTTP endpoint already verified token audience/signature/subject and parsed request shape.
    try { await reserve(context, 'credential', issuerId, session.id); } catch (error) { unclaimedRequests.add(session); throw error; }
    try { const result = await create(context, options); check(); return result; } catch { throw new Oauth2ServerErrorResponseError({ error: 'credential_request_denied', error_description: 'Credential attempt rejected; create a fresh offer' }); }
  };
}
