import { provision } from './provision.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, generateKeyPairSync, createHash, sign } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { inflateSync } from 'node:zlib';
import { request as httpRequest, createServer as createHttpServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { CompactEncrypt, decodeJwt, importJWK, type JWK } from 'jose';
import { DifPresentationExchangeService, Kms, WebDidResolver, type AgentContext, type SdJwtVcApi } from '@credo-ts/core';
import { createApplication } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { OpenId4VcIssuerService, OpenId4VpVerifierService, OpenId4VcIssuanceSessionRepository, OpenId4VcVerificationSessionRepository } from '@credo-ts/openid4vc';
import { claimVerification, IDENTITY_RECORD } from '../src/runtime.js';

const exec = promisify(execFile);
const PG = 'postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42';
const PATCH = 'ed059fd9f91f8b371c2c35839ed5a350185ebea16d346054d286db83e05e73aa';
const image = process.env.WALLET_IMAGE ?? 'credspan-wallet-peer:1.2.1-preauth';
const previousImage = process.env.PREVIOUS_WALLET_IMAGE;
if (previousImage) assert.match(previousImage, /^sha256:[a-f0-9]{64}$/);
async function docker(...args: string[]) { return (await exec('docker', args, { maxBuffer: 2_000_000 })).stdout.trim(); }
async function freePort() { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
async function waitFor(check: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { try { if (await check()) return; } catch {} await delay(200); } throw Error('Service readiness timed out'); }

test('real modified-wallet roundtrip and durable single-attempt verifier', { timeout: 240_000 }, async t => {
  const label = `credspan-probe-${randomBytes(4).toString('hex')}`;
  const directory = await mkdtemp(join(tmpdir(), 'credspan-integration-'));
  const configDirectory = join(directory, 'wallet-config');
  await mkdir(configDirectory, { mode: 0o755 });
  const apiPort = await freePort(), secondPort = await freePort();
  const pgPassword = randomBytes(24).toString('hex'), apiKey = randomBytes(32).toString('hex');
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let second: ChildProcess | undefined;
  const pex = DifPresentationExchangeService.prototype as unknown as Record<string, unknown>;
  const originals = Object.fromEntries(['validatePresentation', 'validatePresentationDefinition', 'validatePresentationSubmission'].map(name => [name, pex[name]]));
  let pexCalls = 0;
  for (const name of Object.keys(originals)) pex[name] = () => { pexCalls++; throw Error('PEX sentinel executed'); };
  const management = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
  const origin = `http://127.0.0.1:${apiPort}`;
  async function post(path: string, body: unknown, headers: Record<string, string> = management) { return fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(body) }); }
  async function create() { const res = await post('/api/roundtrips', {}); assert.equal(res.status, 201); return await res.json() as { offer: string; request: string; sessionId: string }; }
  async function status(id: string) { const res = await fetch(`${origin}/api/roundtrips/${id}`, { headers: management }); assert.equal(res.status, 200); return await res.json() as { cryptographicState: string }; }
  async function stopSecond() {
    const child = second;
    second = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  try {
    await t.test('cleanup handles an already exited worker', async () => {
      second = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      await once(second, 'exit');
      await stopSecond();
      assert.equal(second, undefined);
    });
    assert.equal(await docker('image', 'inspect', image, '--format', '{{index .Config.Labels "credspan.dependencies.patch.sha256"}}'), '32cb0096a32693e17674038caa316605822c4b879e9cf5fad41008ea50b33041', 'Build the current dependency-qualified wallet distribution first');
    assert.equal(await docker('image', 'inspect', image, '--format', '{{index .Config.Labels "credspan.probe.patch.sha256"}}'), PATCH, 'Build the exact reviewed modified wallet peer first');
    await writeFile(join(configDirectory, '_features.conf'), 'enabledFeatures = [wallet2-persistence]\ndisabledFeatures = []\n');
    await writeFile(join(configDirectory, 'web.conf'), 'webHost = "0.0.0.0"\nwebPort = 7006\n');
    await writeFile(join(configDirectory, 'wallet2-persistence.conf'), 'jdbcUrl = "jdbc:sqlite:data/wallet2.db"\ndriverClassName = "org.sqlite.JDBC"\n');
    await writeFile(join(configDirectory, 'wallet-service.conf'), 'publicBaseUrl = "http://localhost:7006"\n');
    await writeFile(join(configDirectory, 'network-fetch-guard.conf'), 'allowLoopback = false\nallowPrivateNetworks = false\ntrustedHostSuffixes = ["host.docker.internal"]\n');
    await docker('run', '-d', '--name', `${label}-pg`, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${pgPassword}`, '-e', 'POSTGRES_USER=credspan', PG);
    const pgPort = (await docker('port', `${label}-pg`, '5432/tcp')).split(':').at(-1)!;
    await waitFor(async () => (await docker('exec', `${label}-pg`, 'pg_isready', '-U', 'credspan')).includes('accepting'));
    const walletVolume = `${label}-wallet-data`, cloneVolume = `${label}-wallet-clone`;
    for (const volume of [walletVolume, cloneVolume]) await docker('volume', 'create', volume);
    const startWallet = (selected: string, volume: string, port = '') => docker('run', '-d', '--name', `${label}-wallet`, '-p', `127.0.0.1:${port}:7006`, '--add-host', 'host.docker.internal:host-gateway', '--mount', `type=bind,source=${configDirectory},target=/waltid-wallet-api2/config,readonly`, '--mount', `type=volume,source=${volume},target=/waltid-wallet-api2/data`, '-e', 'CREDSPAN_ACCESS_ORIGIN=https://credspan-sandbox.m1ngshum.com', '-e', 'CF_ACCESS_CLIENT_ID=synthetic-integration-id', '-e', 'CF_ACCESS_CLIENT_SECRET=synthetic-integration-secret', selected);
    await startWallet(previousImage ?? image, walletVolume);
    const walletPort = (await docker('port', `${label}-wallet`, '7006/tcp')).split(':').at(-1)!;
    const walletOrigin = `http://127.0.0.1:${walletPort}`;
    await waitFor(async () => (await fetch(walletOrigin + '/livez')).ok);
    const configEnv = { ...process.env, CONTROL_DIRECTORY: directory, CREDSPAN_SANDBOX: '1', PUBLIC_URL: `http://host.docker.internal:${apiPort}`, PORT: String(apiPort), HOST: '0.0.0.0', MANAGEMENT_API_KEY: apiKey, ASKAR_STORE_ID: 'credspan_test', ASKAR_STORE_KEY: randomBytes(32).toString('hex'), POSTGRES_HOST: `127.0.0.1:${pgPort}`, POSTGRES_USER: 'credspan', POSTGRES_PASSWORD: pgPassword };
    await provision(readConfig(configEnv));
    application = await createApplication(readConfig(configEnv));
    await application.app.listen(apiPort, '0.0.0.0');
    const walletPost = async (path: string, body: unknown) => { const res = await fetch(walletOrigin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(res.ok, `Wallet ${path} returned ${res.status}`); return await res.json() as Record<string, any>; };
    const { walletId } = await walletPost('/wallet', {});
    const { keyId } = await walletPost(`/wallet/${walletId}/keys/generate`, { backend: 'jwk', keyType: 'secp256r1' });
    const first = await create();
    let credentialIds: string[] = [];
    let issuedSessionForOutage = '';
    let presentationForOutage = '';
    await t.test('management auth and strict fixed profile', async () => {
      for (const authorization of ['', apiKey, `Basic ${apiKey}`, 'Bearer ', `Bearer ${apiKey}, Bearer ${apiKey}`]) assert.equal((await post('/api/roundtrips', {}, { 'content-type': 'application/json', authorization })).status, 401);
      const duplicateStatus = await new Promise<number>(resolve => { const req = httpRequest(`${origin}/api/roundtrips`, { method: 'POST', headers: ['Authorization', `Bearer ${apiKey}`, 'Authorization', `Bearer ${apiKey}`, 'Content-Type', 'application/json', 'Content-Length', '2'] }, res => { res.resume(); resolve(res.statusCode!); }); req.end('{}'); });
      assert.ok([400, 401].includes(duplicateStatus), 'Duplicate authorization must be rejected by the HTTP parser or authentication boundary');
      for (const body of [{ version: 'v1.draft21' }, { presentationExchange: {} }, { format: 'jwt_vc_json' }, { name: 'real subject' }, []]) assert.equal((await post('/api/roundtrips', body)).status, 400);
    });
    await t.test('truthful preauthorized metadata and actual external holder roundtrip', async () => {
      const offerUri = new URL(first.offer).searchParams.get('credential_offer_uri')!;
      const offer = await (await fetch(offerUri.replace(configEnv.PUBLIC_URL, origin))).json();
      const issuerPath = new URL(offer.credential_issuer).pathname;
      const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server${issuerPath}`)).json();
      assert.deepEqual(metadata.grant_types_supported, ['urn:ietf:params:oauth:grant-type:pre-authorized_code']);
      for (const name of ['response_types_supported', 'authorization_endpoint', 'authorization_challenge_endpoint', 'pushed_authorization_request_endpoint', 'require_pushed_authorization_requests', 'code_challenge_methods_supported', 'authorization_response_iss_parameter_supported']) assert.equal(name in metadata, false);
      const received = await walletPost(`/wallet/${walletId}/credentials/receive`, { offerUrl: first.offer, keyId });
      assert.equal(received.credentialIds.length, 1);
      credentialIds = received.credentialIds;
      // Clone only synthetic stopped state; preserve the original for compatibility comparison.
      await docker('stop', `${label}-wallet`);
      await docker('run', '--rm', '--network', 'none', '--entrypoint', 'sh', '--mount', `type=volume,source=${walletVolume},target=/source,readonly`, '--mount', `type=volume,source=${cloneVolume},target=/clone`, previousImage ?? image, '-c', 'cp -a /source/. /clone/');
      await docker('rm', `${label}-wallet`);
      await startWallet(image, cloneVolume, walletPort);
      await waitFor(async () => (await fetch(walletOrigin + '/livez')).ok);
      const presented = await walletPost(`/wallet/${walletId}/credentials/present`, { requestUrl: first.request });
      assert.equal(presented.transmission_success, true);
      assert.equal((await status(first.sessionId)).cryptographicState, 'ResponseVerified');
    });
    if (/^[a-f0-9]{64}$/.test(await docker('image', 'inspect', image, '--format', '{{index .Config.Labels "credspan.access.patch.sha256"}}'))) {
      await t.test('actual hosted wallet transport strips foreign-origin Access headers and refuses redirects', async () => {
        const requests: string[] = [], leakedHeaders: unknown[] = [];
        const server = createHttpServer((request, response) => {
          leakedHeaders.push(request.headers['cf-access-client-id'], request.headers['cf-access-client-secret']);
          requests.push(request.url!);
          response.writeHead(302, { location: '/redirect-target' }); response.end();
        });
        await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
        try {
          const port = (server.address() as { port: number }).port;
          const offerUrl = 'openid-credential-offer://?credential_offer_uri=' + encodeURIComponent(`http://host.docker.internal:${port}/redirect`);
          const result = await fetch(walletOrigin + `/wallet/${walletId}/credentials/receive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offerUrl, keyId }) });
          assert.ok(result.status >= 400);
          assert.deepEqual(requests, ['/redirect']);
          assert.deepEqual(leakedHeaders, [undefined, undefined]);
          const logs = await exec('docker', ['logs', `${label}-wallet`], { maxBuffer: 2_000_000 });
          for (const secret of ['synthetic-integration-id', 'synthetic-integration-secret']) assert.equal((logs.stdout + logs.stderr).includes(secret), false);
        } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
      });
    }
    async function requestData(flow: Awaited<ReturnType<typeof create>>) {
      const uri = new URL(flow.request).searchParams.get('request_uri')!;
      const jwt = await (await fetch(uri.replace(configEnv.PUBLIC_URL, origin))).text();
      return decodeJwt(jwt) as { nonce: string; state: string; client_id: string; response_uri: string; client_metadata: { jwks: { keys: JWK[] } } };
    }
    async function envelope(request: Awaited<ReturnType<typeof requestData>>, payload: Record<string, unknown>) {
      const jwk = request.client_metadata.jwks.keys[0];
      return new CompactEncrypt(Buffer.from(JSON.stringify(payload))).setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM', kid: jwk.kid, apv: Buffer.from(request.nonce).toString('base64url') }).encrypt(await importJWK(jwk, 'ECDH-ES'));
    }
    async function submit(uri: string, response: string, port = apiPort) { return fetch(uri.replace(configEnv.PUBLIC_URL, `http://127.0.0.1:${port}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response }) }); }
    await t.test('malformed boundaries create no arbitrary claims; encrypted PEX cannot reach sentinel', async () => {
      const flow = await create();
      const before = (await application!.runtime.agent.genericRecords.getAll()).length;
      assert.equal((await post(`/verifier/${randomUUID()}/authorize?session=${randomUUID()}`, { response: 'garbage' })).status, 404);
      const request = await requestData(flow);
      assert.equal((await post(new URL(request.response_uri).pathname + new URL(request.response_uri).search, { presentation_submission: {}, vp_token: {} })).status, 400);
      assert.equal((await post(new URL(request.response_uri).pathname + new URL(request.response_uri).search, { response: 'x'.repeat(33_000) })).status, 413);
      assert.equal((await application!.runtime.agent.genericRecords.getAll()).length, before);
      const response = await envelope(request, { state: request.state, vp_token: { membership: ['not-a-credential'] }, presentation_submission: { id: 'pex', definition_id: 'legacy', descriptor_map: [] } });
      assert.equal((await submit(request.response_uri, response)).status, 400);
      assert.equal(pexCalls, 0);
      assert.equal((await submit(request.response_uri, response)).status, 400, 'A failed cryptographic attempt stays consumed');
    });
    const startSecond = async (overrides: Record<string, string> = {}) => {
      await stopSecond();
      second = spawn(process.execPath, [new URL('../src/main.js', import.meta.url).pathname], { env: { ...configEnv, PORT: String(secondPort), ...overrides }, stdio: ['ignore', 'ignore', 'ignore'] });
      await waitFor(async () => (await fetch(`http://127.0.0.1:${secondPort}/api/roundtrips/${first.sessionId}`, { headers: management })).ok);
    };
    await t.test('two independent processes admit one concurrent response; restart preserves claim', async () => {
      await startSecond();
      const flow = await create(), request = await requestData(flow);
      const built = await walletPost(`/wallet/${walletId}/credentials/present/build-vp-token`, { requestUrl: flow.request, selectedCredentialIds: { membership: credentialIds } });
      const vpToken = typeof built.vpToken === 'string' ? JSON.parse(built.vpToken) : built.vpToken;
      const response = await envelope(request, { state: request.state, vp_token: vpToken });
      const results = await Promise.all([submit(request.response_uri, response), submit(request.response_uri, response, secondPort)]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
      assert.equal((await status(flow.sessionId)).cryptographicState, 'ResponseVerified');
      await stopSecond(); await startSecond();
      assert.equal((await submit(request.response_uri, response, secondPort)).status, 400);
      await stopSecond();
    });
    await t.test('authenticated membership issuance APIs validate input and return sanitized stable metadata', async () => {
      assert.equal((await post('/api/issuance-sessions', { name: 'Synthetic', memberId: 'test' }, { 'content-type': 'application/json' })).status, 401);
      for (const body of [{}, [], { name: 'x', memberId: 'a', expiresAt: 1 }, { name: 'x', memberId: 'a', issuerId: 'forged' }, { name: 'x'.repeat(101), memberId: 'a' }, { name: 'x', memberId: '../a' }]) assert.equal((await post('/api/issuance-sessions', body)).status, 400);
      const response = await post('/api/issuance-sessions', { name: 'Synthetic Member', memberId: 'member-42' });
      assert.equal(response.status, 201);
      const issued = await response.json();
      issuedSessionForOutage = issued.id;
      assert.match(issued.credentialId, /^urn:uuid:/);
      assert.ok(Date.parse(issued.expiresAt) > Date.now() + 3500_000);
      const info = await (await fetch(`${origin}/api/issuance-sessions/${issued.id}`, { headers: management })).json();
      assert.deepEqual(Object.keys(info).sort(), ['credentialAttempted', 'credentialId', 'expiresAt', 'id', 'state', 'tokenConsumed']);
      assert.equal(info.credentialId, issued.credentialId);
      assert.equal(info.expiresAt, issued.expiresAt);
      assert.equal(info.tokenConsumed, false);
      assert.equal(info.credentialAttempted, false);
      assert.equal((await fetch(`${origin}/api/issuance-sessions/${issued.id}`)).status, 401);
      assert.equal((await fetch(`${origin}/api/issuance-sessions/${randomUUID()}`, { headers: management })).status, 404);
    });
    await t.test('atomic grant and credential redemption across workers preserves winning state', async issuanceTest => {
      await startSecond();
      const issue = async () => { const response = await post('/api/issuance-sessions', { name: 'Synthetic Issued Member', memberId: 'race-member' }); assert.equal(response.status, 201); return await response.json() as { id: string; offer: string; credentialId: string; expiresAt: string }; };
      const info = async (id: string) => await (await fetch(`${origin}/api/issuance-sessions/${id}`, { headers: management })).json();
      const resolve = async (offer: string) => await (await fetch(new URL(offer).searchParams.get('credential_offer_uri')!.replace(configEnv.PUBLIC_URL, origin))).json();
      const token = async (issuer: string, code: string, port = apiPort, extra: Record<string, string> = {}) => fetch(`${issuer}/token`.replace(configEnv.PUBLIC_URL, `http://127.0.0.1:${port}`), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code', 'pre-authorized_code': code, ...extra }) });
      const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' });
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const proof = (issuer: string, nonce: string) => { const header = encode({ alg: 'ES256', typ: 'openid4vci-proof+jwt', jwk }); const payload = encode({ aud: issuer, nonce, iat: Math.floor(Date.now() / 1000) }); const input = `${header}.${payload}`; return `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`; };
      const credential = async (issuer: string, accessToken: string, body: unknown, port = apiPort) => fetch(`${issuer}/credential`.replace(configEnv.PUBLIC_URL, `http://127.0.0.1:${port}`), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` }, body: JSON.stringify(body) });
      const issued = await issue();
      const issuerService = application!.runtime.agent.dependencyManager.resolve(OpenId4VcIssuerService);
      const update = issuerService.updateState.bind(issuerService);
      let releaseOffer!: () => void, signalOffer!: () => void;
      const offerPause = new Promise<void>(resolve => { releaseOffer = resolve; });
      const offerStarted = new Promise<void>(resolve => { signalOffer = resolve; });
      let pauseFirst = true;
      issuerService.updateState = async (...args) => { if (args[2] === 'OfferUriRetrieved' && pauseFirst) { pauseFirst = false; signalOffer(); await offerPause; } return update(...args); };
      const delayedOffer = resolve(issued.offer);
      issuanceTest.after(async () => { releaseOffer(); issuerService.updateState = update; await delayedOffer.catch(() => {}); });
      await offerStarted;
      const offer = (await application!.runtime.agent.openid4vc.issuer.getIssuanceSessionById(issued.id)).credentialOfferPayload;
      const grant = offer.grants?.['urn:ietf:params:oauth:grant-type:pre-authorized_code']; assert.ok(grant);
      const issuer: string = offer.credential_issuer, code: string = grant['pre-authorized_code'];
      assert.equal((await token(issuer, 'wrong-code')).status, 400);
      assert.equal((await token(issuer, code, apiPort, { tx_code: 'unsupported' })).status, 400);
      assert.equal((await token(issuer, code, apiPort, { client_assertion: 'unsupported' })).status, 400);
      assert.equal((await token(issuer, code, apiPort, { grant_type: 'refresh_token' })).status, 400);
      const activeIssuer = await application!.runtime.agent.openid4vc.issuer.getIssuerByIssuerId(application!.runtime.identity.issuerId);
      const alternate = await application!.runtime.agent.openid4vc.issuer.createIssuer({ credentialConfigurationsSupported: activeIssuer.credentialConfigurationsSupported });
      const alternateOffer = await application!.runtime.agent.openid4vc.issuer.createCredentialOffer({ issuerId: alternate.issuerId, credentialConfigurationIds: ['membership'], version: 'v1', preAuthorizedCodeFlowConfig: {} });
      assert.equal((await fetch(`${origin}/api/issuance-sessions/${alternateOffer.issuanceSession.id}`, { headers: management })).status, 404);
      assert.equal((await token(`${configEnv.PUBLIC_URL}/issuer/${alternate.issuerId}`, code)).status, 404, 'An existing but inactive issuer cannot redeem the active issuer grant');
      const foreignGrant = alternateOffer.issuanceSession.credentialOfferPayload.grants?.['urn:ietf:params:oauth:grant-type:pre-authorized_code']; assert.ok(foreignGrant);
      const foreignResponse = await token(issuer, foreignGrant['pre-authorized_code']);
      assert.equal(foreignResponse.status, 400, 'A foreign issuer grant at the active endpoint is a protocol rejection');
      assert.equal((await foreignResponse.json()).error, 'invalid_grant');
      assert.equal((await application!.runtime.agent.openid4vc.issuer.getIssuanceSessionById(alternateOffer.issuanceSession.id)).state, 'OfferCreated');
      for (const claimedIssuer of [alternate.issuerId, application!.runtime.identity.issuerId]) assert.equal(await application!.runtime.agent.genericRecords.findById(`credspan:token-attempt:${claimedIssuer}:${alternateOffer.issuanceSession.id}`), null, 'Foreign grants must not burn either issuer claim');

      for (const suffix of ['TOKEN', 'token/', 'ToKeN/']) assert.equal((await fetch(`${issuer}/${suffix}`.replace(configEnv.PUBLIC_URL, origin), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', 'pre-authorized_code': code }) })).status, 400);
      assert.equal((await info(issued.id)).tokenConsumed, false);
      const responses = await Promise.all([token(issuer, code), token(issuer, code, secondPort)]);
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
      const tokenResponse = await responses.find(response => response.ok)!.json();
      assert.equal((await info(issued.id)).state, 'AccessTokenCreated');
      const body = { credential_configuration_id: 'membership', proofs: { jwt: [proof(issuer, tokenResponse.c_nonce)] } };
      assert.ok([401, 403].includes((await credential(issuer, 'invalid-token', body)).status));
      assert.equal((await credential(issuer, tokenResponse.access_token, { ...body, credentialId: 'forged' })).status, 400);
      assert.equal((await credential(issuer, tokenResponse.access_token, { credential_configuration_id: 'membership', proofs: { jwt: [body.proofs.jwt[0], body.proofs.jwt[0]] } })).status, 400);
      for (const suffix of ['CREDENTIAL', 'credential/', 'CrEdEnTiAl/']) assert.equal((await fetch(`${issuer}/${suffix}`.replace(configEnv.PUBLIC_URL, origin), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenResponse.access_token}` }, body: JSON.stringify({ ...body, credentialId: 'forged' }) })).status, 400);
      assert.equal((await info(issued.id)).credentialAttempted, false);
      const credentials = await Promise.all([credential(issuer, tokenResponse.access_token, body), credential(issuer, tokenResponse.access_token, body, secondPort)]);
      assert.deepEqual(credentials.map(response => response.status).sort(), [200, 400]);
      const result = await credentials.find(response => response.ok)!.json();
      assert.equal(result.credentials.length, 1);
      const compact = result.credentials[0].credential as string;
      const payload = decodeJwt(compact.split('~')[0]);
      assert.equal(payload.jti, issued.credentialId);
      assert.equal(new Date(Number(payload.exp) * 1000).toISOString(), issued.expiresAt);
      const disclosures = compact.split('~').slice(1).filter(Boolean).map(value => JSON.parse(Buffer.from(value, 'base64url').toString()));
      assert.ok(disclosures.some(value => value[1] === 'memberId' && value[2] === 'race-member'));
      assert.equal((await info(issued.id)).state, 'Completed', 'A stale losing endpoint catch must not overwrite the winning state');
      releaseOffer(); await delayedOffer; issuerService.updateState = update;
      assert.equal((await info(issued.id)).state, 'Completed', 'A delayed offer GET cannot overwrite a completed issuance');
      await stopSecond(); await startSecond();
      assert.equal((await token(issuer, code, secondPort)).status, 400);
      assert.equal((await credential(issuer, tokenResponse.access_token, body, secondPort)).status, 400);
      assert.equal((await info(issued.id)).state, 'Completed');
      const identityBefore = application!.runtime.identity;
      await stopSecond(); await application!.close(); application = undefined;
      await docker('restart', `${label}-pg`);
      await waitFor(async () => (await docker('exec', `${label}-pg`, 'pg_isready', '-U', 'credspan')).includes('accepting'));
      configEnv.POSTGRES_HOST = `127.0.0.1:${(await docker('port', `${label}-pg`, '5432/tcp')).split(':').at(-1)!}`;
      application = await createApplication(readConfig(configEnv));
      await application.app.listen(apiPort, '0.0.0.0');
      assert.deepEqual(application.runtime.identity, identityBefore);
      assert.equal((await info(issued.id)).credentialId, issued.credentialId);
      assert.equal((await info(issued.id)).tokenConsumed, true);
      assert.equal((await info(issued.id)).credentialAttempted, true);
      assert.equal((await token(issuer, code)).status, 400);
      assert.equal((await credential(issuer, tokenResponse.access_token, body)).status, 400);
      assert.equal((await info(issued.id)).state, 'Completed');
      const expired = await issue(), expiredOffer = await resolve(expired.offer);
      const expiredTokenResponse = await token(issuer, expiredOffer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']['pre-authorized_code']);
      assert.equal(expiredTokenResponse.status, 200); const expiredToken = await expiredTokenResponse.json();
      const expiredSession = await application.runtime.agent.openid4vc.issuer.getIssuanceSessionById(expired.id);
      expiredSession.issuanceMetadata!.expiresAt = Math.floor(Date.now() / 1000) - 1;
      await application.runtime.agent.dependencyManager.resolve(OpenId4VcIssuanceSessionRepository).update(application.runtime.agent.context, expiredSession);
      assert.equal((await credential(issuer, expiredToken.access_token, { credential_configuration_id: 'membership', proofs: { jwt: [proof(issuer, expiredToken.c_nonce)] } })).status, 400);
      assert.ok(Date.parse((await info(expired.id)).expiresAt) < Date.now());
      const failed = await issue(), failedOffer = await resolve(failed.offer);
      const failedCode = failedOffer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']['pre-authorized_code'];
      const failedTokenResponse = await token(issuer, failedCode); assert.equal(failedTokenResponse.status, 200);
      const failedToken = await failedTokenResponse.json();
      const goodProof = proof(issuer, failedToken.c_nonce);
      const pieces = goodProof.split('.'); pieces[2] = (pieces[2][0] === 'A' ? 'B' : 'A') + pieces[2].slice(1);
      assert.equal((await credential(issuer, failedToken.access_token, { credential_configuration_id: 'membership', proofs: { jwt: [pieces.join('.')] } })).status, 400);
      assert.equal((await info(failed.id)).credentialAttempted, true);
      assert.equal((await credential(issuer, failedToken.access_token, { credential_configuration_id: 'membership', proofs: { jwt: [goodProof] } })).status, 400, 'Post-claim proof failure requires a fresh issuance offer');
      const ambiguous = await issue(), ambiguousOffer = await resolve(ambiguous.offer);
      const service = application!.runtime.agent.dependencyManager.resolve(OpenId4VcIssuerService);
      const nonce = service.createNonce;
      service.createNonce = async () => { throw Error('Synthetic failure after token claim'); };
      try { assert.equal((await token(issuer, ambiguousOffer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']['pre-authorized_code'])).status, 500); } finally { service.createNonce = nonce; }
      assert.equal((await info(ambiguous.id)).tokenConsumed, true);
      assert.equal((await token(issuer, ambiguousOffer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']['pre-authorized_code'])).status, 400);
      await stopSecond();
    });
    await t.test('delayed presentation-request GET cannot overwrite ResponseVerified', async requestTest => {
      const flow = await create();
      const service = application!.runtime.agent.dependencyManager.resolve(OpenId4VpVerifierService);
      const update = service.updateState.bind(service);
      let release!: () => void, started!: () => void;
      const pause = new Promise<void>(resolve => { release = resolve; });
      const reached = new Promise<void>(resolve => { started = resolve; });
      let first = true;
      service.updateState = async (...args) => { if (args[2] === 'RequestUriRetrieved' && first) { first = false; started(); await pause; } return update(...args); };
      const pending = fetch(new URL(flow.request).searchParams.get('request_uri')!.replace(configEnv.PUBLIC_URL, origin));
      requestTest.after(async () => { release(); service.updateState = update; await pending.catch(() => {}); });
      await reached;
      assert.equal((await walletPost(`/wallet/${walletId}/credentials/present`, { requestUrl: flow.request })).transmission_success, true);
      release(); assert.equal((await pending).status, 200); service.updateState = update;
      assert.equal((await status(flow.sessionId)).cryptographicState, 'ResponseVerified');
    });
    await t.test('HTTP rejects holder-resigned disclosure attacks, wrong binding, expiry and unknown issuer', async () => {
      const agent = application!.runtime.agent;
      const [own] = await agent.dids.getCreatedDids({ method: 'key' });
      const ownDocument = await agent.dids.resolveDidDocument(own.did);
      const issuerKid = ownDocument.verificationMethod![0].id;
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const publicJwk = publicKey.export({ format: 'jwk' });
      const holder = Kms.PublicJwk.fromPublicJwk({ kty: 'EC', crv: 'P-256', x: publicJwk.x!, y: publicJwk.y! });
      const credentialId = `urn:uuid:${randomUUID()}`;
      const index = await application!.runtime.policy.allocate(credentialId);
      const profile = { vct: 'urn:credspan:sandbox-membership', memberId: 'sandbox-member', jti: credentialId, exp: Math.floor(Date.now() / 1000) + 3600, status: { status_list: { idx: index, uri: application!.runtime.policy.uri } } };
      const credential = await agent.sdJwtVc.sign({ payload: { ...profile, name: 'Synthetic Member', optional: 'omit me' }, holder: { method: 'jwk', jwk: holder }, issuer: { method: 'did', didUrl: issuerKid }, disclosureFrame: { _sd: ['name', 'optional'] } });
      const parts = credential.compact.split('~').filter(Boolean);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const disclosure = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      const nameDisclosure = parts.slice(1).find(value => JSON.parse(Buffer.from(value, 'base64url').toString())[1] === 'name')!;
      async function attempt(name: string, pieces: string[], accepted: boolean, binding: Record<string, unknown> = {}) {
        const flow = await create(), request = await requestData(flow);
        const sd = [...pieces, ''].join('~');
        const header = encode({ alg: 'ES256', typ: 'kb+jwt' });
        const payload = encode({ aud: request.client_id, nonce: request.nonce, iat: Math.floor(Date.now() / 1000), sd_hash: createHash('sha256').update(sd).digest('base64url'), ...binding });
        const signingInput = `${header}.${payload}`;
        const kb = `${signingInput}.${sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
        const response = await envelope(request, { state: request.state, vp_token: { membership: [sd + kb] } });
        assert.equal((await submit(request.response_uri, response)).status, accepted ? 200 : 400, name);
      }
      await attempt('valid full disclosure', parts, true);
      await attempt('valid selective omission', [parts[0], nameDisclosure], true);
      disclosure[2] = 'tampered';
      await attempt('tampered disclosure with recomputed sd_hash and fresh holder signature', [parts[0], encode(disclosure), ...parts.slice(2)], false);
      await attempt('unreferenced disclosure with valid holder binding', [...parts, encode(['salt', 'forged', 'value'])], false);
      await attempt('duplicate disclosure', [...parts, parts[1]], false);
      await attempt('malformed disclosure', [...parts, encode(['invalid'])], false);
      await attempt('wrong audience', parts, false, { aud: 'urn:another-verifier' });
      await attempt('wrong nonce', parts, false, { nonce: 'wrong-nonce' });
      const originalResolve = WebDidResolver.prototype.resolve;
      let remoteResolutions = 0;
      WebDidResolver.prototype.resolve = async () => { remoteResolutions++; throw Error('Remote DID resolution sentinel'); };
      try {
        const jwt = parts[0].split('.');
        const payload = JSON.parse(Buffer.from(jwt[1], 'base64url').toString());
        // A forged issuer signature must not permit fetching an attacker-controlled holder DID.
        const forgedHolder = [jwt[0], encode({ ...payload, cnf: { kid: 'did:web:127.0.0.1%3A1#key' } }), jwt[2]].join('.');
        await attempt('remote holder DID in forged credential', [forgedHolder, ...parts.slice(1)], false);
        const forgedIssuer = [jwt[0], encode({ ...payload, iss: 'did:web:127.0.0.1%3A1' }), jwt[2]].join('.');
        await attempt('untrusted remote issuer DID', [forgedIssuer, ...parts.slice(1)], false);
        assert.equal(remoteResolutions, 0, 'Unverified credential data must not trigger remote DID resolution');
      } finally { WebDidResolver.prototype.resolve = originalResolve; }

      const expired = await agent.sdJwtVc.sign({ payload: { ...profile, name: 'Synthetic', exp: Math.floor(Date.now() / 1000) - 120 }, holder: { method: 'jwk', jwk: holder }, issuer: { method: 'did', didUrl: issuerKid } });
      for (const [label, payload, disclosureFrame] of [
        ['wrong credential type', { ...profile, vct: 'urn:example:other-membership' }, undefined],
        ['alias does not widen local credential type policy', { ...profile, vct: 'urn:example:other-membership', aka_vcts: [profile.vct] }, undefined],
        ['missing required status', { ...profile, status: undefined }, undefined],
        ['unapproved status URI', { ...profile, status: { status_list: { idx: index, uri: 'http://127.0.0.1:1/forbidden' } } }, undefined],
        ['selectively disclosed status', profile, { _sd: ['status'] }],
        ['missing required expiry', { ...profile, exp: undefined }, undefined],
      ] as const) {
        if (disclosureFrame) {
          const hidden = encode(['synthetic-salt', 'status', profile.status]);
          const signed = decodeJwt(parts[0]); delete signed.status;
          signed._sd = [...signed._sd as string[], createHash('sha256').update(hidden).digest('base64url')];
          const input = `${parts[0].split('.')[0]}.${encode(signed)}`;
          const signature = await agent.kms.sign({ keyId: application!.runtime.identity.keyId, algorithm: 'EdDSA', data: Buffer.from(input) });
          await attempt(label, [`${input}.${Buffer.from(signature.signature).toString('base64url')}`, ...parts.slice(1), hidden], false);
        } else {
          const invalid = await agent.sdJwtVc.sign({ payload: { ...payload, name: 'Synthetic' }, holder: { method: 'jwk', jwk: holder }, issuer: { method: 'did', didUrl: issuerKid } });
          assert.deepEqual(decodeJwt(invalid.compact.split('~')[0]).aka_vcts, 'aka_vcts' in payload ? payload.aka_vcts : undefined);
          await attempt(label, invalid.compact.split('~').filter(Boolean), false);
        }
      }
      await attempt('expired credential', expired.compact.split('~').filter(Boolean), false);
      const { keyId } = await agent.kms.createKey({ type: { kty: 'OKP', crv: 'Ed25519' } });
      const unknown = await agent.dids.create({ method: 'key', options: { keyId } });
      if (unknown.didState.state !== 'finished') throw Error('Test DID generation failed');
      const unknownCredential = await agent.sdJwtVc.sign({ payload: { ...profile, name: 'Synthetic' }, holder: { method: 'jwk', jwk: holder }, issuer: { method: 'did', didUrl: unknown.didState.didDocument.verificationMethod![0].id } });
      await attempt('unknown issuer', unknownCredential.compact.split('~').filter(Boolean), false);
      assert.equal(pexCalls, 0);
    });
    await t.test('presentation API verifies signed status, refreshes historical receipts, and revokes idempotently', async () => {
      const issuedResponse = await post('/api/issuance-sessions', { name: 'Status Member', memberId: 'status-member' });
      assert.equal(issuedResponse.status, 201); const issued = await issuedResponse.json();
      const received = await walletPost(`/wallet/${walletId}/credentials/receive`, { offerUrl: issued.offer, keyId });
      const present = async () => {
        const response = await post('/api/presentation-requests', {}); assert.equal(response.status, 201);
        const flow = await response.json();
        const request = await requestData({ ...flow, sessionId: flow.id });
        const built = await walletPost(`/wallet/${walletId}/credentials/present/build-vp-token`, { requestUrl: flow.request, selectedCredentialIds: { membership: received.credentialIds } });
        const vp = typeof built.vpToken === 'string' ? JSON.parse(built.vpToken) : built.vpToken;
        const encrypted = await envelope(request, { state: request.state, vp_token: vp });
        return { flow, request, encrypted, compact: vp.membership[0] as string };
      };
      const result = async (id: string) => { const response = await fetch(`${origin}/api/presentation-requests/${id}/result`, { headers: management }); assert.equal(response.status, 200); return await response.json(); };
      assert.equal((await post('/api/presentation-requests', { claims: ['name'] })).status, 400);
      assert.equal((await post('/api/presentation-requests', {}, { 'content-type': 'application/json' })).status, 401);
      const first = await present();
      assert.equal('name' in application!.runtime.agent.sdJwtVc.fromCompact(first.compact).prettyClaims, false, 'Default DCQL requests memberId without disclosing name');
      assert.equal((await result(first.flow.id)).accepted, false);
      assert.equal((await submit(first.request.response_uri, first.encrypted)).status, 200);
      presentationForOutage = first.flow.id;
      const accepted = await result(first.flow.id);
      assert.equal(accepted.accepted, true); assert.equal(accepted.memberId, 'status-member'); assert.equal(accepted.credentialId, issued.credentialId);
      assert.equal('name' in accepted, false); assert.equal('vp_token' in accepted, false);
      assert.ok(accepted.verifiedAt && accepted.checkedAt && accepted.authorizationExpiresAt);
      assert.equal((await submit(first.request.response_uri, first.encrypted)).status, 400);
      const policy = application!.runtime.policy;
      const original = policy.statusToken;
      const fresh = await original();
      const decoded = decodeJwt(fresh); assert.equal(decoded.sub, policy.uri); assert.equal(decoded.ttl, 30);
      const publicResponse = await fetch(origin + new URL(policy.uri).pathname);
      assert.equal(publicResponse.status, 200); assert.equal(publicResponse.headers.get('content-type')?.split(';')[0], 'application/statuslist+jwt');
      const foreign = await application!.runtime.agent.kms.createKey({ type: { kty: 'OKP', crv: 'Ed25519' } });
      const foreignDid = await application!.runtime.agent.dids.create({ method: 'key', options: { keyId: foreign.keyId } });
      if (foreignDid.didState.state !== 'finished') throw Error('Foreign signer creation failed');
      const foreignKid = foreignDid.didState.didDocument.verificationMethod![0].id;
      const foreignInput = [Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'statuslist+jwt', kid: foreignKid })).toString('base64url'), fresh.split('.')[1]].join('.');
      const foreignSignature = await application!.runtime.agent.kms.sign({ keyId: foreign.keyId, algorithm: 'EdDSA', data: Buffer.from(foreignInput) });
      const impersonation = `${foreignInput}.${Buffer.from(foreignSignature.signature).toString('base64url')}`;
      assert.equal(decodeJwt(impersonation).iss, application!.runtime.identity.did, 'Foreign-key fixture spoofs the expected issuer');
      const failures = [
        async () => impersonation,
        async () => new Promise<string>(() => {}),
        async () => { throw Error('Synthetic status unavailable'); },
        async () => { const parts = fresh.split('.'); const payload = decodeJwt(fresh); parts[1] = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) - 60 })).toString('base64url'); return parts.join('.'); },
        async () => { const parts = fresh.split('.'); parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1); return parts.join('.'); },
      ];
      await assert.rejects(application!.runtime.agent.config.agentDependencies.fetch('http://127.0.0.1:1/unapproved'), /Only the configured/);
      for (const failure of failures) {
        const pending = await present();
        policy.statusToken = failure;
        try { const rejected = await result(first.flow.id); assert.equal(rejected.accepted, false); assert.equal(rejected.verifiedAt, accepted.verifiedAt); assert.equal((await submit(pending.request.response_uri, pending.encrypted)).status, 400); }
        finally { policy.statusToken = original; }
      }
      assert.equal((await result(first.flow.id)).accepted, true);
      const api = application!.runtime.agent.sdJwtVc as { verify: (options: Parameters<SdJwtVcApi['verify']>[0]) => ReturnType<SdJwtVcApi['verify']> };
      const verify = api.verify.bind(api), clock = Date.now;
      api.verify = async options => { const verified = await verify(options); Date.now = () => Date.parse(accepted.authorizationExpiresAt) + 1; return verified; };
      try { assert.equal((await result(first.flow.id)).accepted, false, 'Deadline crossed during awaited verification cannot accept'); }
      finally { api.verify = verify; Date.now = clock; }
      api.verify = async options => { const verified = await verify(options); Date.now = () => Date.parse(accepted.expiresAt) + 1; return verified; };
      try { assert.equal((await result(first.flow.id)).accepted, false, 'Credential expiry crossed during verification cannot accept'); }
      finally { api.verify = verify; Date.now = clock; }
      const expiring = await present();
      const session = await application!.runtime.agent.openid4vc.verifier.getVerificationSessionById(expiring.flow.id);
      session.expiresAt = new Date(Date.now() + 1000);
      await application!.runtime.agent.dependencyManager.resolve(OpenId4VcVerificationSessionRepository).update(application!.runtime.agent.context, session);
      let calls = 0;
      api.verify = async options => { const verified = await verify(options); if (++calls === 2) Date.now = () => session.expiresAt!.getTime() + 1; return verified; };
      try { assert.equal((await submit(expiring.request.response_uri, expiring.encrypted)).status, 400); }
      finally { api.verify = verify; Date.now = clock; }
      assert.equal(await application!.runtime.agent.genericRecords.findById(`credspan:verification-receipt:${expiring.flow.id}`), null);
      const lateCredential = await present();
      const lateSession = await application!.runtime.agent.openid4vc.verifier.getVerificationSessionById(lateCredential.flow.id);
      const credentialDeadline = Number(decodeJwt(lateCredential.compact.split('~')[0]).exp) * 1000;
      lateSession.expiresAt = new Date(credentialDeadline + 60_000);
      const sessions = application!.runtime.agent.dependencyManager.resolve(OpenId4VcVerificationSessionRepository);
      await sessions.update(application!.runtime.agent.context, lateSession);
      const persist = OpenId4VcVerificationSessionRepository.prototype.update;
      let crossedDeadline = false;
      OpenId4VcVerificationSessionRepository.prototype.update = async function (context, record) {
        await persist.call(this, context, record);
        if (record.id === lateSession.id && record.state === 'ResponseVerified') { crossedDeadline = true; Date.now = () => credentialDeadline + 1; }
      };
      let lateResponse: Response;
      try { lateResponse = await submit(lateCredential.request.response_uri, lateCredential.encrypted); }
      finally { OpenId4VcVerificationSessionRepository.prototype.update = persist; Date.now = clock; }
      assert.equal(crossedDeadline, true, 'Regression must cross expiry after actual final persistence');
      assert.equal(lateResponse.status, 400, 'Credential expiry during final state persistence must prevent HTTP success');
      await startSecond({ TRUSTED_ISSUER_DIDS: '[]' });
      const denied = await fetch(`http://127.0.0.1:${secondPort}/api/presentation-requests/${first.flow.id}/result`, { headers: management });
      assert.equal((await denied.json()).accepted, false, 'Explicit empty trust configuration denies previously accepted credential');
      await stopSecond(); await startSecond();
      const allocated = await Promise.all(Array.from({ length: 8 }, (_, index) => fetch(`http://127.0.0.1:${index % 2 ? secondPort : apiPort}/api/issuance-sessions`, { method: 'POST', headers: management, body: JSON.stringify({ name: 'Concurrent', memberId: `member-${index}` }) }).then(async response => { assert.equal(response.status, 201); return await response.json(); })));
      const records = await Promise.all(allocated.map(value => application!.runtime.policy.credential(value.credentialId)));
      assert.equal(new Set(records.map(record => record.content.index)).size, allocated.length);
      const revoked = await Promise.all([...allocated, issued].map((value, index) => fetch(`http://127.0.0.1:${index % 2 ? secondPort : apiPort}/api/credentials/${value.credentialId}/revoke`, { method: 'POST', headers: management, body: '{}' })));
      assert.ok(revoked.every(response => response.status === 201));
      assert.equal((await post(`/api/credentials/${issued.credentialId}/revoke`, {})).status, 201);
      assert.equal((await post(`/api/credentials/urn:uuid:${randomUUID()}/revoke`, {})).status, 404);
      const after = await result(first.flow.id); assert.equal(after.accepted, false); assert.equal(after.verifiedAt, accepted.verifiedAt);
      const next = await present(); assert.equal((await submit(next.request.response_uri, next.encrypted)).status, 400);
      await stopSecond(); await startSecond();
      const persisted = await fetch(`http://127.0.0.1:${secondPort}/api/presentation-requests/${first.flow.id}/result`, { headers: management });
      assert.equal(persisted.status, 200); const persistedResult = await persisted.json(); assert.equal(persistedResult.accepted, false); assert.equal(persistedResult.verifiedAt, accepted.verifiedAt);
      const signedSnapshot = decodeJwt(await policy.statusToken());
      const bits = inflateSync(Buffer.from((signedSnapshot.status_list as { lst: string }).lst, 'base64url'), { maxOutputLength: 128 });
      assert.equal(bits.length, 128);
      for (const record of records) assert.equal((bits[Math.floor(Number(record.content.index) / 8)] >> (Number(record.content.index) % 8)) & 1, 1, 'Signed snapshot retains every concurrent revocation');
      for (const record of records) assert.ok(await application!.runtime.agent.genericRecords.findById(`credspan:revocation:${application!.runtime.policy.cohort}:${record.content.index}`));
      await stopSecond(); await application!.close(); application = undefined;
      await docker('restart', `${label}-pg`);
      await waitFor(async () => (await docker('exec', `${label}-pg`, 'pg_isready', '-U', 'credspan')).includes('accepting'));
      configEnv.POSTGRES_HOST = `127.0.0.1:${(await docker('port', `${label}-pg`, '5432/tcp')).split(':').at(-1)!}`;
      application = await createApplication(readConfig(configEnv)); await application.app.listen(apiPort, '0.0.0.0');
      const restarted = await result(first.flow.id); assert.equal(restarted.accepted, false); assert.equal(restarted.verifiedAt, accepted.verifiedAt);
      const restartedBits = inflateSync(Buffer.from((decodeJwt(await application.runtime.policy.statusToken()).status_list as { lst: string }).lst, 'base64url'), { maxOutputLength: 128 });
      assert.deepEqual(restartedBits, bits, 'PostgreSQL and application restart preserve every signed revocation bit');
    });
    await t.test('stable identity references survive unrelated records and fail closed when missing', async () => {
      await startSecond(); await stopSecond();
      const agent = application!.runtime.agent;
      const record = await agent.genericRecords.findById(IDENTITY_RECORD); assert.ok(record);
      const didCount = (await agent.dids.getCreatedDids({ method: 'key' })).length;
      const issuerCount = (await agent.openid4vc.issuer.getAllIssuers()).length;
      const expectStartupFailure = async (env = configEnv) => {
        const child = spawn(process.execPath, [new URL('../src/main.js', import.meta.url).pathname], { env: { ...env, PORT: String(secondPort) }, stdio: 'ignore' });
        const [code] = await once(child, 'exit'); assert.equal(code, 1);
      };
      await expectStartupFailure({ ...configEnv, PUBLIC_URL: `http://host.docker.internal:${secondPort}` });
      await agent.genericRecords.deleteById(IDENTITY_RECORD);
      try { await expectStartupFailure(); } finally { await agent.genericRecords.save({ id: IDENTITY_RECORD, content: record.content }); }
      assert.equal((await agent.dids.getCreatedDids({ method: 'key' })).length, didCount);
      assert.equal((await agent.openid4vc.issuer.getAllIssuers()).length, issuerCount);
      await agent.kms.deleteKey({ keyId: application!.runtime.identity.keyId });
      await expectStartupFailure();
      assert.deepEqual((await agent.genericRecords.findById(IDENTITY_RECORD))?.content, record.content);
      assert.equal((await agent.dids.getCreatedDids({ method: 'key' })).length, didCount);
    });
    await t.test('storage unavailable fails closed before verification', async () => {
      const context: AgentContext = application!.runtime.agent.context;
      await docker('stop', `${label}-pg`);
      assert.equal((await fetch(`${origin}/api/issuance-sessions/${issuedSessionForOutage}`, { headers: management })).status, 503);
      assert.equal((await fetch(`${origin}/api/presentation-requests/${presentationForOutage}/result`, { headers: management })).status, 503);
      await assert.rejects(claimVerification(context, randomUUID(), randomUUID()), /Unable to reserve/);
      await application!.close(); application = undefined;
    });
    assert.equal(pexCalls, 0);
  } finally {
    for (const [name, original] of Object.entries(originals)) pex[name] = original;
    await stopSecond();
    if (application) await application.close();
    await docker('rm', '-f', '-v', `${label}-wallet`, `${label}-pg`).catch(() => {});
    await docker('volume', 'rm', `${label}-wallet-data`, `${label}-wallet-clone`).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
