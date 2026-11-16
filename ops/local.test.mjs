import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
test('remote Docker overrides fail before any daemon request or apply', () => {
  for (const endpoint of ['tcp://example.invalid:2376', 'ssh://example.invalid']) {
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', "import {dockerBoundary} from './ops/local.mjs';dockerBoundary()"], { cwd: new URL('..', import.meta.url), env: { ...process.env, DOCKER_HOST: endpoint }, stdio: ['ignore', 'pipe', 'pipe'] }));
  }
});

test('initialization rejects names that cannot be reopened by load before Docker or writes', async () => {
  const { init } = await import('./local.mjs');
  for (const name of ['example', 'credspan-', 'credspan-' + 'x'.repeat(32)]) {
    await assert.rejects(init('/unused-invalid-project', { name, image: 'sha256:' + 'a'.repeat(64) }), /Invalid local target/);
  }
});

test('internal deployment UUID rejects invalid format/version before any mutation', async () => {
  const { init } = await import('./local.mjs');
  const { mkdtemp, access, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'credspan-invalid-uuid-'));
  try {
    for (const deploymentId of ['not-a-uuid', '00000000-0000-1000-8000-000000000000', '00000000-0000-4000-0000-000000000000']) {
      const target = join(directory, 'must-not-exist');
      await assert.rejects(init(target, { name: 'credspan-invalid-uuid', image: 'sha256:' + 'a'.repeat(64), deploymentId }), /Invalid local target/);
      await assert.rejects(access(target));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('initialization rejects historical wallet peers before creating secrets or volumes', async () => {
  const { mkdtemp, writeFile, access, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'credspan-old-peer-'));
  try {
    await writeFile(join(directory, 'docker'), `#!${process.execPath}
const args = process.argv.slice(4);
if (args[0] === 'ps' || (['volume', 'network'].includes(args[0]) && args[1] === 'ls')) process.exit(0);
if (args[0] !== 'image' || args[1] !== 'inspect') process.exit(9);
const format = args.at(-1);
console.log(format === '{{.Id}}' ? 'sha256:' + 'a'.repeat(64) : format.includes('probe.patch') ? 'ed059fd9f91f8b371c2c35839ed5a350185ebea16d346054d286db83e05e73aa' : process.env.PEER_DEPENDENCY_PATCH);
`, { mode: 0o700 });
    for (const [index, peerPatch] of ['', 'outdated-dependency-patch'].entries()) {
      const target = join(directory, 'project-' + index);
      const script = `import {init} from './ops/local.mjs';try { await init(${JSON.stringify(target)}, {image:'sha256:'+'a'.repeat(64)}); } catch(error) { console.log(error.message); }`;
      const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env: { ...process.env, PATH: directory + ':' + process.env.PATH, DOCKER_HOST: 'unix:///fixture/docker.sock', PEER_DEPENDENCY_PATCH: peerPatch }, encoding: 'utf8' });
      assert.equal(result.trim(), 'Unqualified wallet peer');
      await assert.rejects(access(join(target, 'secrets')));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
