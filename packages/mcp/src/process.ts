import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
export class OperationError extends Error {
  constructor(readonly code: 'unavailable' | 'timeout' | 'cancelled' | 'output_limit' | 'busy' | 'cleanup_required' | 'disabled') { super(code); }
}
export function minimalEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' };
}
export function groupAlive(pid: number | undefined) { if (!pid) return false; try { process.kill(-pid, 0); return true; } catch { return false; } }
export async function retireGroup(child: ChildProcess) {
  const signal = (name: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, name); } catch {} };
  signal('SIGTERM');
  const grace = Date.now() + 1000;
  while (groupAlive(child.pid) && Date.now() < grace) await delay(20);
  if (groupAlive(child.pid)) signal('SIGKILL');
  const until = Date.now() + 2000;
  while (groupAlive(child.pid) && Date.now() < until) await delay(20);
  child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
  if (groupAlive(child.pid)) { child.unref(); throw new OperationError('cleanup_required'); }
}
export async function command(binary: string, args: string[], options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeout?: number; input?: string } = {}): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: options.env ?? minimalEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0, failure: OperationError | undefined, retirement: Promise<void> | undefined, settled = false;
    const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); if (failure || code !== 0) reject(failure ?? new OperationError('unavailable')); else resolve(output.trim()); };
    const stop = (code: OperationError['code']) => {
      failure ??= new OperationError(code);
      retirement ??= retireGroup(child).catch(() => { failure = new OperationError('cleanup_required'); });
      void retirement.then(() => finish(null));
    };
    const abort = () => stop('cancelled'); options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('timeout'), options.timeout ?? 10000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) stop('output_limit'); else output += chunk; });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) stop('output_limit'); });
    child.stdin.on('error', () => {}); child.stdin.end(options.input);
    child.on('error', () => { failure ??= new OperationError('unavailable'); });
    child.on('close', code => { if (retirement) void retirement.then(() => finish(code)); else if (groupAlive(child.pid)) stop('unavailable'); else finish(code); });
  });
}
export type DockerBoundary = { endpoint: string; pluginDirectory?: string };
export async function localDocker(signal?: AbortSignal): Promise<DockerBoundary> {
  const env = { ...minimalEnvironment(), ...(process.env.HOME ? { HOME: process.env.HOME } : {}), ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}) };
  let endpoint = process.env.DOCKER_HOST;
  if (!endpoint) {
    const context = process.env.DOCKER_CONTEXT;
    if (context && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(context)) throw new OperationError('unavailable');
    endpoint = JSON.parse(await command('docker', ['context', 'inspect', ...(context ? [context] : []), '--format', '{{json .Endpoints.docker.Host}}'], { env, signal }));
  }
  if (!endpoint || !/^unix:\/\/\/[A-Za-z0-9_./-]+$/.test(endpoint)) throw new OperationError('unavailable');
  const plugins = JSON.parse(await command('docker', ['--host', endpoint, 'info', '--format', '{{json .ClientInfo.Plugins}}'], { env, signal })) as { Name?: string; Path?: string }[];
  const path = plugins?.find(item => item.Name === 'compose')?.Path;
  if (!path || !path.startsWith('/') || path.includes('\n')) throw new OperationError('unavailable');
  return { endpoint, pluginDirectory: path.slice(0, path.lastIndexOf('/')) };
}
export const docker = (boundary: DockerBoundary, args: string[], options: Parameters<typeof command>[2] = {}) => command('docker', ['--host', boundary.endpoint, ...args], options);
