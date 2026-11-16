import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { docker, OperationError, type DockerBoundary } from './process.js';
export const root = fileURLToPath(new URL('../../../../', import.meta.url));
export async function cachedImages(boundary: DockerBoundary, signal?: AbortSignal) {
  const images = JSON.parse(await readFile(new URL('../../../../ops/images.json', import.meta.url), 'utf8'));
  const profile = JSON.parse(await readFile(new URL('../../runtime.json', import.meta.url), 'utf8'));
  const inspect = async (ref: string) => JSON.parse(await docker(boundary, ['image', 'inspect', ref, '--format', '{{json .}}'], { signal }));
  const api = await inspect('credspan-api:local');
  if (api.Architecture !== (process.arch === 'x64' ? 'amd64' : process.arch) || api.Config.Labels?.['org.opencontainers.image.source'] !== profile.repository || api.Config.Labels?.['org.opencontainers.image.revision'] !== profile.apiSource || !/^sha256:[a-f0-9]{64}$/.test(api.Id)) throw new OperationError('unavailable');
  const peer = await inspect(images.wallet);
  if (peer.Config.Labels?.['credspan.probe.patch.sha256'] !== profile.peerPatch || peer.Config.Labels?.['credspan.dependencies.patch.sha256'] !== profile.peerDependencyPatch) throw new OperationError('unavailable');
  await inspect(images.postgres); await inspect(images.caddy);
  return { api: api.Id as string, apiSource: profile.apiSource as string, peer: peer.Id as string };
}
