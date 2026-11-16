import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connection } from '../src/connection.ts';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
test('only the hosted console opts into same-origin Access cookies', () => {
  for (const origin of ['https://credspan-sandbox.m1ngshum.com', 'http://localhost', 'http://127.0.0.1:3000', 'http://credspan-sandbox.m1ngshum.com', 'https://credspan-sandbox.m1ngshum.com:444', 'https://credspan-sandbox.m1ngshum.com.evil.test']) {
    const connection = new Connection('synthetic-memory-key', origin);
    assert.equal(connection.client.getConfig().credentials, origin === 'https://credspan-sandbox.m1ngshum.com' ? 'same-origin' : 'omit');
    assert.equal(connection.client.getConfig().redirect, 'error');
    connection.close();
  }
});
test('disconnect clears client auth and fences late success and unauthorized errors', async () => {
  for (const status of [200, 401]) {
    const connection = new Connection('synthetic-memory-key', 'http://localhost');
    const pending = deferred<{ data?: string; response: Response }>();
    let signal: AbortSignal | undefined;
    const result = connection.run('result', async passed => { signal = passed; return pending.promise; });
    connection.close();
    const replacement = new Connection('replacement-key', 'http://localhost');
    assert.deepEqual(await replacement.run('result', async () => ({ data: 'new session', response: new Response() })), { kind: 'success', data: 'new session' });
    assert.equal(signal!.aborted, true); assert.equal(connection.client.getConfig().auth, undefined);
    pending.resolve({ data: status === 200 ? 'old success' : undefined, response: new Response('', { status }) });
    assert.deepEqual(await result, { kind: 'stale' });
    assert.equal(typeof replacement.client.getConfig().auth, 'function'); replacement.close();
  }
});
test('newer refresh and cancellation prevent stale successful results from returning', async () => {
  const connection = new Connection('synthetic', 'http://localhost');
  const old = deferred<{ data: string; response: Response }>();
  const first = connection.run('result', () => old.promise);
  const second = await connection.run('result', async () => ({ data: 'not accepted', response: new Response() }));
  assert.deepEqual(second, { kind: 'success', data: 'not accepted' });
  old.resolve({ data: 'accepted', response: new Response() }); assert.deepEqual(await first, { kind: 'stale' });
  const after = deferred<{ data: string; response: Response }>(); const pending = connection.run('result', () => after.promise);
  connection.cancel('result'); after.resolve({ data: 'accepted', response: new Response() }); assert.deepEqual(await pending, { kind: 'stale' });
  connection.close();
});
