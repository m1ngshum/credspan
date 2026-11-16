import { test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { command, minimalEnvironment, OperationError } from '../src/process.js';
async function wait(check: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await check()) return; await delay(20); } throw Error('Test event timeout'); }

async function processSnapshot(pid: number) {
  if (process.platform !== 'linux') { try { process.kill(pid, 0); return { pid, present: true }; } catch { return { pid, present: false }; } }
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { pid, present: true, state: fields[0], ppid: Number(fields[1]), pgid: Number(fields[2]), starttime: fields[19] };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { pid, present: false }; throw error; }
}

test('timeout/cancellation terminates TERM-ignoring descendants and observes bounded eventual disappearance', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-mcp-process-'));
  try {
    for (const retaining of [true, false]) {
      const pidFile = join(directory, retaining ? 'retaining.pid' : 'closed.pid'), heartbeat = pidFile + '.heartbeat';
      const descendant = `const fs=require('fs');process.on('SIGTERM',()=>{});${retaining ? '' : 'process.stdout.destroy();process.stderr.destroy();'}setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20);fs.writeFileSync(process.argv[1],String(process.pid));`;
      const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},${JSON.stringify(pidFile)}],{stdio:['ignore',process.stdout,process.stderr]});setInterval(()=>{},10000)`;
      const controller = new AbortController(), start = Date.now();
      const pending = command(process.execPath, ['-e', parent], { signal: controller.signal, timeout: retaining ? 5000 : 300 }).then(() => null, error => error);
      await wait(async () => { try { await access(pidFile); await access(heartbeat); return true; } catch { return false; } });
      const pid = Number(await readFile(pidFile, 'utf8')), before = await processSnapshot(pid);
      assert.equal(before.present, true, 'Ready descendant is observable before cancellation');
      if (process.platform === 'linux') { assert.notEqual(before.state, 'Z', 'Ready descendant is executing before cancellation'); assert.equal(before.pgid, before.ppid, 'Descendant remains in the owned direct-child process group'); }
      if (retaining) controller.abort();
      const failure = await pending, after = await processSnapshot(pid);
      assert.ok(failure instanceof OperationError); assert.ok(Date.now() - start < 5000);
      assert.equal(failure.code, retaining ? 'cancelled' : 'timeout', JSON.stringify({ retaining, before, after }));
      if (after.present && process.platform === 'linux') {
        assert.equal(after.pgid, before.pgid, 'Same owned process group after termination');
        assert.equal(after.starttime, before.starttime, 'PID reuse must not be treated as successful cleanup');
        assert.equal(after.state, 'Z', `Descendant is still executing: ${JSON.stringify({ retaining, before, after, code: failure.code })}`);
      }
      const stoppedHeartbeat = await readFile(heartbeat, 'utf8');
      let last = after;
      await wait(async () => { last = await processSnapshot(pid); if (last.present && process.platform === 'linux') { assert.equal(last.starttime, before.starttime, 'PID identity changed while awaiting reaping'); assert.equal(last.pgid, before.pgid); assert.equal(last.state, 'Z', 'No live descendant interval may be hidden by eventual disappearance'); } return !last.present; }).catch(error => { throw Error(`Descendant did not disappear cleanly within 2s: ${JSON.stringify({ retaining, before, after, last, code: failure.code })}`, { cause: error }); });
      assert.equal(await readFile(heartbeat, 'utf8'), stoppedHeartbeat, 'No descendant side effects continue after termination');
      assert.throws(() => process.kill(pid, 0), 'Descendant PID eventually disappears, including zombies');
      if (before.ppid) assert.equal((await processSnapshot(before.ppid)).present, false, 'Direct child also disappears');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stdio modern and legacy expose only bounded tools; no startup/disabled mutation', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-mcp-readonly-'));
  try {
    for (const version of ['2025-11-25', '2026-07-28']) {
      const client = new Client({ name: 'credspan-unit', version: '0.0.0' }, { supportedProtocolVersions: [version], ...(version === '2026-07-28' ? { versionNegotiation: { mode: { pin: version } } } : {}) });
      const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/main.js', import.meta.url))], env: { ...minimalEnvironment(), TMPDIR: directory, DOCKER_HOST: 'tcp://untrusted.invalid:2376', MANAGEMENT_API_KEY: 'synthetic-secret-sentinel-do-not-return' }, stderr: 'pipe' });
      let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
      try {
        await client.connect(transport); assert.equal(client.getNegotiatedProtocolVersion(), version);
        assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['diagnostics', 'propose_config', 'run_sandbox_test']);
        const proposed = await client.callTool({ name: 'propose_config', arguments: { port: 8080, bind: 'loopback' } });
        assert.equal((proposed.structuredContent as Record<string, unknown>).applied, false);
        for (const arguments_ of [{ port: 80, bind: 'loopback' }, { port: 8080, bind: '0.0.0.0' }, { port: 8080, bind: 'loopback', command: 'rm -rf /' }, { port: 8080, bind: 'loopback', secret: 'caller-secret' }]) {
          await client.callTool({ name: 'propose_config', arguments: arguments_ }).then(response => { assert.equal(response.isError, true); assert.match(JSON.stringify(response.content), /invalid|validat|argument/i); }, error => { assert.equal(error.code, -32602); });
          const healthy = await client.callTool({ name: 'propose_config', arguments: { port: 8080, bind: 'loopback' } }); assert.equal((healthy.structuredContent as Record<string, unknown>).applied, false);
        }
        const disabled = await client.callTool({ name: 'run_sandbox_test', arguments: { scenario: 'membership-roundtrip' } }); assert.equal(disabled.isError, true); assert.equal((disabled.structuredContent as Record<string, unknown>).code, 'disabled');
        const diagnostic = await client.callTool({ name: 'diagnostics', arguments: {} }); assert.equal((diagnostic.structuredContent as Record<string, unknown>).dockerReady, false); assert.equal((diagnostic.structuredContent as Record<string, unknown>).sandboxEnabled, false);
        assert.ok(!JSON.stringify([proposed, disabled, diagnostic]).includes('synthetic-secret-sentinel'));
        await assert.rejects(access(join(directory, `credspan-mcp-${process.getuid!()}`)), 'Read-only tools and discovery create no lease/state');
      } finally { await client.close(); }
      assert.equal(stderr, '');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('oversized frames, malformed JSON-RPC and unsupported modern revision are rejected without state', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-mcp-wire-'));
  try {
    for (const kind of ['oversized', 'malformed', 'unsupported']) {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.js', import.meta.url))], { env: { ...minimalEnvironment(), TMPDIR: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const exited = new Promise(resolve => child.on('exit', resolve));
      try {
        if (kind === 'oversized') child.stdin.write('x'.repeat(70000));
        else if (kind === 'malformed') child.stdin.write('{"jsonrpc":"2.0","id":1,"method":5}\n');
        else child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01', 'io.modelcontextprotocol/clientInfo': { name: 'wire-test', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) + '\n');
        if (kind === 'unsupported') { await wait(async () => stdout.includes('\n')); assert.equal(JSON.parse(stdout.trim()).error.code, -32022); child.stdin.end(); }
        await Promise.race([exited, delay(3000, undefined, { ref: false }).then(() => { throw Error(kind + ' rejection did not terminate'); })]);
        if (kind !== 'unsupported') assert.match(stderr, /mcp_protocol_error/);
        for (const line of stdout.trim().split('\n').filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, '2.0');
        await assert.rejects(access(join(directory, `credspan-mcp-${process.getuid!()}`)));
      } finally { child.kill('SIGKILL'); await exited; }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('diagnostics cancellation and EOF retire an actual controlled descendant; healthy follow-up', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-mcp-diagnostics-'));
  try {
    for (const mode of ['cancel', 'eof']) {
      const bin = join(directory, mode); await mkdir(bin, { mode: 0o700 }); const pidFile = join(bin, 'descendant.pid');
      const descendant = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},10000)`;
      const executable = join(bin, 'docker'); await writeFile(executable, `#!${process.execPath}\nrequire('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',process.stdout,process.stderr]});setInterval(()=>{},10000)`); await chmod(executable, 0o700);
      const client = new Client({ name: 'diagnostic-cancel', version: '0' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/main.js', import.meta.url))], env: { ...minimalEnvironment(), PATH: bin + ':' + process.env.PATH, DOCKER_HOST: 'unix:///synthetic-local-test.sock', TMPDIR: directory }, stderr: 'pipe' });
      try {
        await client.connect(transport); const controller = new AbortController();
        const pending = client.callTool({ name: 'diagnostics', arguments: {} }, { signal: controller.signal }).catch(() => null);
        await wait(async () => { try { await access(pidFile); return true; } catch { return false; } }); const pid = Number(await readFile(pidFile, 'utf8'));
        if (mode === 'cancel') controller.abort(); else await client.close(); await pending;
        await wait(async () => { try { process.kill(pid, 0); return false; } catch { return true; } });
        if (mode === 'cancel') { const healthy = await client.callTool({ name: 'propose_config', arguments: { port: 8080, bind: 'loopback' } }); assert.equal((healthy.structuredContent as Record<string, unknown>).applied, false); }
        await assert.rejects(access(join(directory, `credspan-mcp-${process.getuid!()}`)));
      } finally { await client.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('clean service-image cache fails immediately without implicit pulls; explicit preparation uses only pinned refs', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-mcp-image-cache-'));
  const source = fileURLToPath(new URL('../../../../', import.meta.url));
  const images = JSON.parse(await readFile(join(source, 'ops/images.json'), 'utf8'));
  const profile = JSON.parse(await readFile(new URL('../../runtime.json', import.meta.url), 'utf8'));
  const state = join(directory, 'state.json'), calls = join(directory, 'calls.jsonl'), peerLabel = join(directory, 'peer-label.json'), apiLabel = join(directory, 'api-label.json');
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
  await writeFile(apiLabel, JSON.stringify({ ...profile, architecture }));
  await writeFile(state, '[]'); await writeFile(calls, ''); await writeFile(peerLabel, JSON.stringify(profile.peerDependencyPatch));
  const executable = join(directory, 'docker');
  await writeFile(executable, `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2).slice(2),images=${JSON.stringify(images)},profile=${JSON.stringify(profile)};
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='info'){console.log(JSON.stringify([{Name:'compose',Path:'/fixture/compose'}]));process.exit(0);}
const cached=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));
if(args[0]==='pull'&&[images.postgres,images.caddy].includes(args[1])){cached.push(args[1]);fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(cached));process.exit(0);}
if(args[0]!=='image'||args[1]!=='inspect')process.exit(8);
const ref=args[2];if(!['credspan-api:local',images.wallet,...cached].includes(ref))process.exit(1);
const apiLabel=JSON.parse(fs.readFileSync(${JSON.stringify(apiLabel)},'utf8'));
console.log(JSON.stringify({Id:'sha256:'+'a'.repeat(64),Architecture:apiLabel.architecture,Config:{Labels:ref==='credspan-api:local'?{'org.opencontainers.image.source':apiLabel.repository,'org.opencontainers.image.revision':apiLabel.apiSource}:{'credspan.probe.patch.sha256':profile.peerPatch,'credspan.dependencies.patch.sha256':JSON.parse(fs.readFileSync(${JSON.stringify(peerLabel)},'utf8'))}}}));
`, { mode: 0o700 });
  const env = { ...minimalEnvironment(), PATH: directory + ':' + minimalEnvironment().PATH, DOCKER_HOST: 'unix:///fixture/docker.sock' };
  try {
    const started = Date.now(), child = spawn(process.execPath, ['--test', fileURLToPath(new URL('./integration.test.js', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); clearTimeout(timer);
    assert.notEqual(code, 0); assert.ok(Date.now() - started < 5000); assert.match(output, /MCP integration prerequisites unavailable/);
    let recorded = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.ok(recorded.every(args => args[0] === 'info' || args[0] === 'image'), 'Fail-fast preflight never pulls, creates leases or initializes resources');
    await command(process.execPath, [join(source, 'ops/cache-sandbox-images.mjs')], { env });
    recorded = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.deepEqual(recorded.filter(args => args[0] === 'pull'), [['pull', images.postgres], ['pull', images.caddy]]);
    const check = `import{cachedImages}from${JSON.stringify(new URL('../src/profile.js', import.meta.url).href)};await cachedImages({endpoint:'unix:///fixture/docker.sock'});console.log('ready');`;
    assert.equal(await command(process.execPath, ['--input-type=module', '-e', check], { env }), 'ready');
    for (const peerPatch of ['', 'outdated-dependency-patch']) {
      await writeFile(peerLabel, JSON.stringify(peerPatch));
      await assert.rejects(command(process.execPath, ['--input-type=module', '-e', check], { env }));
    }
    await writeFile(peerLabel, JSON.stringify(profile.peerDependencyPatch));
    for (const mismatch of [{ apiSource: '0'.repeat(40) }, { repository: 'https://example.invalid/wrong-source' }, { architecture: architecture === 'arm64' ? 'amd64' : 'arm64' }]) {
      await writeFile(apiLabel, JSON.stringify({ ...profile, architecture, ...mismatch }));
      const before = (await readFile(calls, 'utf8')).trim().split('\n').length;
      await assert.rejects(command(process.execPath, ['--input-type=module', '-e', check], { env }));
      const after = (await readFile(calls, 'utf8')).trim().split('\n').slice(before).map(line => JSON.parse(line) as string[]);
      assert.ok(after.length > 0 && after.every(args => args[0] === 'image' && args[1] === 'inspect'), 'Mismatched API provenance must fail before resource creation or pulls');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
