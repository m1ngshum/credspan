import assert from 'node:assert/strict';
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function readSecretFile(path: string) {
  const info = lstatSync(path);
  assert.ok(isAbsolute(path) && info.isFile() && info.uid === process.getuid?.() && info.size <= 4096 && !(info.mode & 0o077), 'Invalid private secret file');
  const value = readFileSync(path, 'utf8').trimEnd();
  assert.ok(value && !value.startsWith('<'), 'Set private secret');
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  assert.equal(env.CREDSPAN_SANDBOX, '1', 'This release requires explicit sandbox mode');
  const required = (name: string) => {
    assert.ok(!(env[name] && env[`${name}_FILE`]), `Choose value or file for ${name}`);
    let value = env[name];
    if (env[`${name}_FILE`]) {
      value = readSecretFile(env[`${name}_FILE`]!);
    }
    assert.ok(value && !value.startsWith('<'), `Set ${name}`);
    return value;
  };
  const hosted = env.CREDSPAN_HOSTED_SANDBOX === '1';
  assert.ok(env.CREDSPAN_HOSTED_SANDBOX === undefined || hosted, 'Invalid hosted profile');
  const publicUrl = new URL(required('PUBLIC_URL'));
  assert.ok(['http:', 'https:'].includes(publicUrl.protocol));
  assert.ok(hosted ? publicUrl.origin === 'https://credspan-sandbox.m1ngshum.com' : ['localhost', '127.0.0.1', 'host.docker.internal'].includes(publicUrl.hostname), 'Only the configured sandbox origin is supported');
  if (hosted) {
    assert.equal(env.PGSSLMODE, 'verify-full', 'Hosted native PostgreSQL must verify TLS');
    const ca = required('PGSSLROOTCERT');
    assert.ok(isAbsolute(ca) && lstatSync(ca).isFile() && lstatSync(ca).size <= 65536, 'Set the native PostgreSQL CA certificate file');
    assert.ok(!env.CONSOLE_DEV_ORIGIN, 'Hosted console is same-origin only');
    assert.match(required('POSTGRES_HOST'), /^[a-z0-9][a-z0-9.-]+:5432$/);
  }
  assert.equal(publicUrl.pathname, '/');
  assert.ok(!publicUrl.username && !publicUrl.password && !publicUrl.search && !publicUrl.hash);
  const port = Number(env.PORT ?? 3000);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  const host = env.HOST ?? (hosted ? '::' : '127.0.0.1');
  assert.ok((hosted ? ['::', '0.0.0.0'] : ['127.0.0.1', '0.0.0.0']).includes(host));
  const apiKey = required('MANAGEMENT_API_KEY');
  assert.ok(apiKey.length >= 32, 'Management key must have at least 32 characters');
  const storeId = required('ASKAR_STORE_ID');
  assert.match(storeId, /^[a-z][a-z0-9_]{0,40}$/);
  const storeKey = required('ASKAR_STORE_KEY');
  assert.ok(storeKey.length >= 32, 'Store key must have at least 32 characters');
  const trustedIssuers = env.TRUSTED_ISSUER_DIDS === undefined ? undefined : JSON.parse(env.TRUSTED_ISSUER_DIDS) as unknown;
  assert.ok(trustedIssuers === undefined || (Array.isArray(trustedIssuers) && trustedIssuers.length <= 16 && trustedIssuers.every(did => typeof did === 'string' && /^did:key:z[1-9A-HJ-NP-Za-km-z]{20,100}$/.test(did))), 'Trusted issuers must be a bounded JSON array of local did:key identifiers');
  const consoleDevOrigin = env.CONSOLE_DEV_ORIGIN;
  if (consoleDevOrigin) { const origin = new URL(consoleDevOrigin); assert.ok(origin.origin === consoleDevOrigin && ['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.protocol === 'http:' && !origin.username && !origin.password); }
  const controlDirectory = required('CONTROL_DIRECTORY');
  assert.ok(isAbsolute(controlDirectory));
  return { hosted, consoleDevOrigin, controlDirectory, trustedIssuers: trustedIssuers as string[] | undefined, publicUrl: publicUrl.origin, port, host, apiKey, storeId, storeKey,
    postgresHost: required('POSTGRES_HOST'), postgresUser: required('POSTGRES_USER'), postgresPassword: required('POSTGRES_PASSWORD') };
}
export type Config = ReturnType<typeof readConfig>;
