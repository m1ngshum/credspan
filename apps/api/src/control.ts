import { readFileSync, lstatSync, openSync, writeFileSync, closeSync, unlinkSync, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
export type Control = { generation: string; state: 'active' | 'fenced' };
export function readControl(directory: string, immutable = false): Control {
  const folder = lstatSync(directory);
  const parent = immutable ? lstatSync(dirname(directory)) : undefined;
  const owner = immutable ? 0 : process.getuid?.();
  const invalid = (info: Stats, file = false) => info.uid !== owner || (immutable ? info.gid !== process.getgid?.() || !!(info.mode & (file ? 0o137 : 0o027)) : !!(info.mode & 0o077));
  if (parent && (!parent.isDirectory() || parent.uid !== 0 || parent.mode & 0o022)) throw Error('Control parent must be immutable to the app');
  if (!folder.isDirectory() || invalid(folder)) throw Error('Control directory must be owned and private');
  const path = join(directory, 'generation.json');
  const info = lstatSync(path);
  if (!info.isFile() || invalid(info, true) || info.size > 1024) throw Error('Invalid control file');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Control;
  if (!value || !/^[a-f0-9-]{36}$/.test(value.generation) || !['active', 'fenced'].includes(value.state) || Object.keys(value).length !== 2) throw Error('Invalid control state');
  return value;
}
export function createFence(directory: string, state: Control['state'], immutable = false) {
  const initial = readControl(directory, immutable);
  if (initial.state !== state) throw Error('Deployment is fenced');
  return { generation: initial.generation, assert() {
    // Read every time. A mounted directory observes atomic replacement; a single-file bind mount may not.
    const current = readControl(directory, immutable);
    if (current.state !== state || current.generation !== initial.generation) throw Error('Worker generation is retired or fenced');
  } };
}

export function assertMaintenanceLock(directory: string, operationId: string | undefined, operation: string, immutable = false) {
  const path = join(directory, 'maintenance.lock'), info = lstatSync(path);
  if (!info.isFile() || (immutable ? info.uid !== 0 || info.gid !== process.getgid?.() || !!(info.mode & 0o137) : info.uid !== process.getuid?.() || !!(info.mode & 0o077)) || info.size > 1024) throw Error('Invalid maintenance lock');
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  if (!operationId || lock.operationId !== operationId || lock.operation !== operation) throw Error('Maintenance must hold the exclusive operator lock');
}
export function acquireMaintenanceLock(directory: string, operation: string) {
  readControl(directory);
  const operationId = randomUUID(), path = join(directory, 'maintenance.lock');
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({ operationId, operation })); } finally { closeSync(fd); }
  return { operationId, release() { assertMaintenanceLock(directory, operationId, operation); unlinkSync(path); } };
}
