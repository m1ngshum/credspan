import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const run = promisify(execFile);
const stages = new Set(['source-clone', 'source-revision', 'patch-check', 'patch-apply', 'jvm-test-jar', 'image-build', 'image-inspect']);
const codes = new Set(['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ENOENT', 'EACCES', 'ETIMEDOUT']);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGINT']);
// Default-deny output: preserve fixed classifications, never arbitrary log text,
// command arguments, environment, URLs, paths or error.message.
const classifications = [
  ['tls', /certificate|SSLHandshake|PKIX|TLS handshake/i],
  ['network-timeout', /timed? out|ETIMEDOUT|connection timeout|SocketTimeoutException/i],
  ['network-resolution', /UnknownHostException|could not resolve host|ENOTFOUND|name resolution/i],
  ['connection', /connection refused|connection reset|failed to connect/i],
  ['http-auth', /(?:HTTP|status code|response code)[^\n]{0,30}\b(?:401|403)\b/i],
  ['http-rate-limit', /(?:HTTP|status code|response code)[^\n]{0,30}\b429\b/i],
  ['http-server', /(?:HTTP|status code|response code)[^\n]{0,30}\b5[0-9]{2}\b/i],
  ['dependency-resolution', /could not resolve|could not download|failed to resolve/i],
  ['compiler', /compilation error|unresolved reference|type mismatch|compiler error/i],
  ['tests-failed', /tests? failed|failing tests|test failures/i],
  ['jvm-memory', /OutOfMemoryError|Java heap space|GC overhead limit/i],
  ['disk-space', /no space left on device/i],
  ['gradle-daemon', /daemon disappeared|daemon.*unexpectedly/i],
  ['docker-daemon', /cannot connect to the Docker daemon|error during connect/i],
  ['process-killed-message', /\bkilled\b|terminated by signal/i],
];
function tail(stream, text) {
  const entries = Buffer.from(text).subarray(-32768).toString('utf8').split(/\r?\n/).slice(-128).map(line => ({ stream, kinds: classifications.filter(([, pattern]) => pattern.test(line)).map(([kind]) => kind) })).filter(entry => entry.kinds.length);
  return entries.length ? entries.slice(-16) : [{ stream, kinds: ['unclassified'] }];
}
export async function buildCommand(stage, name, args, { cwd, logDirectory }) {
  if (!stages.has(stage)) throw Error('Invalid peer build stage');
  const started = Date.now();
  try {
    const result = await run(name, args, { cwd, maxBuffer: 10_000_000 });
    await writeFile(join(logDirectory, `${stage}.log`), result.stdout + result.stderr, { mode: 0o600 });
    return result.stdout.trim();
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '', stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    const report = { schemaVersion: 1, stage, observedAt: new Date().toISOString(), elapsedMs: Date.now() - started, exitCode: Number.isInteger(error?.code) ? error.code : null, signal: signals.has(error?.signal) ? error.signal : null, code: codes.has(error?.code) ? error.code : null, observedBytes: { stdout: Buffer.byteLength(stdout), stderr: Buffer.byteLength(stderr) }, classifiedTail: [...tail('stdout', stdout), ...tail('stderr', stderr)] };
    // Emit first: evidence survives even if the ephemeral build directory is lost.
    console.error(JSON.stringify({ peerBuildFailure: report }));
    try {
      await writeFile(join(logDirectory, 'failure-diagnostic.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      await writeFile(join(logDirectory, 'failure.log'), stdout + stderr, { mode: 0o600 });
    } catch { console.error(JSON.stringify({ peerBuildDiagnosticPersistence: 'unavailable' })); }
    throw Error(`Peer build failed at ${stage}; sanitized diagnostic emitted`);
  }
}
