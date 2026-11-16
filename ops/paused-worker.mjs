// Test-only worker: pause immediately before a real native allocation INSERT.
import { writeFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { InjectionSymbols } from '@credo-ts/core';
import { createApplication } from './dist/src/app.js';
import { readConfig } from './dist/src/config.js';
const application = await createApplication(readConfig());
const storage = application.runtime.agent.dependencyManager.resolve(InjectionSymbols.StorageService);
const save = storage.save.bind(storage);
let paused = false, attempted = false, nativeWriteSucceeded = false, allocationId;
storage.save = async (context, record) => {
  const gated = !paused && record.id.startsWith('credspan:status-index:');
  if (gated) {
    allocationId = record.id;
    paused = true; await writeFile('/tmp/paused', 'ready', { mode: 0o600 });
    const deadline = Date.now() + 90000;
    for (;;) { try { await access('/tmp/resume'); break; } catch {} if (Date.now() > deadline) throw Error('Test gate timeout'); await delay(100); }
    attempted = true;
  }
  const result = await save(context, record);
  if (gated) nativeWriteSucceeded = true;
  return result;
};
let accepted = false;
try { await application.runtime.createIssuance({ name: 'Synthetic paused worker', memberId: 'paused-worker' }); accepted = true; } catch {}
await writeFile('/tmp/result', JSON.stringify({ attempted, nativeWriteSucceeded, allocationId, accepted }), { mode: 0o600 });
await delay(5000);
await application.close();
