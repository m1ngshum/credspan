import assert from 'node:assert/strict';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageGenerationWorkspace } from './generated-workspace.mjs';

const pnpm = process.env.npm_execpath;
assert.ok(pnpm, 'Run through pnpm check or pnpm check:generated');
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'credspan-generated-'));
const contract = 'packages/sdk/openapi.json';
const generated = 'packages/sdk/src/generated';
const drift = 'OpenAPI/SDK changed: run pnpm generate and commit the updated artifacts';

function statIfPresent(path) {
  return lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function entries(dir) {
  const base = join(dir, generated);
  assert.ok((await statIfPresent(base))?.isDirectory(), drift);
  return (await readdir(base, { recursive: true, withFileTypes: true }))
    .map(entry => ({
      path: relative(dir, join(entry.parentPath, entry.name)),
      kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

try {
  await stageGenerationWorkspace(root, scratch);
  execFileSync(pnpm, ['generate'], { cwd: scratch, stdio: 'inherit' });
  const expected = await entries(scratch);
  assert.deepEqual(await entries(root), expected, drift);
  const files = [contract, ...expected.filter(entry => entry.kind === 'file').map(entry => entry.path)];
  for (const path of files) {
    const actual = join(root, path);
    const info = await statIfPresent(actual);
    assert.ok(info?.isFile() && (await readFile(actual)).equals(await readFile(join(scratch, path))), drift);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log('Management contract and generated SDK are current.');
