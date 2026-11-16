import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
async function snapshot() {
  const files = ['packages/sdk/openapi.json', ...(await readdir('packages/sdk/src/generated', { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => `${entry.parentPath}/${entry.name}`).sort()];
  return await Promise.all(files.map(async path => [path, await readFile(path, 'utf8')]));
}
const before = await snapshot();
const pnpm = process.env.npm_execpath;
assert.ok(pnpm, 'Run through pnpm check or pnpm check:generated');
execFileSync(pnpm, ['generate'], { stdio: 'inherit' });
assert.deepEqual(await snapshot(), before, 'OpenAPI/SDK changed: run pnpm generate and commit the updated artifacts');
console.log('Management contract and generated SDK are current.');
