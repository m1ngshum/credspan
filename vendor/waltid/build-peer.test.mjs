import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPeer, peerInputs, peerCacheKey } from './build-peer.mjs';

test('peer key qualifies exact source, patch, build scripts, JDK, Gradle, base and architecture', async () => {
  const inputs = await peerInputs('arm64', 'linux');
  assert.match(inputs.source, /^[a-f0-9]{40}$/);
  assert.match(inputs.patchHash, /^[a-f0-9]{64}$/);
  assert.equal(inputs.scripts.length, 2);
  assert.ok(inputs.scripts.every(hash => /^[a-f0-9]{64}$/.test(hash)));
  for (const image of [inputs.base, inputs.jdk]) assert.match(image, /@sha256:[a-f0-9]{64}$/);
  for (const task of [':waltid-libraries:protocols:waltid-openid4vci:jvmTest', ':waltid-services:waltid-wallet-api2:test', ':waltid-services:waltid-wallet-api2:installDist', '-Pversion=1.2.1', '-Dorg.gradle.jvmargs=-Xmx4g -XX:+UseParallelGC -Dfile.encoding=UTF-8']) assert.ok(inputs.gradle.includes(task));
  assert.notEqual(await peerCacheKey('x64', 'linux'), await peerCacheKey('arm64', 'linux'));
  assert.notEqual(await peerCacheKey('arm64', 'linux'), await peerCacheKey('arm64', 'darwin'));
  await assert.rejects(peerCacheKey('unknown', 'linux'));
});

test('actual peer builder consumes qualified distribution on warm path, rebuilds corruption and changed inputs', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'credspan-peer-cache-test-')), directories = [], stages = [];
  const orderedClasspath = 'CLASSPATH=$APP_HOME/lib/waltid-wallet-api2-1.2.1.jar:$APP_HOME/lib/waltid-openid4vci-jvm-1.2.1.jar\n';
  let launcher = orderedClasspath;
  // Command stand-in tests orchestration only; it does not claim real JVM/Docker qualification.
  const run = async (stage, name, args, { cwd }) => {
    stages.push(stage);
    if (stage === 'source-revision') return (await peerInputs()).source;
    if (stage === 'jvm-test-jar') {
      assert.equal(name, 'docker');
      assert.ok(args.includes(`linux/${process.arch === 'x64' ? 'amd64' : 'arm64'}`));
      const libs = join(cwd, 'source/waltid-services/waltid-wallet-api2/build/install/waltid-wallet-api2/lib');
      await mkdir(libs, { recursive: true });
      await mkdir(join(libs, '../bin'));
      await writeFile(join(libs, '../bin/waltid-wallet-api2'), launcher);
      for (const name of ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICE.md']) await writeFile(join(cwd, 'source', name), 'synthetic-notice');
      await writeFile(join(cwd, 'source/waltid-services/waltid-wallet-api2/THIRD-PARTY-NOTICE.md'), 'synthetic-notice');
      await writeFile(join(libs, 'waltid-wallet-api2-1.2.1.jar'), 'synthetic-service-jar');
      await writeFile(join(libs, 'waltid-openid4vci-jvm-1.2.1.jar'), 'synthetic-tested-jar');
    }
    if (stage === 'image-build') {
      assert.equal(await readFile(join(args.at(-1), 'runtime/waltid-openid4vci-jvm-1.2.1.jar'), 'utf8'), 'synthetic-tested-jar');
      assert.equal(await readFile(join(args.at(-1), 'classpath'), 'utf8'), '/app/libs/waltid-wallet-api2-1.2.1.jar:/app/libs/waltid-openid4vci-jvm-1.2.1.jar\n');
    }
    return stage === 'image-inspect' ? 'synthetic-image-id' : '';
  };
  const build = async cached => {
    stages.length = 0;
    const result = await buildPeer({ cacheDirectory, run });
    directories.push(result.directory);
    assert.equal(result.cached, cached);
    assert.equal(stages.includes('jvm-test-jar'), !cached);
    assert.equal(stages.includes('source-clone'), !cached);
    assert.ok(stages.includes('image-build'));
  };
  try {
    await build(false);
    await build(true);
    await writeFile(join(cacheDirectory, 'runtime/stale.jar'), 'extra');
    await build(false);
    await rm(join(cacheDirectory, 'runtime/waltid-openid4vci-jvm-1.2.1.jar'));
    await symlink(join(cacheDirectory, 'runtime/NOTICE.md'), join(cacheDirectory, 'runtime/waltid-openid4vci-jvm-1.2.1.jar'));
    await build(false);
    await writeFile(join(cacheDirectory, 'runtime/waltid-openid4vci-jvm-1.2.1.jar'), 'tampered-jar');
    await build(false);
    for (const field of ['source', 'patchHash', 'dependencyPatchHash', 'base', 'jdk', 'gradle', 'scripts', 'arch', 'platform']) {
      const manifest = JSON.parse(await readFile(join(cacheDirectory, 'manifest.json'), 'utf8'));
      manifest.inputs[field] = 'changed-input';
      await writeFile(join(cacheDirectory, 'manifest.json'), JSON.stringify(manifest));
      await build(false);
    }
    await writeFile(join(cacheDirectory, 'manifest.json'), '{broken');
    await build(false);
    await writeFile(join(cacheDirectory, 'runtime/classpath'), '/app/libs/*\n');
    await build(false);
    for (launcher of ['CLASSPATH=$APP_HOME/lib/waltid-openid4vci-jvm-1.2.1.jar:$APP_HOME/lib/waltid-wallet-api2-1.2.1.jar\n', orderedClasspath.repeat(2), 'CLASSPATH=$APP_HOME/lib/*\n', orderedClasspath.replace('waltid-openid4vci-jvm', '../waltid-openid4vci-jvm'), orderedClasspath.replace(':$APP_HOME/lib/waltid-openid4vci-jvm-1.2.1.jar', ''), orderedClasspath.replace('waltid-openid4vci-jvm-1.2.1.jar', 'missing.jar')]) {
      await rm(join(cacheDirectory, 'manifest.json'), { force: true });
      await assert.rejects(buildPeer({ cacheDirectory, run: async (...args) => {
        if (args[0] === 'source-clone') directories.push(args[3].cwd);
        return run(...args);
      } }));
      await assert.rejects(readFile(join(cacheDirectory, 'manifest.json')), { code: 'ENOENT' });
    }
  } finally {
    await Promise.all([cacheDirectory, ...directories].map(path => rm(path, { recursive: true, force: true })));
  }
});

test('failed JVM qualification never writes a reusable cache entry', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'credspan-peer-cache-failure-'));
  let directory;
  try {
    await assert.rejects(buildPeer({ cacheDirectory, run: async (stage, name, args, { cwd }) => {
      directory = cwd;
      if (stage === 'source-revision') return (await peerInputs()).source;
      if (stage === 'jvm-test-jar') throw Error('synthetic failing JVM tests');
      return '';
    } }), /failing JVM tests/);
    await assert.rejects(readFile(join(cacheDirectory, 'manifest.json')), { code: 'ENOENT' });
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); if (directory) await rm(directory, { recursive: true, force: true }); }
});
