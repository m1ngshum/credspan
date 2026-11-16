import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { tool } from './tools.mjs';
import { verifyManifest } from './manifest.mjs';
export async function offlineSigningConfig(directory, binary) {
  const path = join(directory, 'offline-signing.json');
  execFileSync(binary, ['signing-config', 'create', '--out', path], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  const config = JSON.parse(await readFile(path));
  if (/https?:\/\//.test(JSON.stringify(config))) throw Error('Offline signing config must contain no remote services');
  return path;
}
export async function qualifySigning(manifestPath) {
  if (manifestPath) await verifyManifest(dirname(manifestPath), manifestPath);
  const binary = await tool('cosign'), directory = await mkdtemp(join(tmpdir(), 'credspan-signing-')); await chmod(directory, 0o700);
  // Fail closed if any public signing/timestamp/transparency request is attempted during qualification.
  const env = { ...process.env, COSIGN_PASSWORD: randomBytes(32).toString('hex'), HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' };
  const run = args => execFileSync(binary, args, { env, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  try {
    const config = await offlineSigningConfig(directory, binary), artifact = join(directory, 'artifact.txt'), bundle = join(directory, 'artifact.sigstore.json'), key = join(directory, 'test');
    const original = manifestPath ? await readFile(manifestPath) : Buffer.from('Synthetic private artifact; no publication.\n');
    await writeFile(artifact, original, { mode: 0o600 });
    run(['generate-key-pair', '--output-key-prefix', key]);
    run(['sign-blob', '--key', key + '.key', '--signing-config', config, '--bundle', bundle, '--oidc-disable-ambient-providers', '--yes', artifact]);
    run(['verify-blob', '--key', key + '.pub', '--bundle', bundle, '--insecure-ignore-tlog', artifact]);
    if (manifestPath) { await writeFile(manifestPath + '.qualification.sigstore.json', await readFile(bundle), { flag: 'wx', mode: 0o600 }); await writeFile(manifestPath + '.qualification.pub', await readFile(key + '.pub'), { flag: 'wx', mode: 0o600 }); }
    await writeFile(artifact, 'tampered synthetic artifact\n');
    assert.throws(() => run(['verify-blob', '--key', key + '.pub', '--bundle', bundle, '--insecure-ignore-tlog', artifact]));
    console.log(JSON.stringify({ tool: 'cosign', version: '3.1.4', privateOfflineSignatureVerified: true, tamperingRejected: true, transparencyUpload: false, publication: false, qualificationOnly: true, artifactSha256: createHash('sha256').update(original).digest('hex') }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[2] === 'qualify') await qualifySigning(process.argv[3]);
