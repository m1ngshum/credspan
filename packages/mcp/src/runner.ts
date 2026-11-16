// Fixed synthetic child. It never inherits active deployment credentials and never prints capabilities.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './profile.js';
import type { Stage } from './sandbox.js';
const [directory, name, deploymentId, scenario, image] = process.argv.slice(2);
const stage = (stage: Stage) => process.send?.({ type: 'stage', stage });
async function port() { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const value = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return value; }
async function wait(check: () => Promise<boolean>) { const until = Date.now() + 20000; while (Date.now() < until) { try { if (await check()) return; } catch {} await delay(200); } throw Error('Readiness failed'); }
async function post(base: string, path: string, body: unknown, key?: string) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
  assert.ok(response.ok, 'Synthetic request failed'); return response.json();
}
try {
  assert.ok(['membership-roundtrip', 'revocation'].includes(scenario));
  const { init, provision, compose, secret } = await import(pathToFileURL(join(root, 'ops/local.mjs')).href);
  const project = await init(join(directory, 'project'), { name, deploymentId, port: await port(), image });
  const images = JSON.parse(await readFile(join(root, 'ops/images.json'), 'utf8'));
  const path = join(project.directory, 'compose.yaml');
  let text = await readFile(path, 'utf8');
  for (const ref of [images.postgres, images.caddy]) text = text.replace(`    image: ${ref}\n`, `    image: ${ref}\n    pull_policy: never\n`);
  await writeFile(path, text, { mode: 0o600 });
  stage('initialized'); await provision(project); stage('provisioned');
  compose(project, ['--profile', 'holder', 'up', '-d', '--wait', '--pull', 'never', 'api', 'edge', 'wallet']); stage('running');
  const base = `http://127.0.0.1:${project.port}`, wallet = 'http://' + compose(project, ['port', 'wallet', '7006']);
  await wait(async () => (await fetch(wallet + '/livez', { signal: AbortSignal.timeout(1000) })).ok);
  const key = await secret(project, 'management_key');
  const issued = await post(base, '/api/issuance-sessions', { name: 'Synthetic MCP member', memberId: 'mcp-synthetic' }, key);
  assert.equal(new URL(new URL(issued.offer).searchParams.get('credential_offer_uri')!).host, `host.docker.internal:${project.port}`);
  const { walletId } = await post(wallet, '/wallet', {}), { keyId } = await post(wallet, `/wallet/${walletId}/keys/generate`, { backend: 'jwk', keyType: 'secp256r1' });
  const received = await post(wallet, `/wallet/${walletId}/credentials/receive`, { offerUrl: issued.offer, keyId }); assert.equal(received.credentialIds.length, 1); stage('held');
  const request = await post(base, '/api/presentation-requests', {}, key);
  assert.equal(new URL(new URL(request.request).searchParams.get('request_uri')!).host, `host.docker.internal:${project.port}`);
  assert.equal((await post(wallet, `/wallet/${walletId}/credentials/present`, { requestUrl: request.request })).transmission_success, true);
  const result = async () => { const response = await fetch(base + `/api/presentation-requests/${request.id}/result`, { headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(10000) }); assert.ok(response.ok); return response.json(); };
  const accepted = await result(); assert.equal(accepted.accepted, true); stage('verified');
  const checks = ['issued', 'held', 'presented', 'accepted'];
  if (scenario === 'revocation') {
    assert.equal((await post(base, `/api/credentials/${issued.credentialId}/revoke`, {}, key)).revoked, true);
    const denied = await result(); assert.equal(denied.accepted, false); assert.equal(denied.verifiedAt, accepted.verifiedAt); stage('revoked'); checks.push('revoked', 'not-accepted-after-revocation');
  }
  stage('complete'); await new Promise<void>((resolve, reject) => process.send?.({ type: 'result', checks }, error => error ? reject(error) : resolve()));
} catch { process.exitCode = 1; }
finally { process.disconnect?.(); }
