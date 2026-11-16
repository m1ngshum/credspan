import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyManifest } from './artifacts.mjs';
import { requireReleaseCi } from './release-gate.mjs';
test('signing rejects missing, tampered, interim or different-source artifact sets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-manifest-'));
  try {
    const manifest = { source: 'a'.repeat(40), interim: false, image: 'sha256:' + 'b'.repeat(64), sha256: {} };
    for (const name of ['image.tar', 'sbom.spdx.json', 'vulnerabilities.json']) { await writeFile(join(directory, name), name); manifest.sha256[name] = createHash('sha256').update(name).digest('hex'); }
    const path = join(directory, 'manifest.json'), save = () => writeFile(path, JSON.stringify(manifest)); await save();
    await verifyManifest(directory, path, manifest.source);
    await assert.rejects(verifyManifest(directory, path, 'c'.repeat(40)));
    manifest.interim = true; await save(); await assert.rejects(verifyManifest(directory, path));
    manifest.interim = false; await save();
    await writeFile(join(directory, 'image.tar'), 'tampered'); await assert.rejects(verifyManifest(directory, path));
    const cli = spawnSync(process.execPath, ['ops/signing.mjs', 'qualify', path], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000 });
    assert.equal(cli.status, 1); assert.match(cli.stderr, /Artifact hash mismatch/);
    await rm(join(directory, 'image.tar')); await assert.rejects(verifyManifest(directory, path));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('release requires exact main push CI success and its successful required job', async () => {
  const env = { GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'synthetic' };
  let run = { id: 1, head_sha: env.GITHUB_SHA, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
  let job = { name: 'ci', status: 'completed', conclusion: 'success' };
  const request = async url => ({ ok: true, json: async () => url.includes('/jobs?') ? { jobs: [job] } : { workflow_runs: [run] } });
  await requireReleaseCi(env, request);
  await assert.rejects(requireReleaseCi({ ...env, GITHUB_REF: 'refs/heads/feature' }, request));
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { conclusion: 'failure' }, { status: 'in_progress' }]) { const previous = run; run = { ...run, ...patch }; await assert.rejects(requireReleaseCi(env, request)); run = previous; }
  job = { ...job, conclusion: 'skipped' }; await assert.rejects(requireReleaseCi(env, request));
});
