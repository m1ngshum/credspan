import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stageGenerationWorkspace } from './generated-workspace.mjs';

test('generated drift checks preserve contributor edits and reject a linked output parent', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pnpm = process.env.npm_execpath;
  assert.ok(pnpm, 'Run through pnpm check');
  const fixture = await mkdtemp(join(tmpdir(), 'credspan-drift-test-'));
  const check = (message) => {
    const result = spawnSync(pnpm, ['check:generated'], { cwd: fixture, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
  };
  try {
    await stageGenerationWorkspace(root, fixture);
    await cp(join(root, 'packages/sdk/openapi.json'), join(fixture, 'packages/sdk/openapi.json'));
    await cp(join(root, 'packages/sdk/src/generated'), join(fixture, 'packages/sdk/src/generated'), { recursive: true });
    const src = join(fixture, 'packages/sdk/src');
    const edit = Buffer.concat([await readFile(join(src, 'generated/sdk.gen.ts')), Buffer.from('\n// contributor edit\n')]);
    const sentinel = Buffer.from('untracked contributor file\n');
    await writeFile(join(src, 'generated/sdk.gen.ts'), edit);
    await writeFile(join(src, 'generated/sentinel.txt'), sentinel);

    for (let attempt = 0; attempt < 2; attempt++) {
      check(/OpenAPI\/SDK changed/);
      assert.deepEqual(await readFile(join(src, 'generated/sdk.gen.ts')), edit);
      assert.deepEqual(await readFile(join(src, 'generated/sentinel.txt')), sentinel);
    }

    const linkedSource = join(fixture, 'linked-sdk-source');
    await rename(src, linkedSource);
    await symlink(linkedSource, src, 'dir');
    check(/Expected a real directory at packages\/sdk\/src/);
    assert.deepEqual(await readFile(join(linkedSource, 'generated/sdk.gen.ts')), edit);
    assert.deepEqual(await readFile(join(linkedSource, 'generated/sentinel.txt')), sentinel);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
