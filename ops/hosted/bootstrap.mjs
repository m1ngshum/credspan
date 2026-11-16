import { mkdirSync, lstatSync, chmodSync, chownSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
assert.equal(process.getuid(), 0, 'Hosted volume bootstrap must start as root');
assert.equal(process.env.CREDSPAN_HOSTED_SANDBOX, '1');
assert.equal(process.env.CONTROL_DIRECTORY, '/data/control');
// Volume root stays operator-owned so the app cannot replace its read-only control directory.
assert.ok(lstatSync('/data').isDirectory()); chownSync('/data', 0, 65532); chmodSync('/data', 0o750);
if (process.argv[2] === 'init') {
  assert.match(process.env.CONTROL_GENERATION ?? '', /^[a-f0-9-]{36}$/);
  const ca = process.env.POSTGRES_CA_PEM;
  assert.ok(ca && ca.length <= 65536); new X509Certificate(ca);
  writeFileSync('/data/supabase-ca.crt', ca, { flag: 'wx', mode: 0o640 }); chownSync('/data/supabase-ca.crt', 0, 65532);
  mkdirSync('/data/control', { mode: 0o750 }); chownSync('/data/control', 0, 65532);
  writeFileSync('/data/control/generation.json', JSON.stringify({ generation: process.env.CONTROL_GENERATION, state: 'fenced' }), { flag: 'wx', mode: 0o640 });
  chownSync('/data/control/generation.json', 0, 65532);
  console.log('Created fenced operator-owned control; no store or keys initialized.');
} else if (process.argv[2] === 'activate') {
  const path = '/data/control/generation.json';
  const control = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(control.state, 'fenced'); assert.equal(control.generation, process.env.CONTROL_GENERATION);
  writeFileSync(path + '.next', JSON.stringify({ generation: control.generation, state: 'active' }), { flag: 'wx', mode: 0o640 });
  chownSync(path + '.next', 0, 65532); renameSync(path + '.next', path);
  console.log('Activated the existing operator-selected generation; startup still checks durable identity.');
} else {
  assert.equal(process.argv.length, 2, 'Unknown hosted bootstrap operation');
  assert.equal(process.arch, 'x64', 'Hosted native TLS is qualified on amd64 only');
  assert.equal(process.env.PGSSLROOTCERT, '/data/supabase-ca.crt');
  const ca = lstatSync('/data/supabase-ca.crt');
  assert.ok(ca.isFile() && ca.uid === 0 && ca.gid === 65532 && !(ca.mode & 0o137));
  const control = lstatSync('/data/control'), file = lstatSync('/data/control/generation.json');
  assert.ok(control.isDirectory() && control.uid === 0 && control.gid === 65532 && !(control.mode & 0o027));
  assert.ok(file.isFile() && file.uid === 0 && file.gid === 65532 && !(file.mode & 0o137));
  assert.equal(JSON.parse(readFileSync('/data/control/generation.json', 'utf8')).state, 'active', 'Operator must provision and activate before serving');
  process.setgroups([]); process.setgid(65532); process.setuid(65532);
  await import('/app/apps/api/dist/src/main.js');
}
