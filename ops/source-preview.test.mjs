import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

test('source preview archives the requested commit and records the exact upload bytes', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'credspan-source-preview-'));
  const script = fileURLToPath(new URL('./source-preview.mjs', import.meta.url));
  const git = (args, options = {}) => execFileSync('git', args, { cwd, stdio: 'pipe', ...options });
  const pack = (version, commit, directory) => spawnSync(process.execPath, [script, version, commit, directory], { cwd, encoding: 'utf8' });
  try {
    git(['init']);
    writeFileSync(join(cwd, 'README.md'), 'reviewed\n');
    git(['add', 'README.md']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    const commit = git(['rev-parse', 'HEAD']).toString().trim();
    writeFileSync(join(cwd, 'README.md'), 'uncommitted\n');
    writeFileSync(join(cwd, 'private.txt'), 'untracked\n');
    const version = 'v0.1.0-preview.1';
    const result = pack(version, commit, 'candidate');
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(cwd, 'candidate/source-preview.json'), 'utf8'));
    assert.equal(manifest.version, version);
    assert.equal(manifest.commit, commit);
    assert.equal(manifest.tree, git(['rev-parse', 'HEAD^{tree}']).toString().trim());
    assert.equal(manifest.archive, `credspan-${version}.tar.gz`);
    const bytes = readFileSync(join(cwd, 'candidate', manifest.archive));
    const tar = gunzipSync(bytes);
    assert.equal(manifest.bytes, bytes.length);
    assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(git(['get-tar-commit-id'], { input: tar }).toString().trim(), commit);
    assert.deepEqual(tar, git(['-c', 'tar.umask=0002', 'archive', '--format=tar', `--prefix=credspan-${version}/`, commit]));
    assert.match(pack('../local', commit, 'invalid').stderr, /Expected v0/);
    assert.match(pack(version, '0'.repeat(40), 'invalid').stderr, /Checked-out commit differs/);
    const existing = pack(version, commit, 'candidate');
    assert.equal(existing.status, 1);
    assert.match(existing.stderr, /EEXIST/);
    assert.deepEqual(readFileSync(join(cwd, 'candidate', manifest.archive)), bytes);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
