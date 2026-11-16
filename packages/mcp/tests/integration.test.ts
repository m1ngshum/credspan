import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, chmod, readdir } from 'node:fs/promises';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Sandbox } from '../src/sandbox.js';
import { cachedImages } from '../src/profile.js';
import { localDocker, docker, minimalEnvironment } from '../src/process.js';
const main = fileURLToPath(new URL('../src/main.js', import.meta.url));
async function wait(check: () => Promise<boolean>, milliseconds = 30000) { const until = Date.now() + milliseconds; while (Date.now() < until) { try { if (await check()) return; } catch {} await delay(100); } throw Error('Synthetic event timed out'); }
const object = (value: unknown) => value as Record<string, unknown>;
const budget = (directory: string) => join(directory, `credspan-mcp-${process.getuid!()}`);
async function waitForCleanup(client: Client, home: string, phase: 'first' | 'reused') {
  try { await wait(async () => { try { await access(join(budget(home), 'lease.json')); return false; } catch { return true; } }); }
  catch {
    let state: Record<string, unknown> = {};
    try { const response = await client.callTool({ name: 'diagnostics', arguments: {} }, { timeout: 5000 }); const value = object(response.structuredContent); state = { busy: value.busy, cleanupRequired: value.cleanupRequired, cleanupFailure: value.cleanupFailure }; } catch { state = { diagnosticsUnavailable: true }; }
    throw Error('Sandbox cleanup observation timed out: ' + JSON.stringify({ phase, ...state }));
  }
}

async function owned(directory: string) {
  const lease = JSON.parse(await readFile(join(budget(directory), 'lease.json'), 'utf8'));
  return JSON.parse(await readFile(join(lease.directory, 'owned.json'), 'utf8')) as { id: string; name: string; directory: string };
}

