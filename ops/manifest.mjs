import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export async function verifyManifest(directory, manifestPath, expectedSource) {
  const manifest = JSON.parse(await readFile(manifestPath));
  const names = ['image.tar', 'sbom.spdx.json', 'vulnerabilities.json'];
  if (manifest.interim !== false || !/^[a-f0-9]{40}$/.test(manifest.source) || (expectedSource && manifest.source !== expectedSource) || !/^sha256:[a-f0-9]{64}$/.test(manifest.image) || !manifest.sha256 || Object.keys(manifest.sha256).sort().join() !== [...names].sort().join()) throw Error('Invalid clean-source artifact manifest');
  for (const name of names) {
    const path = join(directory, name), info = await lstat(path);
    if (!info.isFile() || !/^[a-f0-9]{64}$/.test(manifest.sha256[name]) || createHash('sha256').update(await readFile(path)).digest('hex') !== manifest.sha256[name]) throw Error('Artifact hash mismatch');
  }
  return manifest;
}
