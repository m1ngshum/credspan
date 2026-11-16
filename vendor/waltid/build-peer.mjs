import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, copyFile, lstat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildCommand } from './build-command.mjs';
const source = 'cf3c836cc78a9e64b2fd87933527327972e014da';
const dependencyPatchHash = '32cb0096a32693e17674038caa316605822c4b879e9cf5fad41008ea50b33041';
const patchHash = 'ed059fd9f91f8b371c2c35839ed5a350185ebea16d346054d286db83e05e73aa';
const base = 'waltid/wallet-api2:1.2.1@sha256:7937cfe2450e5521e272615179baef66f805459df391f2321b2f20ad92468614';
const jdk = 'eclipse-temurin:21-jdk@sha256:0a3f329821dcadf54b2a3033a15e2e9f007069a9db43d7f51897e6b80e726b07';
// Reserve memory for forked test JVMs alongside the in-process Kotlin compiler.
const gradle = [':waltid-libraries:protocols:waltid-openid4vci:jvmTest', ':waltid-services:waltid-wallet-api2:test', ':waltid-services:waltid-wallet-api2:installDist', '-Pversion=1.2.1', '-Dorg.gradle.jvmargs=-Xmx4g -XX:+UseParallelGC -Dfile.encoding=UTF-8', '--no-daemon', '--max-workers=2'];
const digest = data => createHash('sha256').update(data).digest('hex');
const patch = fileURLToPath(new URL('./preauthorized-only.patch', import.meta.url));
const dependencyPatch = fileURLToPath(new URL('./dependencies.patch', import.meta.url));
async function runtimeFiles(directory) {
  assert.ok((await lstat(directory)).isDirectory());
  const names = (await readdir(directory)).sort();
  assert.ok(names.some(name => name.endsWith('.jar')), 'Missing runtime jars');
  return Promise.all(names.map(async name => {
    assert.match(name, /^[a-zA-Z0-9_.-]+$/);
    assert.ok((await lstat(join(directory, name))).isFile());
    return { name, sha256: digest(await readFile(join(directory, name))) };
  }));
}
async function copyRuntime(source, destination, files) {
  await mkdir(destination, { recursive: true });
  for (const { name } of files) await copyFile(join(source, name), join(destination, name));
}
export async function peerInputs(arch = process.arch, platform = process.platform) {
  assert.ok(['arm64', 'x64'].includes(arch), 'Unsupported peer architecture');
  assert.equal(digest(await readFile(patch)), patchHash);
  assert.equal(digest(await readFile(dependencyPatch)), dependencyPatchHash);
  return { schema: 2, source, patchHash, dependencyPatchHash, base, jdk, gradle, arch, platform, scripts: await Promise.all(['build-peer.mjs', 'build-command.mjs'].map(async name => digest(await readFile(new URL(name, import.meta.url))))) };
}
export async function peerCacheKey(arch, platform) {
  return `peer-${digest(JSON.stringify(await peerInputs(arch, platform)))}`;
}
export async function buildPeer({ cacheDirectory = process.env.CREDSPAN_PEER_CACHE, run } = {}) {
  const inputs = await peerInputs(), key = await peerCacheKey();
  const dockerPlatform = `linux/${inputs.arch === 'x64' ? 'amd64' : 'arm64'}`;

  const directory = await mkdtemp(join(tmpdir(), 'credspan-peer-build-'));
  console.log(`Public-source build and logs: ${directory}`);
  const command = (stage, name, args, cwd = directory) => (run ?? buildCommand)(stage, name, args, { cwd, logDirectory: directory });
  const context = join(directory, 'image');
  await mkdir(context);
  const runtime = join(context, 'runtime');
  let cached = false;
  if (cacheDirectory) {
    try {
      assert.ok((await lstat(join(cacheDirectory, 'manifest.json'))).isFile());
      const manifest = JSON.parse(await readFile(join(cacheDirectory, 'manifest.json'), 'utf8'));
      assert.deepEqual(manifest.inputs, inputs);
      assert.equal(manifest.key, key);
      const files = await runtimeFiles(join(cacheDirectory, 'runtime'));
      assert.deepEqual(files, manifest.files);
      await copyRuntime(join(cacheDirectory, 'runtime'), runtime, files);
      cached = true;
    } catch { console.log('Peer cache missing or invalid; rebuilding and testing public source.'); }
  }
  if (!cached) {
    await rm(runtime, { recursive: true, force: true });
    await command('source-clone', 'git', ['clone', '--depth', '1', '--branch', 'v1.2.1', 'https://github.com/walt-id/waltid-identity.git', 'source']);
    assert.equal(await command('source-revision', 'git', ['rev-parse', 'HEAD'], join(directory, 'source')), source);
    await command('patch-check', 'git', ['apply', '--check', patch, dependencyPatch], join(directory, 'source'));
    await command('patch-apply', 'git', ['apply', patch, dependencyPatch], join(directory, 'source'));
    await command('jvm-test-jar', 'docker', ['run', '--rm', '--platform', dockerPlatform, '--name', `credspan-probe-build-${process.pid}`, '--mount', `type=bind,source=${join(directory, 'source')},target=/workspace`, '-w', '/workspace', '-e', 'GRADLE_USER_HOME=/workspace/.probe-gradle', jdk, 'timeout', '3300', './gradlew', ...gradle]);
    const distribution = join(directory, 'source/waltid-services/waltid-wallet-api2/build/install/waltid-wallet-api2');
    const libs = join(distribution, 'lib'), files = await runtimeFiles(libs);
    const assignments = (await readFile(join(distribution, 'bin/waltid-wallet-api2'), 'utf8')).match(/^CLASSPATH=.+$/gm);
    assert.equal(assignments?.length, 1, 'Expected one generated runtime classpath');
    const names = assignments[0].slice('CLASSPATH='.length).split(':').map(entry => {
      assert.match(entry, /^\$APP_HOME\/lib\/[a-zA-Z0-9_.-]+\.jar$/);
      return entry.slice('$APP_HOME/lib/'.length);
    });
    assert.equal(names[0], 'waltid-wallet-api2-1.2.1.jar', 'Service resources must precede dependencies');
    assert.deepEqual([...names].sort(), files.filter(file => file.name.endsWith('.jar')).map(file => file.name));
    await copyRuntime(libs, runtime, files);
    await writeFile(join(runtime, 'classpath'), names.map(name => '/app/libs/' + name).join(':') + '\n');
    for (const name of ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICE.md']) await copyFile(join(directory, 'source', name), join(runtime, name));
    await copyFile(join(directory, 'source/waltid-services/waltid-wallet-api2/THIRD-PARTY-NOTICE.md'), join(runtime, 'wallet-THIRD-PARTY-NOTICE.md'));
    if (cacheDirectory) {
      await mkdir(cacheDirectory, { recursive: true });
      await rm(join(cacheDirectory, 'manifest.json'), { force: true });
      await rm(join(cacheDirectory, 'runtime'), { recursive: true, force: true });
      const files = await runtimeFiles(runtime);
      await copyRuntime(runtime, join(cacheDirectory, 'runtime'), files);
      await writeFile(join(cacheDirectory, 'manifest.json'), JSON.stringify({ key, inputs, files }) + '\n', { flag: 'wx' });
    }
  }
  console.log(`Peer JVM qualification: ${cached ? 'verified cache' : 'fresh tests/build'} (${inputs.arch})`);
  await copyFile(join(runtime, 'classpath'), join(context, 'classpath'));
  await writeFile(join(context, 'Dockerfile'), `FROM ${base}\nLABEL org.opencontainers.image.title="Credspan modified walt.id Wallet API v2 1.2.1 sandbox peer"\nLABEL org.opencontainers.image.revision="${source}"\nLABEL credspan.probe.patch.sha256="${patchHash}" credspan.dependencies.patch.sha256="${dependencyPatchHash}"\nRUN sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources && apt-get -o Acquire::Retries=0 update && apt-get -o Acquire::Retries=0 install -y --no-install-recommends apt=3.2.1ubuntu0.1 libapt-pkg7.0=3.2.1ubuntu0.1 libc6=2.43-2ubuntu2.7 libc-bin=2.43-2ubuntu2.7 libc-gconv-modules-extra=2.43-2ubuntu2.7 locales=2.43-2ubuntu2.7 libpcre2-8-0=10.46-1ubuntu0.1 perl-base=5.40.1-7ubuntu0.4 && rm -rf /var/lib/apt/lists/* /app /usr/bin/pebble && mkdir -p /app/libs\nCOPY runtime/ /app/libs/\nCOPY classpath /app/jib-classpath-file\n`);
  await command('image-build', 'docker', ['build', '--platform', dockerPlatform, '-t', 'credspan-wallet-peer:1.2.1-preauth', '-f', join(context, 'Dockerfile'), context]);
  console.log(await command('image-inspect', 'docker', ['image', 'inspect', 'credspan-wallet-peer:1.2.1-preauth', '--format', '{{.Id}}']));
  console.log('Built local modified peer; no image was published. Remove the printed temporary build directory when its logs are no longer needed.');

  return { cached, directory };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--cache-key') console.log(await peerCacheKey());
  else await buildPeer();
}
