import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { docker } from './local.mjs';
import { tool } from './tools.mjs';
import { offlineSigningConfig } from './signing.mjs';
import { verifyManifest } from './manifest.mjs';
export { verifyManifest } from './manifest.mjs';
export async function artifacts(directory, { interim = false } = {}) {
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty && !interim) throw Error('Artifact evidence requires a clean committed source tree');
  const image = docker(['image', 'inspect', 'credspan-api:local', '--format', '{{.Id}}']);
  const revision = docker(['image', 'inspect', image, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}']);
  if (revision !== (dirty ? 'interim-' : '') + source) throw Error('Image/source revision mismatch; build the current source first');
  directory = resolve(directory); await mkdir(directory, { mode: 0o700 });
  const archive = join(directory, 'image.tar'), sbom = join(directory, 'sbom.spdx.json'), scan = join(directory, 'vulnerabilities.json');
  docker(['image', 'save', '--output', archive, image], { timeout: 180000 }); await chmod(archive, 0o600);
  const run = (binary, args) => execFileSync(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 });
  run(await tool('syft'), ['docker-archive:' + archive, '-o', 'spdx-json=' + sbom]);
  run(await tool('trivy'), ['image', '--input', archive, '--scanners', 'vuln', '--format', 'json', '--output', scan, '--cache-dir', join(directory, 'scanner-cache')]);
  const report = JSON.parse(await readFile(scan)), counts = {};
  for (const result of report.Results ?? []) for (const finding of result.Vulnerabilities ?? []) counts[finding.Severity] = (counts[finding.Severity] ?? 0) + 1;
  const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
  const manifest = { source, interim: dirty, image, architecture: docker(['image', 'inspect', image, '--format', '{{.Architecture}}']), createdAt: new Date().toISOString(), tools: { syft: '1.57.1', trivy: '0.76.2', cosign: '3.1.4' }, sha256: { 'image.tar': await digest(archive), 'sbom.spdx.json': await digest(sbom), 'vulnerabilities.json': await digest(scan) }, vulnerabilityCounts: counts };
  const manifestPath = join(directory, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  return { manifest, manifestPath };
}
export async function signManifest(directory, manifestPath, keyFile) {
  await verifyManifest(directory, manifestPath, process.env.GITHUB_SHA);
  const key = await lstat(keyFile);
  if (!key.isFile() || key.uid !== process.getuid() || key.mode & 0o077 || key.size > 16384) throw Error('Signing key must be a private owned regular file');
  const binary = await tool('cosign'), config = await offlineSigningConfig(directory, binary), bundle = join(directory, 'manifest.sigstore.json'), publicKey = join(directory, 'signer.pub');
  const env = { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' };
  const run = args => execFileSync(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  await writeFile(publicKey, run(['public-key', '--key', keyFile]), { mode: 0o600 });
  run(['sign-blob', '--key', keyFile, '--signing-config', config, '--bundle', bundle, '--oidc-disable-ambient-providers', '--yes', manifestPath]);
  run(['verify-blob', '--key', publicKey, '--bundle', bundle, '--insecure-ignore-tlog', manifestPath]);
  return { bundle, publicKey };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2]);
  const result = await artifacts(directory, { interim: process.argv.includes('--interim') });
  if (process.env.COSIGN_KEY_FILE) await signManifest(directory, result.manifestPath, resolve(process.env.COSIGN_KEY_FILE));
  console.log(JSON.stringify(result.manifest));
}
