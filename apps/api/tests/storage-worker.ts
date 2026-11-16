import assert from 'node:assert/strict';
import { provision } from './provision.js';
import express from 'express';
import { createRuntime, claimVerification } from '../src/runtime.js';
import { readConfig } from '../src/config.js';

const config = readConfig();
if (process.argv[2] === 'write') await provision(config);
const runtime = await createRuntime(express(), config);
try {
  const id = process.env.TEST_RECORD_ID!;
  if (process.argv[2] === 'write') {
    await runtime.agent.genericRecords.save({ id, content: { synthetic: true, identity: runtime.identity } });
    await claimVerification(runtime.agent.context, id, id);
  } else {
    const record = await runtime.agent.genericRecords.findById(id);
    assert.equal(record?.content.synthetic, true);
    assert.deepEqual(record?.content.identity, runtime.identity);
    await assert.rejects(claimVerification(runtime.agent.context, id, id), /already attempted/);
  }
} finally { await runtime.close(); }
