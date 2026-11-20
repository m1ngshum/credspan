import assert from 'node:assert/strict';
import { cp, lstat, symlink } from 'node:fs/promises';
import { join, relative } from 'node:path';

const generated = 'packages/sdk/src/generated';
const inputs = [
  'package.json', 'pnpm-workspace.yaml', 'node_modules',
  'apps/api/package.json', 'apps/api/tsconfig.json', 'apps/api/tsconfig.export.json',
  'apps/api/src', 'apps/api/tests', 'apps/api/node_modules',
  'packages/sdk/package.json', 'packages/sdk/tsconfig.json', 'packages/sdk/openapi-ts.config.ts',
  'packages/sdk/generate.mjs', 'packages/sdk/src', 'packages/sdk/node_modules',
  'scripts/check-openapi-input.mjs', 'scripts/check-generated.mjs', 'scripts/generated-workspace.mjs',
];
const excluded = new Set([generated, 'node_modules/.pnpm']);

export async function stageGenerationWorkspace(root, scratch) {
  // Reuse installed dependencies while keeping workspace links and build outputs local to scratch.
  for (const path of inputs) {
    await cp(join(root, path), join(scratch, path), {
      recursive: true,
      verbatimSymlinks: true,
      filter: source => !excluded.has(relative(root, source)),
    });
  }
  for (const path of ['node_modules', 'packages/sdk/src']) {
    assert.ok((await lstat(join(scratch, path))).isDirectory(), `Expected a real directory at ${path}`);
  }
  await symlink(join(root, 'node_modules/.pnpm'), join(scratch, 'node_modules/.pnpm'), 'dir');
}
