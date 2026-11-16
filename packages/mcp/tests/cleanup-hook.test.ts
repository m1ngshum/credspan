import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { cleanup } from '../src/cleanup.js';
const exec = promisify(execFile);

test('race hook waits for delayed authoritative removal and diagnoses failures without a false marker', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-hook-controlled-')), id = 'a'.repeat(64);
  try {
    const binary = join(directory, 'docker');
    await writeFile(binary, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs'),a=process.argv.slice(2),scenario=process.env.SCENARIO,id=process.env.OWNED_ID;
if(process.env.LOG)fs.appendFileSync(process.env.LOG,JSON.stringify(a)+'\n');
if(a[2]==='inspect')process.stdout.write(JSON.stringify({'credspan.deployment':process.env.RUN_ID,'com.docker.compose.project':process.env.RUN_NAME,'com.docker.compose.service':'init'}));
else if(a[2]==='stop') { if(scenario==='stop-failure'){process.stderr.write('synthetic-private-error');process.exitCode=1;}else fs.writeFileSync(process.env.STOPPED,'stopped'); }
else if(a[2]==='ps') {
  if(!fs.existsSync(process.env.STOPPED)) process.stdout.write(id);
  else {
    let n=0;try{n=Number(fs.readFileSync(process.env.COUNT,'utf8'));}catch{}fs.writeFileSync(process.env.COUNT,String(n+1));
    if(scenario==='query-failure'){process.stderr.write('synthetic-private-error');process.exitCode=1;}
    else if(scenario==='invalid-response')process.stdout.write('unexpected-id');
    else if(scenario==='pending'||n<2)process.stdout.write(id);
  }
}
`, { mode: 0o700 });
    const proxySource = await readFile(new URL('../../tests/fixtures/cleanup-proxy.cjs', import.meta.url), 'utf8');
    const proxyDirectory = join(directory, 'proxy'); await mkdir(proxyDirectory);
    await writeFile(join(proxyDirectory, 'docker'), `#!${process.execPath}\n` + proxySource, { mode: 0o700 });
    for (const [scenario, mode] of [['delayed', 'inspect'], ['stop-failure', 'inspect'], ['query-failure', 'inspect'], ['invalid-response', 'inspect'], ['pending', 'inspect'], ['stop-failure', 'remove'], ['query-failure', 'remove']]) {
      const marker = join(directory, scenario + '-' + mode + '.json'), report = marker + '.report', count = marker + '.count', stopped = marker + '.stopped';
      const env = { PATH: process.env.PATH, REAL_DOCKER: binary, OWNED_ID: id, RUN_ID: '99999999-1111-4222-8333-444444444444', RUN_NAME: 'credspan-mcp-controlled', MODE: mode, MARKER: marker, REPORT: report, SCENARIO: scenario, STOPPED: stopped, COUNT: count };
      if (mode === 'remove') {
        const log = marker + '.calls'; await writeFile(log, '');
        const outcome = await cleanup({ endpoint: 'unix:///controlled.sock' }, { id: env.RUN_ID, name: env.RUN_NAME, directory: join(directory, 'run') }, { ...env, PATH: proxyDirectory, LOG: log });
        assert.equal(outcome.complete, false);
        const operations: string[][] = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.ok(operations.some(args => args.includes('id=' + id)), 'production cleanup really queried absence after the hook failed');
        assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), { stage: scenario === 'stop-failure' ? 'stop' : 'absence', code: 'command-failed', queries: 0 }, 'later recovery commands preserve the original terminal hook phase');
        await assert.rejects(access(marker));
        continue;
      }
      let result;
      try { result = await exec(process.execPath, [fileURLToPath(new URL('../../tests/fixtures/cleanup-proxy.cjs', import.meta.url)), '--host', 'unix:///controlled.sock', 'ps', '-aq', '--no-trunc', '--filter', 'label=credspan.deployment=' + env.RUN_ID], { env, timeout: 5000, killSignal: 'SIGKILL' }); }
      catch (error) { assert.equal((error as { code?: unknown }).code, 1, 'proxy must finish within the existing command budget'); }
      const observed = JSON.parse(await readFile(report, 'utf8'));
      if (scenario === 'delayed') {
        assert.equal(result?.stdout, id, 'original captured snapshot is returned only after removal');
        assert.equal(await readFile(count, 'utf8'), '3', 'two still-present observations precede authoritative absence');
        assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { hookExecuted: true, exactIdAbsent: true });
        assert.deepEqual(observed, { stage: 'marker', code: 'complete', queries: 3 });
      } else {
        await assert.rejects(access(marker));
        assert.equal(observed.stage, scenario === 'stop-failure' ? 'stop' : 'absence');
        if (scenario === 'pending') { assert.ok(['absence-pending', 'command-timeout'].includes(observed.code)); assert.ok(observed.queries >= 2, 'pending state was observed repeatedly before its fixed budget expired'); }
        else assert.equal(observed.code, scenario === 'invalid-response' ? 'invalid-response' : 'command-failed');
        assert.ok(!JSON.stringify(observed).includes('synthetic-private-error'));
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
