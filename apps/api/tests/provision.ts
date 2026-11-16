import express from 'express';
import { writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireMaintenanceLock } from '../src/control.js';
import { createRuntime } from '../src/runtime.js';
import type { Config } from '../src/config.js';
export async function provision(config: Config) {
  const generation = randomUUID();
  const path = join(config.controlDirectory, 'generation.json');
  await writeFile(path, JSON.stringify({ generation, state: 'fenced' }), { mode: 0o600 });
  const lock = acquireMaintenanceLock(config.controlDirectory, 'provision');
  try { const runtime = await createRuntime(express(), config, { operation: 'provision', operationId: lock.operationId }); await runtime.close(); } finally { lock.release(); }
  await writeFile(path + '.next', JSON.stringify({ generation, state: 'active' }), { mode: 0o600 }); await rename(path + '.next', path);
}
