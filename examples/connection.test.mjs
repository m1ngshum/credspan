import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connection } from './connection.mjs';
test('hosted helper confines private Access headers to exact HTTPS origins and rejects redirects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credspan-helper-'));
  try {
    const env = { CREDSPAN_HOSTED_SANDBOX: '1' };
    for (const name of ['MANAGEMENT_API_KEY', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']) { const path = join(directory, name); await writeFile(path, 'synthetic-' + name, { mode: 0o600 }); env[name + '_FILE'] = path; }
    const sent = [];
    const client = connection(env, async request => { sent.push(request); return new Response('{}'); });
    await client.request(client.api + '/api/info'); await client.request(client.wallet + '/wallet', { method: 'POST' });
    assert.equal(sent.length, 2);
    for (const request of sent) { assert.equal(request.headers.get('CF-Access-Client-Secret'), 'synthetic-CF_ACCESS_CLIENT_SECRET'); assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit'); }
    for (const url of ['http://credspan-sandbox.m1ngshum.com/x', 'https://credspan-sandbox.m1ngshum.com.evil.test/x', 'https://evil.test/x']) await assert.rejects(client.request(url));
    assert.equal(sent.length, 2);
    assert.throws(() => connection({ ...env, CREDSPAN_API_URL: client.api + '/' }));
    await writeFile(env.CF_ACCESS_CLIENT_SECRET_FILE, 'bad\nvalue'); assert.throws(() => connection(env));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