test('actual MCP clients run independent-wallet scenarios, isolation and bounded lifecycle cleanup', { timeout: 300000 }, async t => {
  const boundary = await localDocker();
  await assert.doesNotReject(() => cachedImages(boundary), 'MCP integration prerequisites unavailable or mismatched: explicitly cache the reviewed API/wallet and digest-pinned PostgreSQL/Caddy images before running tests');
  const directory = await mkdtemp(join(tmpdir(), 'credspan-mcp-integration-'));
  const unrelatedId = randomUUID(), unrelatedVolume = 'credspan-probe-mcp-unrelated-' + unrelatedId.slice(0, 8);
  const image = (await docker(boundary, ['image', 'inspect', 'credspan-api:local', '--format', '{{.Id}}']));
  await docker(boundary, ['volume', 'create', '--label', 'credspan.deployment=' + unrelatedId, unrelatedVolume]);
  const unrelatedContainer = await docker(boundary, ['run', '-d', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--label', 'credspan.deployment=' + unrelatedId, image, 'node', '-e', 'setInterval(()=>{},10000)']);
  const environment = (home: string) => ({ ...minimalEnvironment(), ...(process.env.HOME ? { HOME: process.env.HOME } : {}), DOCKER_HOST: boundary.endpoint, TMPDIR: home, MANAGEMENT_API_KEY: 'synthetic-active-secret-sentinel', PUBLIC_URL: 'https://active.invalid', POSTGRES_HOST: 'active.invalid:5432', CONTROL_DIRECTORY: join(directory, 'active-control') });
  const checkGone = async (run: { id: string; directory: string }) => { const id = run.id; const control = 'credspan_control_' + createHash('sha256').update(join(run.directory, 'project', 'control')).digest('hex').slice(0, 16); assert.ok(!(await docker(boundary, ['volume', 'ls', '--format', '{{.Name}}'])).split('\n').includes(control)); for (const args of [['ps', '-aq'], ['network', 'ls', '-q'], ['volume', 'ls', '-q']]) assert.equal(await docker(boundary, [...args, '--filter', 'label=credspan.deployment=' + id]), ''); };
  const untouched = async () => { assert.equal(await docker(boundary, ['inspect', unrelatedContainer, '--format', '{{.State.Running}}']), 'true'); assert.equal(await docker(boundary, ['volume', 'inspect', unrelatedVolume, '--format', '{{index .Labels "credspan.deployment"}}']), unrelatedId); };
  await mkdir(join(directory, 'active-control'), { mode: 0o700 }); await writeFile(join(directory, 'active-control', 'sentinel'), 'unchanged');
  try {
    for (const version of ['2025-11-25', '2026-07-28']) await t.test(`real ${version} tool issue/hold/present${version === '2026-07-28' ? '/revoke' : ''}`, async () => {
      const home = join(directory, version); await mkdir(home, { mode: 0o700 });
      const client = new Client({ name: 'credspan-integration', version: '0.0.0' }, { supportedProtocolVersions: [version], ...(version === '2026-07-28' ? { versionNegotiation: { mode: { pin: version } } } : {}) });
      const transport = new StdioClientTransport({ command: process.execPath, args: [main, '--allow-sandbox-tests'], env: environment(home), stderr: 'pipe' });
      let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
      try {
        await client.connect(transport); assert.equal(client.getNegotiatedProtocolVersion(), version); await client.listTools();
        const diagnostic = await client.callTool({ name: 'diagnostics', arguments: {} }); assert.equal(object(diagnostic.structuredContent).imagesReady, true);
        const pending = client.callTool({ name: 'run_sandbox_test', arguments: { scenario: version === '2026-07-28' ? 'revocation' : 'membership-roundtrip' } }, { timeout: 150000 });
        let captured: Awaited<ReturnType<typeof owned>>; await wait(async () => { captured = await owned(home); return true; });
        const response = await pending; await checkGone(captured!);
        assert.notEqual(response.isError, true); const result = object(response.structuredContent); assert.equal(result.passed, true); assert.equal(result.cleanupComplete, true);
        assert.equal(result.apiSource, '84f16d82ef3851d78a5f7dcd789280601e088789'); assert.ok(!JSON.stringify(response).includes('synthetic-active-secret-sentinel'));
        await assert.rejects(access(join(budget(home), 'lease.json'))); assert.equal(await readFile(join(directory, 'active-control', 'sentinel'), 'utf8'), 'unchanged');
      } finally { await client.close(); }
      assert.equal(stderr, ''); await untouched();
    });
    await t.test('actual cancellation after PostgreSQL creation clears owned resources and preserves unrelated ones', async () => {
      const home = join(directory, 'cancel'); await mkdir(home, { mode: 0o700 });
      const client = new Client({ name: 'credspan-cancel', version: '0.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
      const transport = new StdioClientTransport({ command: process.execPath, args: [main, '--allow-sandbox-tests'], env: environment(home), stderr: 'pipe' });
      try {
        await client.connect(transport); const cancel = new AbortController();
        const pending = client.callTool({ name: 'run_sandbox_test', arguments: { scenario: 'revocation' } }, { signal: cancel.signal, timeout: 150000 }).catch(() => null);
        let run: Awaited<ReturnType<typeof owned>>;
        await wait(async () => { run = await owned(home); return !!await docker(boundary, ['ps', '-aq', '--filter', 'label=credspan.deployment=' + run.id, '--filter', 'label=com.docker.compose.service=postgres']); });
        const busy = await client.callTool({ name: 'run_sandbox_test', arguments: { scenario: 'membership-roundtrip' } }); assert.equal(object(busy.structuredContent).code, 'busy');
        const other = new Client({ name: 'cross-instance', version: '0' });
        const otherTransport = new StdioClientTransport({ command: process.execPath, args: [main, '--allow-sandbox-tests'], env: environment(home), stderr: 'pipe' });
        try { await other.connect(otherTransport); const refused = await other.callTool({ name: 'run_sandbox_test', arguments: { scenario: 'membership-roundtrip' } }); assert.equal(object(refused.structuredContent).code, 'busy'); } finally { await other.close(); }
        cancel.abort(); assert.equal(await pending, null);
        await waitForCleanup(client, home, 'first');
        await checkGone(run!); const diagnostic = await client.callTool({ name: 'diagnostics', arguments: {} }); assert.equal(object(diagnostic.structuredContent).busy, false);
        const again = new AbortController(), repeated = client.callTool({ name: 'run_sandbox_test', arguments: { scenario: 'revocation' } }, { signal: again.signal }).catch(() => null);
        await wait(async () => { run = await owned(home); return !!await docker(boundary, ['ps', '-aq', '--filter', 'label=credspan.deployment=' + run.id]); }); again.abort(); await repeated;
        await waitForCleanup(client, home, 'reused'); await checkGone(run!); await untouched();
      } finally { await client.close(); }
    });
    await t.test('runner strips active environment and NODE_OPTIONS; deadline still cleans a real partial run', async () => {
      const home = join(directory, 'deadline'); await mkdir(home, { mode: 0o700 });
      const poison = join(directory, 'poison.mjs'), marker = join(directory, 'poison-ran'); await writeFile(poison, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'bad')`);
      const previous = { ...process.env }; Object.assign(process.env, environment(home), { NODE_OPTIONS: '--import=' + pathToFileURL(poison).href });
      let initialized = false;
      try {
        const sandbox = new Sandbox(true, 5000); const response = await sandbox.run('revocation', new AbortController().signal, stage => { if (stage === 'initialized') initialized = true; });
        assert.ok(initialized); assert.equal(response.code, 'timeout'); assert.equal(response.cleanupComplete, true); await assert.rejects(access(marker)); await sandbox.shutdown();
        await assert.rejects(access(join(budget(home), 'lease.json'))); assert.equal(await readFile(join(directory, 'active-control', 'sentinel'), 'utf8'), 'unchanged');
      } finally { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); }
      await untouched();
    });
    await t.test('pre-Docker child init failure releases lease and all private state', async () => {
      const home = join(directory, 'init-failure'); await mkdir(home, { mode: 0o700 }); const previous = process.env.TMPDIR; process.env.TMPDIR = home;
      let captured: Awaited<ReturnType<typeof owned>>;
      try {
        const sandbox = new Sandbox(true); const response = await sandbox.run('membership-roundtrip', new AbortController().signal, stage => {
          if (stage === 'initializing') { const lease = JSON.parse(readFileSync(join(budget(home), 'lease.json'), 'utf8')); captured = JSON.parse(readFileSync(join(lease.directory, 'owned.json'), 'utf8')); writeFileSync(join(captured.directory, 'project'), 'prevent-init', { flag: 'wx', mode: 0o600 }); }
        });
        assert.equal(response.passed, false); assert.equal(response.cleanupComplete, true); await checkGone(captured!); await assert.rejects(access(join(budget(home), 'lease.json'))); await sandbox.shutdown(); await untouched();
      } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
    });
    for (const mode of ['eof', 'sigterm', 'denied-cleanup', 'oversized-denied-cleanup'] as const) await t.test(`actual ${mode} during a real partial run`, async () => {
      const home = join(directory, mode); await mkdir(home, { mode: 0o700 });
      const child = spawn(process.execPath, [main, '--allow-sandbox-tests'], { env: environment(home), stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = '', stderr = '', initialized = false;
      child.stdout.on('data', chunk => { buffer += chunk; let next; while ((next = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0, next)); buffer = buffer.slice(next + 1); if (value.id === 1 && value.result) initialized = true; } });
      child.stdin.on('error', () => {});
      child.stderr.on('data', chunk => { stderr += chunk; });
      const exit = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
      const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-lifecycle', version: '0.0.0' } } });
      await wait(async () => initialized); send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_sandbox_test', arguments: { scenario: 'revocation' } } });
      let run: Awaited<ReturnType<typeof owned>>;
      try {
        await wait(async () => { run = await owned(home); return !!await docker(boundary, ['ps', '-aq', '--filter', 'label=credspan.deployment=' + run.id, '--filter', 'label=com.docker.compose.service=postgres']); });
        if (mode.includes('denied-cleanup')) chmodSync(budget(home), 0o500);
        if (mode === 'sigterm') child.kill('SIGTERM'); else if (mode === 'oversized-denied-cleanup') child.stdin.write('x'.repeat(70000)); else child.stdin.end();
        const code = await Promise.race([exit, delay(35000, undefined, { ref: false }).then(() => { throw Error('MCP shutdown exceeded cleanup bound'); })]);
        assert.equal(code, mode.includes('denied-cleanup') ? 1 : 0);
        if (mode.includes('denied-cleanup')) { assert.match(stderr, /mcp_cleanup_required/); const retained = JSON.parse(await readFile(join(budget(home), 'lease.json'), 'utf8')); assert.equal(retained.id, run!.id); assert.equal(retained.name, run!.name); assert.equal(retained.directory, run!.directory); }
        else { assert.equal(stderr, ''); await assert.rejects(access(join(budget(home), 'lease.json'))); }
        await checkGone(run!); await untouched();
      } finally { if (child.exitCode === null) child.kill('SIGKILL'); await chmod(budget(home), 0o700).catch(() => {}); await rm(budget(home), { recursive: true, force: true }); }
    });
  } finally {
    await docker(boundary, ['rm', '-f', unrelatedContainer]); await docker(boundary, ['volume', 'rm', unrelatedVolume]); await rm(directory, { recursive: true, force: true });
  }
});
