import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptBackup, withVerifiedBackup, restoreProcessBackup } from './backup.mjs';

test('restore waits for child success and retires children after input or process failure', { timeout: 15000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { PassThrough } = await import('node:stream');
  const { once } = await import('node:events');
  const launch = script => spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
  const success = launch("process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.exit(0),50))");
  await restoreProcessBackup(success, Readable.from('archive'));
  assert.equal(success.exitCode, 0);
  const nonzero = launch("process.stdin.resume();process.stdin.on('end',()=>process.exit(7))");
  await assert.rejects(restoreProcessBackup(nonzero, Readable.from('archive')), /Database restore failed/);
  assert.equal(nonzero.exitCode, 7);
  const missing = spawn('/nonexistent-credspan-restore-command', [], { stdio: ['pipe', 'ignore', 'ignore'] });
  let spawnClosed = false; missing.once('close', () => { spawnClosed = true; });
  await assert.rejects(restoreProcessBackup(missing, Readable.from('archive')), /Database restore failed/);
  assert.equal(spawnClosed, true);
  for (const failure of ['source', 'stdin']) {
    const child = launch("process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)");
    try {
      await once(child.stdout, 'data'); child.stdout.destroy();
      const input = new PassThrough();
      let closed = false; child.once('close', () => { closed = true; });
      const restored = restoreProcessBackup(child, input);
      if (failure === 'source') input.destroy(Error('synthetic input failure'));
      else child.stdin.destroy(Error('synthetic stdin failure'));
      await assert.rejects(restored, /Database restore failed/);
      assert.equal(closed, true); assert.equal(child.signalCode, 'SIGKILL');
      assert.equal(input.destroyed, true); assert.equal(child.stdin.destroyed, true);
    } finally { child.kill('SIGKILL'); }
  }
});
test('backup is fully authenticated before restore callback and rejects wrong key or tamper', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-backup-test-')), key = randomBytes(32), original = randomBytes(100000);
  const path = join(directory, 'archive.enc'); let restorations = 0;
  try {
    await encryptBackup(Readable.from(original), key, path);
    await withVerifiedBackup(path, key, async verified => { restorations++; assert.deepEqual(await readFile(verified), original); });
    assert.equal(restorations, 1);
    await assert.rejects(withVerifiedBackup(path, randomBytes(32), async () => { restorations++; })); assert.equal(restorations, 1);
    const corrupted = await readFile(path); corrupted[30] ^= 1; await writeFile(path, corrupted);
    await assert.rejects(withVerifiedBackup(path, key, async () => { restorations++; })); assert.equal(restorations, 1);
    await assert.rejects(encryptBackup(Readable.from(original), key, path), /EEXIST/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed export emitting bytes leaves no encrypted archive and reaps its child', async () => {
  const { spawn } = await import('node:child_process');
  const { access } = await import('node:fs/promises');
  const { encryptProcessBackup } = await import('./backup.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'credspan-export-fail-'));
  try {
    const destination = join(directory, 'incomplete.enc');
    const child = spawn(process.execPath, ['-e', "process.stdout.write(Buffer.alloc(65536)); process.exitCode=1"], { stdio: ['ignore', 'pipe', 'ignore'] });
    await assert.rejects(encryptProcessBackup(child, randomBytes(32), destination));
    await assert.rejects(access(destination)); assert.equal(child.exitCode, 1);
    await writeFile(destination, 'existing archive');
    const duplicate = spawn(process.execPath, ['-e', "process.stdout.write('export');process.exitCode=1"], { stdio: ['ignore', 'pipe', 'ignore'] });
    await assert.rejects(encryptProcessBackup(duplicate, randomBytes(32), destination));
    assert.equal(await readFile(destination, 'utf8'), 'existing archive');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
