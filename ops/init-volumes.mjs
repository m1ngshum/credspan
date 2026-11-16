import { writeFile, mkdir, chmod, chown, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const uid = Number(process.env.TARGET_UID), gid = Number(process.env.TARGET_GID);
if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0 || process.getuid() !== 0) throw Error('Explicit nonroot target identity required');
let bytes = Buffer.alloc(0);
for await (const chunk of process.stdin) { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 32768) throw Error('Private input exceeds bound'); }
const input = JSON.parse(bytes);
if (!input.control || !/^[a-f0-9-]{36}$/.test(input.control.generation) || !['active', 'fenced'].includes(input.control.state)) throw Error('Invalid control');
async function folder(path) { await mkdir(path, { recursive: true, mode: 0o700 }); await chown(path, uid, gid); await chmod(path, 0o700); }
async function put(value, destination) {
  if (Buffer.byteLength(value) > 4096) throw Error('Private value exceeds bound');
  const next = destination + '.' + randomUUID(); await writeFile(next, value, { flag: 'wx', mode: 0o600 }); await chown(next, uid, gid); await rename(next, destination);
}
await folder('/init/control');
await put(JSON.stringify(input.control), '/init/control/generation.json');
if (input.lock) await put(JSON.stringify(input.lock), '/init/control/maintenance.lock');
else await unlink('/init/control/maintenance.lock').catch(error => { if (error.code !== 'ENOENT') throw error; });
if (process.argv[2] !== 'control-only') {
  for (const [volume, names] of [['runtime', ['management_key', 'store_key', 'runtime_password']], ['maintenance', ['management_key', 'store_key', 'owner_password']]]) {
    await folder(`/init/${volume}`);
    for (const name of names) { if (typeof input.secrets[name] !== 'string' || input.secrets[name].length < 32) throw Error('Invalid private value'); await put(input.secrets[name], `/init/${volume}/${name}`); }
  }
  if (input.secrets.new_store_key) await put(input.secrets.new_store_key, '/init/maintenance/new_store_key');
  else await unlink('/init/maintenance/new_store_key').catch(error => { if (error.code !== 'ENOENT') throw error; });
}
console.log('Private volumes initialized for the intended nonroot UID; no secret values emitted.');
