import express from 'express';
import { StorageUpdateService } from '@credo-ts/core';
import { readConfig, readSecretFile } from './config.js';
import { readControl } from './control.js';
import { createRuntime, type Maintenance } from './runtime.js';
const [operation, ...flags] = process.argv.slice(2);
try {
  if (!['provision', 'retire', 'rekey', 'upgrade', 'check'].includes(operation) || flags.some(flag => !['--apply'].includes(flag))) throw Error('Unknown operation');
  const config = readConfig(); const control = readControl(config.controlDirectory, config.hosted);
  if (operation === 'check') { const runtime = await createRuntime(express(), config); try { console.log(JSON.stringify({ schema: 2, frameworkStorage: await runtime.agent.dependencyManager.resolve(StorageUpdateService).getCurrentStorageVersion(runtime.agent.context), generation: control.generation, ready: true })); } finally { await runtime.close(); } }
  else if (!flags.includes('--apply')) console.log(JSON.stringify({ plan: operation, targetStore: config.storeId, generation: control.generation, requiresFencedState: true, apply: false }));
  else {
    const request: Maintenance = { operation: operation as Maintenance['operation'], previousGeneration: process.env.PREVIOUS_GENERATION, operationId: process.env.MAINTENANCE_OPERATION_ID };
    if (operation === 'rekey') request.newStoreKey = readSecretFile(process.env.NEW_STORE_KEY_FILE!);
    const runtime = await createRuntime(express(), config, request);
    try { console.log(JSON.stringify({ operation, completed: true, schema: 2, generation: control.generation })); } finally { await runtime.close(); }
  }
} catch { console.error('Maintenance failed closed; check control state, schema, role and separately retained secret files.'); process.exitCode = 1; }
