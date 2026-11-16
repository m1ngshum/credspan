import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { init, load, compose, down, startPostgres, docker, secret, provision, rotate, backup, recover, roles, psql, control, withLock, syncPrivate } from './local.mjs';
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function wait(check) { for (let i = 0; i < 150; i++) { try { if (await check()) return; } catch {} await delay(200); } throw Error('Synthetic readiness timed out'); }
const post = async (base, path, body, key) => {
  const last = path.split('/').at(-1);
  const operation = ['receive', 'present', 'generate', 'revoke', 'token', 'credential', 'issuance-sessions', 'presentation-requests', 'wallet'].includes(last) ? last : 'request';
  let response;
  try {
    response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok); return await response.json();
  } catch (error) { throw Error(`Synthetic ${operation} ${error?.name === 'TimeoutError' ? 'timeout' : response ? `HTTP ${response.status} response failure` : 'transport failure'}`); }
};
async function holder(project) {
  compose(project, ['--profile', 'holder', 'up', '-d', 'wallet']);
  const base = 'http://' + compose(project, ['port', 'wallet', '7006']); await wait(async () => (await fetch(base + '/livez')).ok);
  const { walletId } = await post(base, '/wallet', {}), { keyId } = await post(base, `/wallet/${walletId}/keys/generate`, { backend: 'jwk', keyType: 'secp256r1' });
  return { base, walletId, keyId, receive: offer => post(base, `/wallet/${walletId}/credentials/receive`, { offerUrl: offer, keyId }), present: request => post(base, `/wallet/${walletId}/credentials/present`, { requestUrl: request }) };
}
async function api(project) {
  const base = `http://127.0.0.1:${project.port}`, key = await secret(project, 'management_key');
  return { base, key, issue: memberId => post(base, '/api/issuance-sessions', { name: 'Synthetic operations', memberId }, key), request: () => post(base, '/api/presentation-requests', {}, key), result: async id => { const response = await fetch(base + `/api/presentation-requests/${id}/result`, { headers: { authorization: 'Bearer ' + key } }); assert.equal(response.status, 200); return response.json(); }, revoke: id => post(base, `/api/credentials/${id}/revoke`, {}, key) };
}
const volumes = project => [project.controlVolume, project.runtimeVolume, project.maintenanceVolume];

