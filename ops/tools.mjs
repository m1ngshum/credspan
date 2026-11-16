import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const lock = JSON.parse(await readFile(new URL('./tools-lock.json', import.meta.url)));
export async function tool(name) {
  const selected = lock[name], entry = selected?.[`${process.platform}-${process.arch}`];
  if (!entry) throw Error('Unqualified tool platform');
  const directory = new URL(`./.cache/tools/${name}-${selected.version}/${process.platform}-${process.arch}/`, import.meta.url); await mkdir(directory, { recursive: true });
  const archive = new URL(entry.asset, directory);
  let bytes; try { bytes = await readFile(archive); } catch {}
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    const response = await fetch(selected.base + entry.asset, { signal: AbortSignal.timeout(120000) }); if (!response.ok) throw Error('Tool download failed');
    bytes = Buffer.from(await response.arrayBuffer()); if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw Error('Tool checksum mismatch'); await writeFile(archive, bytes, { mode: 0o600 });
  }
  const binary = new URL(entry.asset.endsWith('.tar.gz') ? name : entry.asset, directory);
  if (entry.asset.endsWith('.tar.gz')) execFileSync('tar', ['-xzf', archive.pathname, '-C', directory.pathname, name]);
  await chmod(binary, 0o700); return binary.pathname;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!['cosign', 'syft', 'trivy'].includes(process.argv[2])) throw Error('Choose a pinned tool');
  console.log(await tool(process.argv[2]));
}
