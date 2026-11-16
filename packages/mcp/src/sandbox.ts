import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, writeFile, readFile, unlink, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, type CleanupFailure, type OwnedRun } from './cleanup.js';
import { localDocker, minimalEnvironment, OperationError, retireGroup, groupAlive, type DockerBoundary } from './process.js';
import { cachedImages } from './profile.js';
export type Scenario = 'membership-roundtrip' | 'revocation';
export const stages = ['preflight', 'initializing', 'initialized', 'provisioned', 'running', 'held', 'verified', 'revoked', 'complete'] as const;
export type Stage = typeof stages[number];
export type RunResult = { scenario: Scenario; passed: boolean; checks: string[]; cleanupComplete: boolean; code: string; stage: Stage; cleanupFailure?: CleanupFailure; apiImage?: string; apiSource?: string };
export class Sandbox {
  private active = false;
  private blocked = false;
  private lastCleanupFailure?: CleanupFailure;
  private stop = new AbortController();
  private running?: Promise<RunResult>;
  private readers = new Set<Promise<unknown>>();
  constructor(readonly enabled: boolean, readonly deadline = 120000) {}
  get busy() { return this.active; }
  get cleanupRequired() { return this.blocked; }
  private get budgetDirectory() { return join(tmpdir(), `credspan-mcp-${process.getuid?.() ?? 'unsupported'}`); }
  diagnostics(caller?: AbortSignal) {
    const pending = this.readDiagnostics(caller); this.readers.add(pending);
    void pending.then(() => this.readers.delete(pending), () => this.readers.delete(pending)); return pending;
  }
  private async readDiagnostics(caller?: AbortSignal) {
    let dockerReady = false, imagesReady = false;
    try { const signal = AbortSignal.any([AbortSignal.timeout(5000), this.stop.signal, ...(caller ? [caller] : [])]); const boundary = await localDocker(signal); dockerReady = true; await cachedImages(boundary, signal); imagesReady = true; } catch (error) { if (error instanceof OperationError && error.code === 'cleanup_required') this.blocked = true; }
    let leasePresent = false; try { await lstat(join(this.budgetDirectory, 'lease.json')); leasePresent = true; } catch {}
    return { scope: 'local-synthetic' as const, nodeReady: process.version === 'v26.13.1', platformReady: ['darwin', 'linux'].includes(process.platform) && ['arm64', 'x64'].includes(process.arch) && !!process.getuid?.(), dockerReady, imagesReady, sandboxEnabled: this.enabled, busy: this.active || leasePresent, cleanupRequired: this.blocked, ...(this.lastCleanupFailure ? { cleanupFailure: this.lastCleanupFailure } : {}) };
  }
  run(scenario: Scenario, signal: AbortSignal, onStage?: (stage: Stage) => void): Promise<RunResult> {
    if (!this.enabled) return Promise.reject(new OperationError('disabled'));
    if (this.blocked) return Promise.reject(new OperationError('cleanup_required'));
    if (this.active) return Promise.reject(new OperationError('busy'));
    this.active = true;
    this.running = this.execute(scenario, signal, onStage).finally(() => { this.active = false; });
    return this.running;
  }
  async shutdown() { this.stop.abort(); const result = await this.running; await Promise.allSettled([...this.readers]); if (result?.cleanupComplete === false || this.blocked) throw new OperationError('cleanup_required'); }
  private async execute(scenario: Scenario, caller: AbortSignal, onStage?: (stage: Stage) => void): Promise<RunResult> {
    let stage: Stage = 'preflight', run: OwnedRun | undefined, boundary: DockerBoundary | undefined, env: NodeJS.ProcessEnv | undefined, leased = false;
    let childRetired = true, passed = false, checks: string[] = [], code = 'failed', images: Awaited<ReturnType<typeof cachedImages>> | undefined;
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.deadline);
    const signal = AbortSignal.any([caller, this.stop.signal, deadline.signal]);
    const setStage = (value: Stage) => { stage = value; onStage?.(value); };
    const leasePath = join(this.budgetDirectory, 'lease.json');
    try {
      if (process.version !== 'v26.13.1' || !['darwin', 'linux'].includes(process.platform) || !process.getuid?.()) throw new OperationError('unavailable');
      boundary = await localDocker(signal); images = await cachedImages(boundary, signal); signal.throwIfAborted();
      await mkdir(this.budgetDirectory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const folder = await lstat(this.budgetDirectory);
      if (!folder.isDirectory() || folder.uid !== process.getuid() || folder.mode & 0o077) throw new OperationError('unavailable');
      const id = randomUUID();
      // The lease is global to this user's fixed temporary namespace; never steal stale leases.
      await writeFile(leasePath, JSON.stringify({ id, pid: process.pid }), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code === 'EEXIST') throw new OperationError('busy'); throw error; }); leased = true;
      const directory = await mkdtemp(join(this.budgetDirectory, 'run-'));
      run = { id, name: `credspan-mcp-${id.replaceAll('-', '').slice(0, 24)}`, directory };
      await writeFile(join(directory, 'owned.json'), JSON.stringify(run), { mode: 0o600, flag: 'wx' });
      await writeFile(leasePath, JSON.stringify({ ...run, pid: process.pid }), { mode: 0o600 });
      for (const name of ['docker-config', 'tmp']) await mkdir(join(directory, name), { mode: 0o700 });
      await writeFile(join(directory, 'docker-config', 'config.json'), JSON.stringify({ cliPluginsExtraDirs: [boundary.pluginDirectory] }), { mode: 0o600 });
      env = { ...minimalEnvironment(), DOCKER_HOST: boundary.endpoint, DOCKER_CONFIG: join(directory, 'docker-config'), TMPDIR: join(directory, 'tmp') };
      setStage('initializing');
      const result = await this.child(run, scenario, images, env, signal, setStage);
      checks = result.checks; passed = true; code = 'passed';
    } catch (error) { if (error instanceof OperationError && error.code === 'cleanup_required') childRetired = false; code = !childRetired ? 'cleanup_required' : signal.aborted ? (deadline.signal.aborted ? 'timeout' : 'cancelled') : error instanceof OperationError ? error.code : 'failed'; }
    finally { clearTimeout(timer); }
    let cleanupComplete = childRetired, cleanupFailure: CleanupFailure | undefined = childRetired ? undefined : { stage: 'process-retirement', code: 'cleanup_required' };
    if (childRetired && run && boundary && env) { const outcome = await cleanup(boundary, run, env); cleanupComplete = outcome.complete; if (!outcome.complete) cleanupFailure = { stage: outcome.stage, code: outcome.code }; }
    if (leased && cleanupComplete) {
      try {
        const lease = JSON.parse(await readFile(leasePath, 'utf8'));
        if (lease.id !== run?.id) { cleanupComplete = false; cleanupFailure = { stage: 'lease', code: 'ownership' }; }
        else { if (run) await rm(run.directory, { recursive: true, force: true }); await unlink(leasePath); }
      } catch { cleanupComplete = false; cleanupFailure = { stage: 'lease', code: 'filesystem' }; }
    }
    this.lastCleanupFailure = cleanupFailure;
    if (!cleanupComplete) { this.blocked = true; code = 'cleanup_required'; passed = false; }
    return { scenario, passed, checks: passed ? checks : [], cleanupComplete, code, stage, ...(cleanupFailure ? { cleanupFailure } : {}), ...(images ? { apiImage: images.api, apiSource: images.apiSource } : {}) };
  }
  private child(run: OwnedRun, scenario: Scenario, images: { api: string; apiSource: string }, env: NodeJS.ProcessEnv, signal: AbortSignal, stage: (stage: Stage) => void): Promise<{ checks: string[] }> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./runner.js', import.meta.url)), run.directory, run.name, run.id, scenario, images.api], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let bytes = 0, result: { checks: string[] } | undefined, failed = false, retirement: Promise<void> | undefined, settled = false;
      const finish = (code: number | null, retirementFailed = false) => { if (settled) return; settled = true; signal.removeEventListener('abort', kill); if (retirementFailed) reject(new OperationError('cleanup_required')); else if (code === 0 && result && !failed && !signal.aborted) resolve(result); else reject(new OperationError(signal.aborted ? 'cancelled' : 'unavailable')); };
      const kill = () => { retirement ??= retireGroup(child); void retirement.then(() => finish(null), () => finish(null, true)); };
      signal.addEventListener('abort', kill, { once: true });
      for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { bytes += chunk.length; if (bytes > 16384) { failed = true; kill(); } });
      child.on('message', message => {
        const value = message as { type?: string; stage?: Stage; checks?: string[] };
        if (value.type === 'stage' && stages.includes(value.stage!)) stage(value.stage!);
        if (value.type === 'result' && Array.isArray(value.checks)) {
          const expected = ['issued', 'held', 'presented', 'accepted', ...(scenario === 'revocation' ? ['revoked', 'not-accepted-after-revocation'] : [])];
          if (JSON.stringify(value.checks) === JSON.stringify(expected)) result = { checks: expected }; else failed = true;
        }
      });
      child.on('error', () => { failed = true; });
      child.on('close', code => { if (retirement) void retirement.then(() => finish(code), () => finish(null, true)); else if (groupAlive(child.pid)) { failed = true; kill(); } else finish(code); });
    });
  }
}