test('real local edge, least privilege, stale worker, authenticated restore and independent wallet recovery', { timeout: 420000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-operations-')); await chmod(directory, 0o700);
  const suffix = randomBytes(4).toString('hex'), image = docker(['image', 'inspect', 'credspan-api:local', '--format', '{{.Id}}']);
  const projects = [], privateVolumes = new Set(); let stale, originalFailure, stage = 'provision';
  const remember = project => { for (const name of volumes(project)) privateVolumes.add(name); };
  try {
    const source = await init(join(directory, 'source'), { name: 'credspan-probe-ops-' + suffix, port: await freePort(), image }); projects.push(source); remember(source);
    assert.match(source.deploymentId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    await provision(source); compose(source, ['up', '-d', '--wait', 'api', 'edge']);
    const client = await api(source), wallet = await holder(source);
    await t.test('nonowner role, private mounts, exact ownership and Host/Origin boundary', async () => {
      const role = psql(source, "SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname='credspan_runtime';"); assert.equal(role, 'f|f|f|f');
      assert.equal(psql(source, `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='${source.storeId}';`), 'credspan_owner');
      const apiId = compose(source, ['ps', '-q', 'api']), pgId = compose(source, ['ps', '-q', 'postgres']);
      for (const id of [apiId, pgId]) assert.ok(Object.values(JSON.parse(docker(['inspect', id, '--format', '{{json .NetworkSettings.Ports}}']))).every(value => value === null));
      assert.equal(docker(['exec', apiId, 'node', '-e', 'console.log(process.getuid())']), String(source.uid));
      assert.equal(docker(['exec', apiId, 'node', '-e', "const fs=require('fs');console.log(['/bin/mount','/bin/umount','/usr/bin/nsenter','/usr/bin/infocmp','/usr/local/bin/npm'].every(p=>!fs.existsSync(p)))"]), 'true');
      const restrictions = JSON.parse(docker(['inspect', apiId, '--format', '{{json .HostConfig}}']));
      assert.equal(restrictions.ReadonlyRootfs, true); assert.deepEqual(restrictions.CapDrop, ['ALL']); assert.ok(restrictions.SecurityOpt.includes('no-new-privileges:true'));
      assert.equal(docker(['exec', apiId, 'node', '-e', "const fs=require('fs');const s=fs.statSync('/run/secrets/store_key');process.stdout.write(JSON.stringify({uid:s.uid,mode:s.mode&511}))"]), JSON.stringify({ uid: source.uid, mode: 384 }));
      // Native runtime succeeds with observed-table DML; SQL permission predicates prove forbidden DDL/admin access.
      assert.equal(psql(source, "SELECT has_schema_privilege('credspan_runtime','credspan_owner','CREATE'),has_table_privilege('credspan_runtime','credspan_owner.config','UPDATE');", source.storeId), 'f|f');
      const runtimePassword = await secret(source, 'runtime_password');
      for (const sql of ['CREATE TABLE credspan_owner.forbidden(value text);', 'CREATE DATABASE forbidden_runtime_database;', 'SET ROLE credspan_owner;']) {
        assert.throws(() => docker(['exec', '-i', pgId, 'sh', '-c', 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql --no-psqlrc -v ON_ERROR_STOP=1 -h localhost -U credspan_runtime -d "$1"', 'sh', source.storeId], { input: runtimePassword + '\n' + sql }));
      }
      const hostileHost = await new Promise((resolve, reject) => { const request = httpRequest(client.base + '/api/issuance-sessions', { method: 'POST', headers: { host: 'untrusted.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); request.end(); }); assert.ok(hostileHost >= 400);
      assert.equal(docker(['exec', apiId, 'node', '-e', "require('http').request('http://127.0.0.1:3000/api/issuance-sessions',{method:'POST',headers:{host:'untrusted.invalid'}},r=>{r.resume();console.log(r.statusCode)}).end()"]), '421');
      assert.equal((await fetch(client.base + '/api/issuance-sessions', { method: 'POST', headers: { origin: 'http://untrusted.invalid', authorization: 'Bearer ' + client.key, 'content-type': 'application/json' }, body: '{}' })).status, 403);
      assert.equal((await fetch(client.base + '/console/', { headers: { origin: client.base } })).status, 200);
      await assert.rejects(init(join(directory, 'collision'), { name: source.name, port: source.port, image }), /another deployment/);
      await withLock(source, 'test', async () => { await assert.rejects(withLock(source, 'test', async () => {}), /EEXIST/); });
    });
    stage = 'initial-wallet-journey';
    const issued = await client.issue('ops-member'); assert.equal((await wallet.receive(issued.offer)).credentialIds.length, 1);
    const request = await client.request(); assert.equal((await wallet.present(request.request)).transmission_success, true); assert.equal((await client.result(request.id)).accepted, true);
    const measurements = [];
    for (let i = 0; i < 20; i++) { const start = performance.now(); assert.equal((await client.result(request.id)).accepted, true); measurements.push(performance.now() - start); }
    measurements.sort((a, b) => a - b);
    console.log(JSON.stringify({ benchmark: 'signed-status-and-holder-proof-result-read', samples: 20, concurrency: 1, p50Ms: +measurements[9].toFixed(2), p95Ms: +measurements[18].toFixed(2), image, architecture: docker(['image', 'inspect', image, '--format', '{{.Architecture}}']), memory: docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', compose(source, ['ps', '-q', 'api'])]) }));
    // Backup precedes later grant consumption/revocation: restoring it must not resurrect either.
    stage = 'pre-recovery-backup';
    const grant = await client.issue('post-backup-consumer'), pending = await client.request();
    const offerUri = new URL(grant.offer).searchParams.get('credential_offer_uri');
    const offerBody = await (await fetch(offerUri.replace(`host.docker.internal:${source.port}`, `127.0.0.1:${source.port}`))).json();
    const grantCode = offerBody.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']['pre-authorized_code'];
    const issuer = offerBody.credential_issuer;
    const generation = JSON.parse(await readFile(join(source.controlDirectory, 'generation.json'))).generation;
    psql(source, 'CREATE SCHEMA unrelated AUTHORIZATION credspan_owner; CREATE TABLE unrelated.sentinel(value text); ALTER TABLE unrelated.sentinel OWNER TO credspan_owner; INSERT INTO unrelated.sentinel VALUES(\'preserve\');', source.storeId);
    const archive = join(directory, 'before-redemption.enc'); await backup(source, archive);
    const token = await post(client.base, new URL(issuer).pathname + '/token', { grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code', 'pre-authorized_code': grantCode });
    await client.revoke(issued.credentialId); assert.equal((await client.result(request.id)).accepted, false);
    stage = 'paused-native-write-retirement';
    await t.test('paused real native INSERT cannot reconnect after retirement; stale HTTP stays fenced', async () => {
      const worker = (await readFile(new URL('./paused-worker.mjs', import.meta.url), 'utf8')).replace('const storage =', "await application.app.listen(3000,'0.0.0.0');\nconst storage =");
      stale = compose(source, ['run', '-d', '--no-deps', 'api', 'node', '--input-type=module', '-e', worker]);
      await wait(() => docker(['exec', stale, 'node', '-e', "process.stdout.write(require('fs').readFileSync('/tmp/paused','utf8'))"]) === 'ready');
      await rotate(source, 'retire'); remember(source);
      const status = docker(['exec', stale, 'node', '-e', "fetch('http://127.0.0.1:3000/api/issuance-sessions',{method:'POST'}).then(r=>console.log(r.status))"]); assert.equal(status, '503');
      docker(['exec', stale, 'node', '-e', "require('fs').writeFileSync('/tmp/resume','')"]); let outcome;
      await wait(() => { outcome = JSON.parse(docker(['exec', stale, 'node', '-e', "process.stdout.write(require('fs').readFileSync('/tmp/result','utf8'))"])); return true; });
      assert.equal(outcome.attempted, true); assert.equal(outcome.nativeWriteSucceeded, false); assert.equal(outcome.accepted, false);
      assert.match(outcome.allocationId, /^credspan:status-index:[a-f0-9-]{36}:\d+$/);
      const absence = compose(source, ['run', '--rm', '--no-deps', 'maintenance', 'node', '--input-type=module', '-e', `import {createApplication} from './dist/src/app.js';import {readConfig} from './dist/src/config.js';const a=await createApplication(readConfig());try{console.log(JSON.stringify({absent:(await a.runtime.agent.genericRecords.findById(${JSON.stringify(outcome.allocationId)}))===null}));}finally{await a.close();}`]);
      assert.deepEqual(JSON.parse(absence), { absent: true }); docker(['rm', '-f', stale]); stale = undefined;
    });
    stage = 'recovery-target-preparation';
    compose(source, ['stop', 'api', 'edge']);
    const target = await init(join(directory, 'target'), { name: 'credspan-probe-restore-' + suffix, port: source.port, image, controlDirectory: source.controlDirectory }); projects.push(target); remember(target);
    await writeFile(join(target.directory, 'secrets', 'store_key'), await readFile(join(source.directory, 'secrets', 'store_key')), { mode: 0o600 });
    startPostgres(target); await roles(target);
    const beforeDatabases = psql(target, 'SELECT datname FROM pg_database ORDER BY datname;');
    const wrong = join(directory, 'wrong-key'); await writeFile(wrong, randomBytes(32).toString('hex'), { mode: 0o600 });
    await assert.rejects(recover(target, archive, wrong, generation)); assert.equal(psql(target, 'SELECT datname FROM pg_database ORDER BY datname;'), beforeDatabases);
    const tampered = join(directory, 'tampered.enc'), bytes = await readFile(archive); bytes[40] ^= 1; await writeFile(tampered, bytes, { mode: 0o600 });
    await assert.rejects(recover(target, tampered, join(source.directory, 'secrets', 'backup_key'), generation)); assert.equal(psql(target, 'SELECT datname FROM pg_database ORDER BY datname;'), beforeDatabases);
    stage = 'authenticated-recovery';
    await recover(target, archive, join(source.directory, 'secrets', 'backup_key'), generation); remember(target);
    assert.equal(psql(target, 'SELECT value FROM unrelated.sentinel;', target.storeId, true), 'preserve');
    stage = 'retired-cohort-rejection';
    const current = await api(target);
    for (const [path, body, key] of [[new URL(issuer).pathname + '/token', { grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code', 'pre-authorized_code': grantCode }], [new URL(issuer).pathname + '/credential', { credential_configuration_id: 'membership', proofs: { jwt: ['expired-cohort-proof'] } }, token.access_token]]) {
      assert.equal((await fetch(current.base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) })).status, 404);
    }
    assert.equal((await fetch(current.base + new URL(new URL(pending.request).searchParams.get('request_uri')).pathname)).status, 404);
    const oldHolderId = compose(source, ['ps', '-q', 'wallet']); docker(['network', 'connect', target.name + '_default', oldHolderId]);
    const rejectRequest = await current.request(); let oldRejected = false; try { const result = await wallet.present(rejectRequest.request); oldRejected = result.transmission_success !== true; } catch { oldRejected = true; } assert.equal(oldRejected, true); assert.equal((await current.result(rejectRequest.id)).accepted, false);
    stage = 'recovered-wallet-journey';
    const newWallet = await holder(target), fresh = await current.issue('new-cohort'); assert.equal((await newWallet.receive(fresh.offer)).credentialIds.length, 1);
    const freshRequest = await current.request(); assert.equal((await newWallet.present(freshRequest.request)).transmission_success, true); assert.equal((await current.result(freshRequest.id)).accepted, true);
    stage = 'store-rekey';
    const newKey = join(directory, 'new-store-key'); await writeFile(newKey, randomBytes(32).toString('hex'), { mode: 0o600 });
    const oldStoreKey = await readFile(join(target.directory, 'secrets', 'store_key'));
    await rotate(target, 'rekey', newKey); remember(target);
    assert.equal((await current.result(freshRequest.id)).accepted, true, 'Store rekey retains signer and credential cohort');
    await writeFile(join(target.directory, 'secrets', 'store_key'), oldStoreKey, { mode: 0o600 }); await syncPrivate(target);
    assert.throws(() => compose(target, ['run', '--rm', '--no-deps', 'maintenance', 'node', 'dist/src/maintenance.js', 'check']));
    await writeFile(join(target.directory, 'secrets', 'store_key'), await readFile(newKey), { mode: 0o600 }); await syncPrivate(target);
    assert.equal(JSON.parse(compose(target, ['run', '--rm', '--no-deps', 'maintenance', 'node', 'dist/src/maintenance.js', 'check'])).ready, true);
    stage = 'schema-upgrade';
    // Exact historical schema fixture: v1 had stable signer refs but no generation/cohort.
    compose(target, ['stop', 'api', 'edge']);
    compose(target, ['run', '--rm', '--no-deps', 'maintenance', 'node', '--input-type=module', '-e', "import {createApplication} from './dist/src/app.js';import {readConfig} from './dist/src/config.js';const a=await createApplication(readConfig());const r=await a.runtime.agent.genericRecords.findById('credspan:identity:v1');r.content.version=1;delete r.content.generation;delete r.content.cohortId;await a.runtime.agent.genericRecords.update(r);await a.close();"]);
    assert.throws(() => compose(target, ['run', '--rm', '--no-deps', 'maintenance', 'node', 'dist/src/maintenance.js', 'check']));
    await rotate(target, 'upgrade'); remember(target);
    assert.equal((await fetch(current.base + new URL(new URL(freshRequest.request).searchParams.get('request_uri')).pathname)).status, 404);
    console.log(JSON.stringify({ localComposeWallet: true, wrongKeyAndTamperNoDatabaseMutation: true, staleBackupRetiresAllOldRoutesAndCredentials: true, unrelatedDataPreserved: true, storeRekeyRetainsCredentialValidity: true, rollbackArchiveRetained: true, image }));
  } catch (error) { originalFailure = error; console.error(JSON.stringify({ failedStage: stage })); throw error; } finally {
    const failures = [];
    if (stale) try { docker(['rm', '-f', stale]); } catch (error) { failures.push(error); }
    // The source wallet joins the target network during recovery. Remove both owned
    // holder services before down, so neither project's network retains an endpoint.
    for (const project of projects) try { compose(project, ['--profile', 'holder', 'rm', '--stop', '--force', 'wallet']); } catch (error) { failures.push(error); }
    for (const project of projects.toReversed()) { remember(project); try { down(project, { removeVolumes: true }); } catch (error) { failures.push(error); } }
    for (const volume of privateVolumes) try { if (docker(['volume', 'ls', '--format', '{{.Name}}']).split('\n').includes(volume)) docker(['volume', 'rm', volume]); } catch (error) { failures.push(error); }
    for (const project of projects) try {
      for (const args of [['ps', '-aq'], ['network', 'ls', '-q'], ['volume', 'ls', '-q']]) assert.equal(docker([...args, '--filter', 'label=credspan.deployment=' + project.deploymentId]), '', 'Every exact owned resource, including holder, is absent');
      assert.ok(!docker(['volume', 'ls', '--format', '{{.Name}}']).split('\n').includes(project.controlVolume));
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError([...(originalFailure ? [originalFailure] : []), ...failures], 'Owned fixture cleanup failed');
  }
});
