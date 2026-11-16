import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptBackup, withVerifiedBackup } from './backup.mjs';
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
