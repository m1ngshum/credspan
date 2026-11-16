import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docsOnly, classify, checkResults } from './ci-plan.mjs';

test('only explicit documents qualify; all runtime, build, test and unknown paths fail closed', () => {
  assert.equal(docsOnly(['README.md', 'docs/hosted-sandbox.md', 'docs/nested/guide.md']), true);
  for (const path of ['package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml', 'vendor/waltid/build-peer.mjs', 'ops/build.mjs', 'packages/api/test.md', 'docs/example.mjs', 'docs/assets/logo.png', 'unknown.md', 'README.md\npackage.json']) assert.equal(docsOnly(['README.md', path]), false, path);
  assert.equal(docsOnly([]), false);
});

test('PR aggregate diff checks both sides of renames and defaults full on incomplete evidence', () => {
  const input = { event: 'pull_request', base: 'a'.repeat(40), head: 'b'.repeat(40) };
  assert.equal(classify(input, args => { assert.deepEqual(args, ['diff', '--name-only', '--no-renames', '-z', `${input.base}...${input.head}`, '--']); return 'docs/guide.md\0'; }), true);
  for (const output of ['', 'README.md', 'README.md\0packages/api/main.ts\0']) assert.equal(classify(input, () => output), false);
  assert.equal(classify(input, () => { throw Error('shallow/missing base'); }), false);
  assert.equal(classify({ ...input, base: '' }), false);
  assert.equal(classify({ ...input, event: 'push' }, () => { throw Error('must not run'); }), false);
});

test('real aggregate Git diff retains earlier runtime edits and the runtime side of a rename', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'credspan-ci-plan-'));
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = () => { git(['add', '.']); git(['commit', '-m', 'synthetic fixture']); return git(['rev-parse', 'HEAD']).trim(); };
  try {
    git(['init']); git(['config', 'user.name', 'CI fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    await mkdir(join(cwd, 'runtime')); await mkdir(join(cwd, 'docs'));
    await writeFile(join(cwd, 'runtime/code.mjs'), 'export const value = 1;');
    const base = commit();
    await writeFile(join(cwd, 'docs/guide.md'), 'Documentation');
    const docsHead = commit();
    assert.equal(classify({ event: 'pull_request', base, head: docsHead }, git), true);
    await rename(join(cwd, 'runtime/code.mjs'), join(cwd, 'docs/code.md'));
    const renamedHead = commit();
    assert.equal(classify({ event: 'pull_request', base, head: renamedHead }, git), false);
    await writeFile(join(cwd, 'docs/guide.md'), 'Later documentation edit');
    assert.equal(classify({ event: 'pull_request', base, head: commit() }, git), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('workflow keeps full coverage and an always-evaluated gate; only main can save peer caches', () => {
  const text = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /paths-ignore:|restore-keys:|uses: actions\/cache@/);
  assert.match(text, /runner: \[ubuntu-24\.04, ubuntu-24\.04-arm\]/);
  assert.match(text, /ref: 84f16d82ef3851d78a5f7dcd789280601e088789/);
  assert.match(text, /needs: \[changes, native, integration, mcp\]\n    if: always\(\)/);
  assert.match(text, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/);
  assert.equal([...text.matchAll(/uses: actions\/cache\/save@/g)].length, 2);
  assert.equal([...text.matchAll(/- if: github.event_name == 'push' && github.ref == 'refs\/heads\/main' && steps.peer-cache.outputs.cache-hit != 'true'\n        uses: actions\/cache\/save@/g)].length, 2);
});

test('required gate permits only expected fast/full results, never failures or accidental skips', () => {
  const needs = docs => ({ changes: { result: 'success', outputs: { docs } }, ...Object.fromEntries(['native', 'integration', 'mcp'].map(job => [job, { result: docs === 'true' ? 'skipped' : 'success' }])) });
  for (const docs of ['true', 'false']) {
    checkResults(needs(docs));
    for (const job of ['changes', 'native', 'integration', 'mcp']) for (const result of ['failure', 'cancelled', 'skipped', 'success']) {
      const bad = needs(docs);
      if (bad[job].result === result) continue;
      bad[job].result = result;
      assert.throws(() => checkResults(bad));
    }
  }
  for (const docs of ['', 'yes', undefined]) assert.throws(() => checkResults(needs(docs)));
  assert.throws(() => checkResults({}));
});
