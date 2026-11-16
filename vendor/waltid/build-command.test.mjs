import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommand } from './build-command.mjs';

test('actual failed command preserves stage/status and bounded classifications without arbitrary output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-peer-diagnostic-')), messages = [], original = console.error;
  const sentinel = 'synthetic-credential-sentinel'; console.error = message => messages.push(String(message));
  try {
    const output = `${sentinel} https://user:${sentinel}@example.invalid/path?token=${sentinel} \\u001b[31m ${Buffer.from(sentinel).toString('base64')}\n`;
    await assert.rejects(buildCommand('jvm-test-jar', process.execPath, ['-e', `process.stdout.write(${JSON.stringify(output)}.repeat(4000),()=>process.stderr.write('SocketTimeoutException HTTP response code 503 '+${JSON.stringify(sentinel)},()=>process.exit(23)))`], { cwd: directory, logDirectory: directory }), /Peer build failed at jvm-test-jar; sanitized diagnostic emitted/);
    const text = messages.join('\n'), report = JSON.parse(messages[0]).peerBuildFailure;
    assert.ok(text.length < 8192); assert.ok(!text.includes(sentinel)); assert.ok(!text.includes(Buffer.from(sentinel).toString('base64'))); assert.ok(!text.includes('example.invalid')); assert.ok(!text.includes(directory));
    assert.equal(report.stage, 'jvm-test-jar'); assert.equal(report.exitCode, 23); assert.equal(report.signal, null); assert.ok(report.elapsedMs >= 0); assert.ok(Number.isFinite(Date.parse(report.observedAt))); assert.ok(report.observedBytes.stdout > 100000);
    assert.ok(report.classifiedTail.some(entry => entry.kinds.includes('network-timeout'))); assert.ok(report.classifiedTail.some(entry => entry.kinds.includes('http-server')));
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'failure-diagnostic.json'), 'utf8')), report);
    assert.equal((await stat(join(directory, 'failure.log'))).mode & 0o777, 0o600);
  } finally { console.error = original; await rm(directory, { recursive: true, force: true }); }
});

test('signal and spawn failures emit only fixed diagnostic fields even when persistence fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-peer-diagnostic-')), messages = [], original = console.error;
  console.error = message => messages.push(String(message));
  try {
    await assert.rejects(buildCommand('source-clone', process.execPath, ['-e', "process.kill(process.pid,'SIGTERM')"], { cwd: directory, logDirectory: directory }), /sanitized diagnostic emitted/);
    assert.equal(JSON.parse(messages[0]).peerBuildFailure.signal, 'SIGTERM'); messages.length = 0;
    await assert.rejects(buildCommand('source-clone', join(directory, 'synthetic-secret-command'), [], { cwd: directory, logDirectory: join(directory, 'synthetic-secret-path', 'missing') }), /sanitized diagnostic emitted/);
    assert.equal(JSON.parse(messages[0]).peerBuildFailure.code, 'ENOENT'); assert.ok(!messages.join('\n').includes('synthetic-secret')); assert.deepEqual(JSON.parse(messages[1]), { peerBuildDiagnosticPersistence: 'unavailable' });
  } finally { console.error = original; await rm(directory, { recursive: true, force: true }); }
});

test('successful command output remains local and invalid stage executes nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-peer-diagnostic-'));
  try {
    assert.equal(await buildCommand('source-revision', process.execPath, ['-e', "process.stdout.write('public-source-sha\\n')"], { cwd: directory, logDirectory: directory }), 'public-source-sha');
    assert.equal((await stat(join(directory, 'source-revision.log'))).mode & 0o777, 0o600);
    await assert.rejects(buildCommand('not-a-stage', process.execPath, ['-e', 'process.exit(0)'], { cwd: directory, logDirectory: directory }), /Invalid peer build stage/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
