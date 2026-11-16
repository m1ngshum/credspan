import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '@openwallet-foundation/askar-nodejs';
const exec = promisify(execFile);
const image = 'postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42';
test('pinned native Askar requires trusted CA and matching hostname, with a nonadmin database owner', { timeout: 90000 }, async () => {
  assert.match(process.env.TLS_API_IMAGE ?? '', /^sha256:[a-f0-9]{64}$/, 'Set the reviewed amd64 API image ID');
  const originalMode = process.env.PGSSLMODE, originalCa = process.env.PGSSLROOTCERT;
  const directory = await mkdtemp(join(tmpdir(), 'credspan-tls-'));
  const name = 'credspan-probe-tls-' + randomUUID().slice(0, 8);
  const network = name + '-network';
  const docker = async (...args: string[]) => (await exec('docker', args)).stdout.trim();
  try {
    for (const prefix of ['ca', 'wrong']) await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(directory, prefix + '.key'), '-out', join(directory, prefix + '.crt'), '-subj', '/CN=Credspan synthetic ' + prefix, '-addext', 'basicConstraints=critical,CA:TRUE']);
    await exec('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'server.key'), '-out', join(directory, 'server.csr'), '-subj', '/CN=localhost']);
    await writeFile(join(directory, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost,DNS:good\nextendedKeyUsage=serverAuth\n');
    await exec('openssl', ['x509', '-req', '-in', join(directory, 'server.csr'), '-CA', join(directory, 'ca.crt'), '-CAkey', join(directory, 'ca.key'), '-CAcreateserial', '-days', '1', '-extfile', join(directory, 'server.ext'), '-out', join(directory, 'server.crt')]);
    await chmod(directory, 0o755);
    await docker('network', 'create', network);
    await docker('run', '-d', '--name', name, '--network', network, '--network-alias', 'good', '--network-alias', 'bad', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=synthetic-only', '--mount', `type=bind,source=${directory},target=/tls,readonly`, '--entrypoint', 'sh', image, '-c', 'cp /tls/server.key /tmp/server.key && chown postgres:postgres /tmp/server.key && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tls/server.crt -c ssl_key_file=/tmp/server.key');
    for (let attempt = 0; ; attempt++) { try { await docker('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'); break; } catch { if (attempt === 60) throw Error('TLS database unavailable'); await new Promise(resolve => setTimeout(resolve, 200)); } }
    await docker('exec', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', "CREATE ROLE probe LOGIN PASSWORD 'synthetic-runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;", '-c', 'CREATE DATABASE credspan_tls OWNER probe;');
    const port = (await docker('port', name, '5432/tcp')).split(':').at(-1)!;
    const uri = (host: string) => `postgres://probe:synthetic-runtime@${host}:${port}/credspan_tls?connect_timeout=3`;
    process.env.PGSSLMODE = 'verify-full'; process.env.PGSSLROOTCERT = join(directory, 'ca.crt');
    const key = Store.generateRawKey();
    const store = await Store.provision({ uri: uri('localhost'), passKey: key, recreate: false });
    const transport = await docker('exec', name, 'psql', '-U', 'postgres', '-Atc', "SELECT ssl FROM pg_stat_ssl JOIN pg_stat_activity USING(pid) WHERE usename='probe'");
    console.log('native transport ssl=' + transport.replaceAll('\n', ','));
    await store.close();
    const worker = join(directory, 'probe.mjs');
    await writeFile(worker, `import { Store } from ${JSON.stringify(new URL('../../node_modules/@openwallet-foundation/askar-nodejs/build/index.js', import.meta.url).pathname)};\ntry { const store = await Store.open({ uri: process.argv[2], passKey: process.argv[3] }); await store.close(); console.log('ACCEPTED'); } catch { console.log('REJECTED'); }`);
    const outcomes = [];
    for (const [host, ca] of [['localhost', 'wrong.crt'], ['127.0.0.1', 'ca.crt']]) outcomes.push((await exec(process.execPath, [worker, uri(host!), key], { env: { ...process.env, PGSSLROOTCERT: join(directory, ca!) } })).stdout.trim());
    console.log('independent-process wrongCA,wrongHostname=' + outcomes.join(','));
    assert.deepEqual(outcomes, ['REJECTED', 'REJECTED']);
    const linuxWorker = join(directory, 'linux.mjs');
    await writeFile(linuxWorker, `import { Store } from '/app/apps/api/node_modules/@openwallet-foundation/askar-nodejs/build/index.js';\ntry { const store = await Store.open({ uri: process.argv[2], passKey: process.argv[3] }); await store.close(); console.log('ACCEPTED'); } catch { console.log('REJECTED'); }`, { mode: 0o644 });
    const linux = [];
    for (const [host, ca] of [['good', 'ca.crt'], ['good', 'wrong.crt'], ['bad', 'ca.crt']]) linux.push(await docker('run', '--rm', '--network', network, '--mount', `type=bind,source=${directory},target=/tls,readonly`, '-e', 'PGSSLMODE=verify-full', '-e', `PGSSLROOTCERT=/tls/${ca}`, process.env.TLS_API_IMAGE!, 'node', '/tls/linux.mjs', `postgres://probe:synthetic-runtime@${host}:5432/credspan_tls?connect_timeout=3`, key));
    console.log('Linux trusted,wrongCA,wrongHostname=' + linux.join(','));
    assert.deepEqual(linux, ['ACCEPTED', 'REJECTED', 'REJECTED']);
    const reopened = await Store.open({ uri: uri('localhost'), passKey: key }); await reopened.close();
  } finally {
    if (originalMode === undefined) delete process.env.PGSSLMODE; else process.env.PGSSLMODE = originalMode;
    if (originalCa === undefined) delete process.env.PGSSLROOTCERT; else process.env.PGSSLROOTCERT = originalCa;
    await docker('rm', '-f', '-v', name).catch(() => {}); await docker('network', 'rm', network).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
