import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
export function privateValue(path) {
  const info = lstatSync(path);
  if (!isAbsolute(path) || !info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 || info.size > 4096) throw Error('Use a private owned secret file');
  const value = readFileSync(path, 'utf8').trimEnd();
  if (!value || /[\r\n]/.test(value)) throw Error('Invalid private value');
  return value;
}
export function connection(env = process.env, send = fetch) {
  const hosted = env.CREDSPAN_HOSTED_SANDBOX === '1';
  const origin = (value, expected) => {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || (hosted ? value !== expected : !['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname))) throw Error('Use the exact configured sandbox origin');
    return value;
  };
  const api = origin(env.CREDSPAN_API_URL ?? (hosted ? 'https://credspan-sandbox.m1ngshum.com' : 'http://127.0.0.1:3000'), 'https://credspan-sandbox.m1ngshum.com');
  const wallet = origin(env.CREDSPAN_WALLET_URL ?? (hosted ? 'https://credspan-wallet.m1ngshum.com' : 'http://127.0.0.1:7006'), 'https://credspan-wallet.m1ngshum.com');
  const key = env.MANAGEMENT_API_KEY_FILE ? privateValue(env.MANAGEMENT_API_KEY_FILE) : hosted ? undefined : env.MANAGEMENT_API_KEY;
  if (!key) throw Error('Set the private management key file');
  const access = hosted ? { 'CF-Access-Client-Id': privateValue(env.CF_ACCESS_CLIENT_ID_FILE), 'CF-Access-Client-Secret': privateValue(env.CF_ACCESS_CLIENT_SECRET_FILE) } : {};
  const allowed = new Set([api, wallet]);
  const request = async (input, init) => {
    const request = new Request(input, { ...init, redirect: 'error', credentials: 'omit' });
    if (!allowed.has(new URL(request.url).origin)) throw Error('Request origin outside sandbox');
    for (const name of ['CF-Access-Client-Id', 'CF-Access-Client-Secret']) request.headers.delete(name);
    for (const [name, value] of Object.entries(access)) request.headers.set(name, value);
    return send(request);
  };
  return { api, wallet, key, request };
}
