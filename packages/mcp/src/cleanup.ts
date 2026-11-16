import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { docker, OperationError, type DockerBoundary } from './process.js';
export type OwnedRun = { id: string; name: string; directory: string };
export const cleanupStages = ['control', 'container-list', 'container-inspect', 'container-remove', 'container-absence', 'network-list', 'network-inspect', 'network-remove', 'volume-list', 'volume-inspect', 'volume-remove', 'quiet', 'process-retirement', 'lease'] as const;
export type CleanupStage = typeof cleanupStages[number];
export const cleanupCodes = ['ownership', 'invalid-response', 'unavailable', 'timeout', 'cancelled', 'output_limit', 'cleanup_required', 'not-quiet', 'filesystem'] as const;
export type CleanupFailure = { stage: CleanupStage; code: typeof cleanupCodes[number] };
export type CleanupResult = { complete: true } | ({ complete: false } & CleanupFailure);
const services = new Set(['api', 'edge', 'wallet', 'postgres', 'maintenance', 'init']);
export async function cleanup(boundary: DockerBoundary, run: OwnedRun, env: NodeJS.ProcessEnv): Promise<CleanupResult> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  const call = (args: string[]) => docker(boundary, args, { env, signal: controller.signal, timeout: 5000 });
  let stage: CleanupStage = 'control';
  const fail = (code: CleanupFailure['code']): CleanupResult => ({ complete: false, stage, code });
  const absent = async (id: string) => {
    stage = 'container-absence';
    // A successful daemon query of the immutable full ID must prove absence.
    // Stderr text, failed queries and generic command errors never establish it.
    const ids = (await call(['ps', '-aq', '--no-trunc', '--filter', 'id=' + id])).split('\n').filter(Boolean);
    if (ids.some(value => value !== id)) throw new Error('invalid-response');
    return !ids.includes(id);
  };
  try {
    const expectedVolumes = new Map([[`${run.name}_postgres`, ['credspan.deployment', run.id]], [`${run.name}_wallet`, ['credspan.deployment', run.id]]]);
    const controlDirectory = join(run.directory, 'project', 'control');
    const hash = createHash('sha256').update(controlDirectory).digest('hex');
    expectedVolumes.set('credspan_control_' + hash.slice(0, 16), ['credspan.control', hash]);
    try {
      const path = join(controlDirectory, 'generation.json'), info = await lstat(path);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 1024) return fail('ownership');
      const generation = JSON.parse(await readFile(path, 'utf8')).generation;
      if (!/^[a-f0-9-]{36}$/.test(generation)) return fail('ownership');
      for (const kind of ['runtime', 'maintenance']) expectedVolumes.set(`${run.name}_${kind}_${generation.replaceAll('-', '')}`, ['credspan.deployment', run.id]);
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code!)) return fail('ownership'); }
    // Immutable UUID ownership, exact names/services and ids; never prefix deletion or prune.
    let quiet = 0;
    for (let pass = 0; pass < 40 && quiet < 5; pass++) {
      let removed = false;
      stage = 'container-list';
      const containers = (await call(['ps', '-aq', '--no-trunc', '--filter', 'label=credspan.deployment=' + run.id])).split('\n').filter(Boolean);
      for (const id of containers) {
        if (!/^[a-f0-9]{64}$/.test(id)) return fail('ownership');
        stage = 'container-inspect';
        let raw: string;
        try { raw = await call(['inspect', id, '--format', '{{json .Config.Labels}}']); }
        catch (error) { if (!(error instanceof OperationError) || error.code !== 'unavailable') throw error; if (await absent(id)) continue; throw error; }
        const labels = JSON.parse(raw);
        if (labels['credspan.deployment'] !== run.id || labels['com.docker.compose.project'] !== run.name || !services.has(labels['com.docker.compose.service'])) return fail('ownership');
        stage = 'container-remove';
        try { await call(['rm', '-f', id]); }
        catch (error) { if (!(error instanceof OperationError) || error.code !== 'unavailable') throw error; if (!await absent(id)) throw error; }
        removed = true;
      }
      stage = 'network-list';
      const networks = (await call(['network', 'ls', '--filter', 'label=credspan.deployment=' + run.id, '--format', '{{.ID}}'])).split('\n').filter(Boolean);
      for (const id of networks) {
        stage = 'network-inspect';
        const item = JSON.parse(await call(['network', 'inspect', id, '--format', '{{json .}}']));
        if (item.Name !== `${run.name}_default` || item.Labels?.['credspan.deployment'] !== run.id || item.Labels?.['com.docker.compose.project'] !== run.name) return fail('ownership');
        stage = 'network-remove';
        await call(['network', 'rm', item.Id]); removed = true;
      }
      stage = 'volume-list';
      const known = (await call(['volume', 'ls', '--format', '{{.Name}}'])).split('\n');
      const owned = (await call(['volume', 'ls', '--filter', 'label=credspan.deployment=' + run.id, '--format', '{{.Name}}'])).split('\n').filter(Boolean);
      if (owned.some(name => !expectedVolumes.has(name))) return fail('ownership');
      for (const [name, [label, value]] of expectedVolumes) {
        if (!known.includes(name)) continue;
        stage = 'volume-inspect';
        const labels = JSON.parse(await call(['volume', 'inspect', name, '--format', '{{json .Labels}}']));
        if (labels?.[label] !== value) return fail('ownership');
        stage = 'volume-remove';
        await call(['volume', 'rm', name]); removed = true;
      }
      quiet = removed ? 0 : quiet + 1; await delay(100);
    }
    stage = 'quiet';
    return quiet >= 5 ? { complete: true } : fail('not-quiet');
  } catch (error) { return fail(error instanceof OperationError && cleanupCodes.includes(error.code as CleanupFailure['code']) ? error.code as CleanupFailure['code'] : 'invalid-response'); }
  finally { clearTimeout(timer); }
}
