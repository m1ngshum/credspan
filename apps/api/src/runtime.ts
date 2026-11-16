import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Agent, ConsoleLogger, LogLevel, DidsModule, KeyDidResolver, GenericRecord, InjectionSymbols, Kms, RecordDuplicateError, RecordNotFoundError, type StorageService, type AgentContext } from '@credo-ts/core';
import { agentDependencies } from '@credo-ts/node';
import { AskarModule } from '@credo-ts/askar';
import { NativeAskar } from '@openwallet-foundation/askar-nodejs';
import { OpenId4VcModule, OpenId4VcIssuerService, OpenId4VpVerifierService, OpenId4VcVerificationSessionState } from '@credo-ts/openid4vc';
import { Oauth2ServerErrorResponseError } from '@openid4vc/oauth2';
import type { Express } from 'express';
import { createVerificationPolicy, credentialRecordId, validateStatusToken, type VerificationPolicy } from './verification.js';
import { createFence, assertMaintenanceLock } from './control.js';
import type { Config } from './config.js';
import { CREDENTIAL_LIFETIME_SECONDS, validateMembership, membershipMetadata, installIssuanceBoundaries, issuanceClaimId } from './issuance.js';

export const VCT = 'urn:credspan:sandbox-membership';
export const IDENTITY_RECORD = 'credspan:identity:v1';
const PROVISIONING_RECORD = 'credspan:identity-provisioning:v1';
export const PREAUTHORIZED = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';
export const DCQL = { credentials: [{ id: 'membership', format: 'dc+sd-jwt' as const, meta: { vct_values: [VCT] }, claims: [{ path: ['memberId'] }] }] };

function protocolError(description: string) {
  return new Oauth2ServerErrorResponseError({ error: 'invalid_request', error_description: description });
}

// A native INSERT makes a claim atomic across processes; failed attempts are never released.
export async function claimVerification(context: AgentContext, verifierId: string, sessionId: string) {
  const storage = context.dependencyManager.resolve<StorageService<GenericRecord>>(InjectionSymbols.StorageService);
  try {
    await storage.save(context, new GenericRecord({ id: `credspan:verification-attempt:${verifierId}:${sessionId}`, content: { purpose: 'one-attempt-verification' } }));
  } catch (error) {
    if (error instanceof RecordDuplicateError) throw protocolError('Verification session already attempted; request a fresh session');
    throw protocolError('Unable to reserve verification session');
  }
}

export function installVerificationBoundary(service: OpenId4VpVerifierService) {
  const update = service.updateState.bind(service);
  service.updateState = async (...args) => {
    // GET observation is not a business transition and must never overwrite a response.
    if (args[2] === OpenId4VcVerificationSessionState.RequestUriRetrieved) return;
    return update(...args);
  };
  const verify = service.verifyAuthorizationResponse.bind(service);
  service.verifyAuthorizationResponse = async (context, options) => {
    const session = options.verificationSession;
    if (session.openId4VpVersion !== 'v1') throw protocolError('Only OpenID4VP 1.0 is supported');
    await claimVerification(context, session.verifierId, session.id);
    try { const result = await verify(context, options); if (!session.expiresAt || session.expiresAt.getTime() <= Date.now()) throw Error('Presentation expired'); return result; } catch { throw protocolError('Presentation rejected; request a fresh session'); }
  };
}

export function installPreauthorizedMetadata(service: OpenId4VcIssuerService) {
  const getMetadata = service.getIssuerMetadata.bind(service);
  service.getIssuerMetadata = async (...args) => {
    const metadata = await getMetadata(...args);
    for (const server of metadata.authorizationServers) {
      if (server.issuer !== metadata.credentialIssuer.credential_issuer) continue;
      server.grant_types_supported = [PREAUTHORIZED];
      // OID4VCI final §12.2 permits omission for this preauthorized-only profile.
      for (const key of ['authorization_endpoint', 'authorization_challenge_endpoint', 'response_types_supported', 'pushed_authorization_request_endpoint', 'require_pushed_authorization_requests', 'code_challenge_methods_supported', 'authorization_response_iss_parameter_supported']) delete (server as Record<string, unknown>)[key];
    }
    return metadata;
  };
}

