import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, unlink, mkdtemp, rm, chmod } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const MAGIC = Buffer.from('CRDSPN01');
const keyCheck = key => { if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('Backup key must be 32 random bytes'); };
export async function encryptBackup(input, key, destination) {
  keyCheck(key);
  const file = await open(destination, 'wx', 0o600);
  try {
    const nonce = randomBytes(12), header = Buffer.concat([MAGIC, nonce]);
    if ((await file.write(header)).bytesWritten !== header.length) throw Error('Incomplete backup header');
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(MAGIC);
    await pipeline(input, cipher, createWriteStream(destination, { fd: file.fd, autoClose: false, start: header.length }));
    const size = (await file.stat()).size;
    if ((await file.write(cipher.getAuthTag(), 0, 16, size)).bytesWritten !== 16) throw Error('Incomplete backup authentication tag'); await file.sync();
  } catch (error) { await unlink(destination).catch(() => {}); throw error; }
  finally { await file.close(); }
}
export async function withVerifiedBackup(source, key, restore) {
  keyCheck(key);
  const encrypted = await open(source, 'r');
  const info = await encrypted.stat();
  if (!info.isFile() || info.size < 36 || info.size > 10 * 1024 ** 3) { await encrypted.close(); throw Error('Invalid backup size'); }
  const directory = await mkdtemp(join(tmpdir(), 'credspan-verified-backup-')); await chmod(directory, 0o700);
  const path = join(directory, 'archive.dump');
  let plaintext;
  try {
    const header = Buffer.alloc(20), tag = Buffer.alloc(16);
    await encrypted.read(header, 0, 20, 0); await encrypted.read(tag, 0, 16, info.size - 16);
    if (!header.subarray(0, 8).equals(MAGIC)) throw Error('Unsupported backup format');
    plaintext = await open(path, 'wx', 0o600);
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(8)); decipher.setAAD(MAGIC); decipher.setAuthTag(tag);
    await pipeline(createReadStream(source, { fd: encrypted.fd, autoClose: false, start: 20, end: info.size - 17 }), decipher, createWriteStream(path, { fd: plaintext.fd, autoClose: false }));
    await plaintext.sync();
    // Only after decipher.final has authenticated the complete archive may a database mutation begin.
    return await restore(path);
  } finally { await Promise.allSettled([plaintext?.close(), encrypted.close()]); await rm(directory, { recursive: true, force: true }); }
}

export async function encryptProcessBackup(child, key, destination) {
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error('Database export failed')));
  });
  let created = false;
  const encrypted = encryptBackup(child.stdout, key, destination).then(() => { created = true; });
  try { await Promise.all([encrypted, completed]); }
  catch {
    child.kill('SIGTERM'); child.stdout.destroy();
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000); timer.unref();
    try { await Promise.allSettled([encrypted, completed]); } finally { clearTimeout(timer); }
    if (created) await unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
    throw Error('Database export failed; incomplete backup removed');
  }
}
