import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
test('native Askar PostgreSQL records and claims survive process-context/database restart', { timeout: 60_000 }, async () => {
  const name = `credspan-probe-storage-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const directory = await mkdtemp(join(tmpdir(), 'credspan-storage-control-'));
  const docker = async (...args: string[]) => (await exec('docker', args)).stdout.trim();
  let stage = 'database startup';
  try {
    await docker('run', '-d', '--name', name, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_USER=credspan', 'postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42');
    const port = (await docker('port', name, '5432/tcp')).split(':').at(-1)!;
    for (let attempt = 0; ; attempt++) {
      try { await docker('exec', name, 'pg_isready', '-U', 'credspan'); break; } catch { if (attempt === 49) throw Error('PostgreSQL readiness failed'); await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    const env = { ...process.env, CONTROL_DIRECTORY: directory, TEST_RECORD_ID: randomUUID(), CREDSPAN_SANDBOX: '1', PUBLIC_URL: 'http://localhost:3000', MANAGEMENT_API_KEY: randomBytes(32).toString('hex'), ASKAR_STORE_ID: 'credspan_storage', ASKAR_STORE_KEY: randomBytes(32).toString('hex'), POSTGRES_HOST: `127.0.0.1:${port}`, POSTGRES_USER: 'credspan', POSTGRES_PASSWORD: password };
    const worker = (mode: string) => exec(process.execPath, [new URL('./storage-worker.js', import.meta.url).pathname, mode], { env });
    stage = 'first process write and shutdown';
    await worker('write');
    stage = 'database restart';
    await docker('restart', name);
    for (let attempt = 0; ; attempt++) {
      try { await docker('exec', name, 'pg_isready', '-U', 'credspan'); break; } catch { if (attempt === 49) throw Error('PostgreSQL restart readiness failed'); await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    env.POSTGRES_HOST = `127.0.0.1:${(await docker('port', name, '5432/tcp')).split(':').at(-1)!}`;
    stage = 'new process persisted record and claim check';
    await worker('read');
  } catch (error) { throw new Error(`Storage probe failed during ${stage}`, { cause: error }); } finally { await docker('rm', '-f', '-v', name).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