export type Maintenance = { operation: 'provision' | 'retire' | 'rekey' | 'upgrade'; previousGeneration?: string; newStoreKey?: string; operationId?: string };
export async function createRuntime(app: Express, config: Config, maintenance?: Maintenance) {
  if (maintenance) assertMaintenanceLock(config.controlDirectory, maintenance.operationId, maintenance.operation, config.hosted);
  const fence = createFence(config.controlDirectory, maintenance ? 'fenced' : 'active', config.hosted);
  let issuerKid = '';
  let policy: VerificationPolicy | undefined;
  let activeCohort = '';
  app.get('/status-lists/:cohort', async (request, response, next) => { if (request.params.cohort !== activeCohort) { response.status(404).json({ error: 'unknown_cohort' }); return; } next(); });
  app.get('/status-lists/:cohort', async (_request, response) => {
    try { if (!policy) throw Error('Not ready'); response.setHeader('Cache-Control', 'no-store'); response.type('application/statuslist+jwt').send(await localStatusToken(policy)); }
    catch { response.status(503).json({ error: 'status_unavailable' }); }
  });
  let activeIssuerId = '';
  let activeVerifierId = '';
  app.use('/verifier/:verifierId', (request, response, next) => { if (request.params.verifierId !== activeVerifierId) { response.status(404).json({ error: 'unknown_verifier' }); return; } next(); });
  app.use('/issuer/:issuerId', (request, response, next) => {
    if (request.params.issuerId !== activeIssuerId) { response.status(404).json({ error: 'unknown_issuer' }); return; }
    next();
  });
  // Use the same Express route matcher as Credo, including case/trailing-slash aliases.
  app.post('/issuer/:issuerId/token', (request, response, next) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['grant_type', 'pre-authorized_code', 'client_id'].includes(key)) || body.grant_type !== PREAUTHORIZED || typeof body['pre-authorized_code'] !== 'string' || !body['pre-authorized_code'] || body['pre-authorized_code'].length > 256 || (body.client_id !== undefined && (typeof body.client_id !== 'string' || !body.client_id || body.client_id.length > 2048)) || ['authorization', 'dpop', 'oauth-client-attestation', 'oauth-client-attestation-pop'].some(header => request.headers[header] !== undefined)) { response.status(400).json({ error: 'invalid_grant' }); return; }
    next();
  });
  app.post('/issuer/:issuerId/credential', (request, response, next) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['credential_configuration_id', 'proofs'].includes(key)) || body.credential_configuration_id !== 'membership' || !body.proofs || Object.keys(body.proofs).length !== 1 || !Array.isArray(body.proofs.jwt) || body.proofs.jwt.length !== 1 || typeof body.proofs.jwt[0] !== 'string') { response.status(400).json({ error: 'invalid_credential_request' }); return; }
    next();
  });
  const agent = new Agent({ config: { allowInsecureHttpUrls: new URL(config.publicUrl).protocol === 'http:', autoUpdateStorageOnStartup: false, logger: new ConsoleLogger(LogLevel.Off) }, dependencies: { ...agentDependencies, fetch: async (input, _init) => {
      if (!policy || String(input) !== policy.uri) throw Error('Only the configured local status URI is permitted');
      const token = await localStatusToken(policy);
      validateStatusToken(token, policy.uri, issuerKid.split('#')[0], issuerKid);
      return new Response(token, { headers: { 'content-type': 'application/statuslist+jwt' } });
    } },
    modules: {
      // Holder identifiers can be resolved before issuer signature verification; this lane needs no remote DID methods.
      dids: new DidsModule({ resolvers: [new KeyDidResolver()] }),
      askar: new AskarModule({ askar: NativeAskar, store: { id: config.storeId, key: config.storeKey, database: { type: 'postgres', config: { host: config.postgresHost, connectTimeout: 3, maxConnections: config.hosted ? 2 : 5 }, credentials: { account: config.postgresUser, password: config.postgresPassword } } } }),
      openid4vc: new OpenId4VcModule({ app, issuer: { baseUrl: `${config.publicUrl}/issuer`, credentialRequestToCredentialMapper: async ({ credentialConfiguration, holderBinding, issuanceSession }) => {
        if (credentialConfiguration.format !== 'dc+sd-jwt' || credentialConfiguration.vct !== VCT) throw protocolError('Unsupported credential profile');
        if (holderBinding.keys.length !== 1) throw protocolError('Exactly one holder key is required');
        const membership = membershipMetadata(issuanceSession.issuanceMetadata);
        const record = await policy?.credential(membership.credentialId);
        if (!record || record.content.sessionId !== issuanceSession.id || !policy) throw Error('Missing credential status allocation');
        const status = { status_list: { idx: Number(record.content.index), uri: policy.uri } };
        if (membership.expiresAt <= Math.floor(Date.now() / 1000)) throw protocolError('Membership has expired');
        return { type: 'credentials', format: 'dc+sd-jwt', credentials: [{ payload: { vct: VCT, jti: membership.credentialId, name: membership.name, memberId: membership.memberId, exp: membership.expiresAt, status }, holder: holderBinding.keys[0], issuer: { method: 'did', didUrl: issuerKid }, disclosureFrame: { _sd: ['name', 'memberId'] } }] };
      } }, verifier: { baseUrl: `${config.publicUrl}/verifier` } }),
    } });
  try {
  if (maintenance?.operation === 'provision') await agent.modules.askar.provisionStore();
  else await agent.modules.askar.openStore();
  await agent.initialize();
    installPreauthorizedMetadata(agent.dependencyManager.resolve(OpenId4VcIssuerService));
    installVerificationBoundary(agent.dependencyManager.resolve(OpenId4VpVerifierService));
    let record = await agent.genericRecords.findById(IDENTITY_RECORD);
    if (maintenance?.operation === 'provision' && record) throw Error('Identity already exists');
    if (maintenance && maintenance.operation !== 'provision') {
      if (!record || ![1, 2].includes(record.content.version as number) || (record.content.generation ?? 'legacy') !== maintenance.previousGeneration) throw Error('Maintenance base generation mismatch');
      if (maintenance.operation === 'upgrade' && (record.content.version !== 1 || record.content.generation !== undefined)) throw Error('Only the explicit v1 to v2 upgrade is supported');
      if (maintenance.operation === 'rekey') {
        if (!maintenance.newStoreKey || maintenance.newStoreKey.length < 32 || record.content.version !== 2) throw Error('Invalid rekey request');
        await agent.modules.askar.rotateStoreKey({ newKey: maintenance.newStoreKey });
        record.content.generation = fence.generation; await agent.genericRecords.update(record);
      } else {
        await agent.genericRecords.save({ id: `credspan:retired:${randomUUID()}`, content: { ...record.content } });
        record = null;
      }
    }
    if (!record && !maintenance) throw Error('Store requires explicit provisioning or upgrade');
    if (!record) {
      if (maintenance?.operation === 'provision' && ((await agent.dids.getCreatedDids({ method: 'key' })).length || (await agent.openid4vc.issuer.getAllIssuers()).length || (await agent.openid4vc.verifier.getAllVerifiers()).length)) throw Error('Existing store has no explicit identity configuration; use a separately provisioned sandbox store');
      // Never steal an incomplete provisioning claim or silently regenerate a deleted configuration.
      await agent.genericRecords.save({ id: `${PROVISIONING_RECORD}:${fence.generation}`, content: { purpose: 'identity-provisioning' } });
      const { keyId } = await agent.kms.createKey({ type: { kty: 'OKP', crv: 'Ed25519' } });
      const result = await agent.dids.create({ method: 'key', options: { keyId } });
      if (result.didState.state !== 'finished') throw Error('Unable to provision issuer DID');
      const did = result.didState.did;
      const kid = result.didState.didDocument.verificationMethod?.[0]?.id;
      if (!kid) throw Error('Missing issuer signing key');
      const issuer = await agent.openid4vc.issuer.createIssuer({ credentialConfigurationsSupported: { membership: { format: 'dc+sd-jwt', vct: VCT, cryptographic_binding_methods_supported: ['jwk'], credential_signing_alg_values_supported: ['EdDSA'], proof_types_supported: { jwt: { proof_signing_alg_values_supported: ['ES256'] } } } } });
      const verifier = await agent.openid4vc.verifier.createVerifier();
      const content = { version: 2, generation: fence.generation, cohortId: randomUUID(), publicUrl: config.publicUrl, did, kid, keyId, issuerId: issuer.issuerId, verifierId: verifier.verifierId };
      const existing = await agent.genericRecords.findById(IDENTITY_RECORD);
      if (existing) { existing.content = content; await agent.genericRecords.update(existing); record = existing; }
      else record = await agent.genericRecords.save({ id: IDENTITY_RECORD, content });
    }
    const identity = record.content;
    if (identity.version !== 2 || identity.generation !== fence.generation || typeof identity.cohortId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(identity.cohortId) || identity.publicUrl !== config.publicUrl || !['did', 'kid', 'keyId', 'issuerId', 'verifierId'].every(key => typeof identity[key] === 'string')) throw Error('Invalid persisted identity configuration');
    const { did, kid, keyId, issuerId, verifierId } = identity as { did: string; kid: string; keyId: string; issuerId: string; verifierId: string };
    const publicKey = await agent.kms.getPublicKey({ keyId });
    if (publicKey.kty !== 'OKP' || publicKey.crv !== 'Ed25519' || !did.startsWith('did:key:') || kid !== `${did}#${did.slice(8)}` || Kms.PublicJwk.fromPublicJwk(publicKey).fingerprint !== did.slice(8)) throw Error('Persisted signer does not match its key');
    await agent.kms.sign({ keyId, algorithm: 'EdDSA', data: Buffer.from('Credspan startup key check') });
    const issuer = await agent.openid4vc.issuer.getIssuerByIssuerId(issuerId);
    const verifier = await agent.openid4vc.verifier.getVerifierByVerifierId(verifierId);
    const tokenKey = issuer.resolvedAccessTokenPublicJwk;
    await agent.kms.sign({ keyId: tokenKey.keyId, algorithm: tokenKey.supportedSignatureAlgorithms[0], data: Buffer.from('Credspan token key check') });
    if (issuer.credentialConfigurationsSupported?.membership?.format !== 'dc+sd-jwt' || issuer.credentialConfigurationsSupported.membership.vct !== VCT) throw Error('Persisted issuer profile mismatch');
    issuerKid = kid;
    activeIssuerId = issuerId; activeVerifierId = verifierId; activeCohort = identity.cohortId as string;
    policy = createVerificationPolicy(agent, config.publicUrl, did, kid, config.trustedIssuers, activeCohort);
    const verificationPolicy = policy;
    agent.config.setTrustedIssuersForVerification(async () => ({ trustedIssuers: verificationPolicy.trustedIssuers() }));
    const verificationService = agent.dependencyManager.resolve(OpenId4VpVerifierService);
    const originalVerify = verificationService.verifyAuthorizationResponse.bind(verificationService);
    verificationService.verifyAuthorizationResponse = async (context, options) => { fence.assert(); if (options.verificationSession.verifierId !== verifierId) throw protocolError('Retired verifier'); const result = await originalVerify(context, options); fence.assert(); return result; };
    const updateVerification = verificationService.updateState.bind(verificationService);
    verificationService.updateState = async (...args) => {
      fence.assert();
      const session = args[1];
      if (args[2] === OpenId4VcVerificationSessionState.ResponseVerified) {
        const token = presentationToken(session.authorizationResponsePayload?.vp_token);
        const deadline = await verificationPolicy.receipt(session.id, token, session.requestPayload.client_id!, session.requestPayload.nonce, session.expiresAt!);
        await updateVerification(...args);
        fence.assert();
        if (deadline <= Date.now()) throw Error('Presentation authorization or credential expired while persisting result');
        return;
      }
      return updateVerification(...args);
    };
    installIssuanceBoundaries(agent.dependencyManager.resolve(OpenId4VcIssuerService), issuerId, fence.assert);
    const createIssuance = async (input: unknown) => {
      fence.assert();
      const membership = validateMembership(input);
      const credentialId = `urn:uuid:${randomUUID()}`;
      const expiresAt = Math.floor(Date.now() / 1000) + CREDENTIAL_LIFETIME_SECONDS;
      const offer = await agent.openid4vc.issuer.createCredentialOffer({ issuerId, credentialConfigurationIds: ['membership'], version: 'v1', preAuthorizedCodeFlowConfig: {}, issuanceMetadata: { membership, credentialId, expiresAt } });
      const index = await verificationPolicy.allocate(credentialId);
      await agent.genericRecords.save({ id: credentialRecordId(credentialId), content: { index, sessionId: offer.issuanceSession.id, expiresAt } });
      fence.assert();
      return { id: offer.issuanceSession.id, offer: offer.credentialOffer, credentialId, expiresAt: new Date(expiresAt * 1000).toISOString() };
    };
    const createPresentation = async () => {
      fence.assert();
      const request = await agent.openid4vc.verifier.createAuthorizationRequest({ verifierId, version: 'v1', requestSigner: { method: 'did', didUrl: issuerKid }, dcql: { query: DCQL } });
      fence.assert();
      return { id: request.verificationSession.id, request: request.authorizationRequest, expiresAt: request.verificationSession.expiresAt!.toISOString() };
    };
    fence.assert();
    return { agent, fence, policy: verificationPolicy, createPresentation, async revoke(id: string) { fence.assert(); const result = await verificationPolicy.revoke(id); fence.assert(); return result; },
      async presentationResult(id: string) {
        fence.assert();
        const session = await agent.openid4vc.verifier.getVerificationSessionById(id);
        if (session.verifierId !== verifierId) throw new RecordNotFoundError('Unknown presentation', { recordType: 'VerificationSession' });
        if (session.state !== 'ResponseVerified') return { id, accepted: false, checkedAt: new Date().toISOString() };
        const result = await verificationPolicy.result(id, presentationToken(session.authorizationResponsePayload?.vp_token), session.requestPayload.client_id!, session.requestPayload.nonce, session.expiresAt!);
        fence.assert(); return result;
      }, identity: { did, kid, keyId, issuerId, verifierId, generation: fence.generation, cohortId: activeCohort }, createIssuance,
      async issuanceStatus(id: string) {
        const session = await agent.openid4vc.issuer.getIssuanceSessionById(id);
        if (session.issuerId !== issuerId) throw new RecordNotFoundError('Unknown issuance session', { recordType: 'IssuanceSession' });
        const metadata = membershipMetadata(session.issuanceMetadata);
        return { id: session.id, state: session.state, credentialId: metadata.credentialId, expiresAt: new Date(metadata.expiresAt * 1000).toISOString(), tokenConsumed: !!await agent.genericRecords.findById(issuanceClaimId('token', issuerId, id)), credentialAttempted: !!await agent.genericRecords.findById(issuanceClaimId('credential', issuerId, id)) };
      },
      async createRoundtrip() {
        const offer = await createIssuance({ name: 'Synthetic Member', memberId: 'sandbox-member' });
        const request = await agent.openid4vc.verifier.createAuthorizationRequest({ verifierId: verifier.verifierId, version: 'v1', requestSigner: { method: 'did', didUrl: issuerKid }, dcql: { query: DCQL } });
        return { offer: offer.offer, request: request.authorizationRequest, sessionId: request.verificationSession.id };
      },
      async status(id: string) { const session = await agent.openid4vc.verifier.getVerificationSessionById(id); return { cryptographicState: session.state, version: session.openId4VpVersion }; },
      close: () => agent.shutdown(),
    };
  } catch (error) { await agent.shutdown().catch(() => {}); throw error; }
}
export type Runtime = Awaited<ReturnType<typeof createRuntime>>;

function presentationToken(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) throw Error('Expected one membership presentation');
  const presentations = (value as Record<string, unknown>).membership;
  if (!Array.isArray(presentations) || presentations.length !== 1 || typeof presentations[0] !== 'string') throw Error('Expected one membership presentation');
  return presentations[0];
}

async function localStatusToken(policy: VerificationPolicy) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([policy.statusToken(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('Status generation timed out')), 2000); })]); }
  finally { clearTimeout(timer); }
}
