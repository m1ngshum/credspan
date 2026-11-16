import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const lock = JSON.parse(await readFile(new URL('./native-lock.json', import.meta.url)));
for (const platform of ['linux-arm64', 'linux-amd64']) {
  const entry = lock[platform], directory = new URL(`./.cache/native/${platform}/`, import.meta.url);
  await mkdir(directory, { recursive: true });
  const archive = new URL('archive.tar.gz', directory);
  let bytes;
  try { bytes = await readFile(archive); } catch {}
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    const response = await fetch(`https://github.com/openwallet-foundation/askar/releases/download/${lock.version}/${entry.asset}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw Error('Native artifact download failed'); bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw Error('Native artifact checksum mismatch');
    await writeFile(archive, bytes);
  }
  execFileSync('tar', ['-xzf', archive.pathname, '--strip-components=1', '-C', directory.pathname]);
  await writeFile(new URL('version.json', directory), JSON.stringify({ version: lock.version }));
  console.log(`${platform}: verified official native ${lock.version} artifact`);
}
