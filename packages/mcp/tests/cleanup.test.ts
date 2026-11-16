import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup } from '../src/cleanup.js';

test('cleanup tolerates only authoritatively absent immutable container IDs and keeps other failures closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-cleanup-controlled-'));
  const id = 'a'.repeat(64), run = { id: '99999999-1111-4222-8333-444444444444', name: 'credspan-mcp-controlled', directory: join(directory, 'run') };
  try {
    await writeFile(join(directory, 'docker'), `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs'),a=process.argv.slice(4),mode=process.env.MODE,marker=process.env.MARKER,id='a'.repeat(64);
fs.appendFileSync(process.env.LOG,JSON.stringify(a)+'\n');
const gone=()=>fs.writeFileSync(marker,'removed');
if(a[0]==='ps'){
  if(a.includes('id='+id)&&mode==='engine-error'){process.stderr.write('synthetic-secret-path-sentinel');process.exitCode=1;}
  else if(a.includes('id='+id)&&mode==='malformed-absence')process.stdout.write('not-an-id');
  else if(mode!=='empty'&&!fs.existsSync(marker))process.stdout.write(id);
}else if(a[0]==='inspect'){
  if(mode==='gone-before-inspect'){gone();process.exitCode=1;}
  else if(['engine-error','still-present','malformed-absence'].includes(mode))process.exitCode=1;
  else if(mode==='malformed-inspect')process.stdout.write('not-json');
  else process.stdout.write(JSON.stringify({'credspan.deployment':mode==='wrong-owner'?'foreign':process.env.RUN_ID,'com.docker.compose.project':process.env.RUN_NAME,'com.docker.compose.service':'init'}));
}else if(a[0]==='rm'){
  if(mode==='gone-before-remove'){gone();process.exitCode=1;}
  else if(mode==='remove-error')process.exitCode=1;
  else gone();
}
`, { mode: 0o700 });
    for (const mode of ['empty', 'gone-before-inspect', 'gone-before-remove', 'wrong-owner', 'engine-error', 'still-present', 'remove-error', 'malformed-inspect', 'malformed-absence']) {
      const marker = join(directory, mode + '.marker'), log = join(directory, mode + '.jsonl'); await writeFile(log, '');
      const outcome = await cleanup({ endpoint: 'unix:///controlled-not-real.sock' }, run, { PATH: directory, MODE: mode, MARKER: marker, LOG: log, RUN_ID: run.id, RUN_NAME: run.name });
      const operations: string[][] = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.equal(outcome.complete, ['empty', 'gone-before-inspect', 'gone-before-remove'].includes(mode), mode);
      if (mode.startsWith('gone-')) { assert.equal(await readFile(marker, 'utf8'), 'removed'); assert.ok(operations.some(a => a.includes('id=' + id)), 'successful exact-ID absence query actually ran'); }
      if (mode === 'gone-before-remove') assert.ok(operations.some(a => a[0] === 'rm'));
      if (mode === 'wrong-owner') { assert.deepEqual(outcome, { complete: false, stage: 'container-inspect', code: 'ownership' }); assert.ok(!operations.some(a => a[0] === 'rm')); }
      if (mode === 'malformed-inspect') assert.ok(!operations.some(a => a.includes('id=' + id)), 'malformed metadata is never treated as disappearance');
      assert.ok(!JSON.stringify(outcome).includes('synthetic-secret-path-sentinel'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
