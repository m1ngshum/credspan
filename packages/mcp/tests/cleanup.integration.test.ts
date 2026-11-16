import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup } from '../src/cleanup.js';
import { docker, localDocker, minimalEnvironment } from '../src/process.js';
import { cachedImages } from '../src/profile.js';
const exec = promisify(execFile);

test('real auto-removed init container may disappear between snapshot, inspection and removal', { timeout: 30000 }, async () => {
  const boundary = await localDocker(), images = await cachedImages(boundary);
  const realDocker = (await exec('which', ['docker'])).stdout.trim();
  const directory = await mkdtemp(join(tmpdir(), 'credspan-cleanup-real-'));
  const unrelatedUuid = randomUUID();
  const unrelated = await docker(boundary, ['run', '-d', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--label', 'credspan.deployment=' + unrelatedUuid, images.api, 'node', '-e', 'setInterval(()=>{},10000)']);
  try {
    const proxy = await readFile(new URL('../../tests/fixtures/cleanup-proxy.cjs', import.meta.url), 'utf8');
    await writeFile(join(directory, 'docker'), `#!${process.execPath}\n` + proxy, { mode: 0o700 });
    for (const mode of ['inspect', 'remove']) {
      const uuid = randomUUID(), run = { id: uuid, name: 'credspan-mcp-' + uuid.replaceAll('-', '').slice(0, 24), directory: join(directory, mode) };
      const id = await docker(boundary, ['run', '--rm', '-d', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--label', 'credspan.deployment=' + uuid, '--label', 'com.docker.compose.project=' + run.name, '--label', 'com.docker.compose.service=init', images.api, 'node', '-e', 'setInterval(()=>{},10000)']);
      assert.match(id, /^[a-f0-9]{64}$/);
      try {
        const marker = join(directory, mode + '.json'), report = join(directory, mode + '-report.json');
        const outcome = await cleanup(boundary, run, { ...minimalEnvironment(), PATH: directory, REAL_DOCKER: realDocker, OWNED_ID: id, RUN_ID: uuid, MODE: mode, MARKER: marker, REPORT: report });
        // Preserve the cleanup outcome and fixed hook phase even if the marker was never written.
        const hook = await readFile(report, 'utf8').then(value => JSON.parse(value), () => ({ stage: 'not-started', code: 'missing-report' }));
        let observed: unknown;
        try { observed = JSON.parse(await readFile(marker, 'utf8')); } catch { assert.fail('Missing race marker: ' + JSON.stringify({ mode, outcome, hook })); }
        assert.deepEqual(observed, { hookExecuted: true, exactIdAbsent: true });
        assert.deepEqual(outcome, { complete: true }, mode);
        assert.equal(await docker(boundary, ['ps', '-aq', '--no-trunc', '--filter', 'id=' + id]), '');
        assert.equal(await docker(boundary, ['ps', '-q', '--no-trunc', '--filter', 'id=' + unrelated]), unrelated, 'unrelated exact UUID container remains running');
        assert.equal(JSON.parse(await docker(boundary, ['inspect', unrelated, '--format', '{{json .Config.Labels}}']))['credspan.deployment'], unrelatedUuid);
      } finally {
        if (await docker(boundary, ['ps', '-aq', '--no-trunc', '--filter', 'id=' + id])) {
          const labels = JSON.parse(await docker(boundary, ['inspect', id, '--format', '{{json .Config.Labels}}'])); assert.equal(labels['credspan.deployment'], uuid);
          await docker(boundary, ['rm', '-f', id]);
        }
      }
    }
  } finally {
    assert.equal(JSON.parse(await docker(boundary, ['inspect', unrelated, '--format', '{{json .Config.Labels}}']))['credspan.deployment'], unrelatedUuid);
    await docker(boundary, ['rm', '-f', unrelated]);
    await rm(directory, { recursive: true, force: true });
  }
});
