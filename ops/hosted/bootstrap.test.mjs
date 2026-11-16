import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
test('hosted bootstrap refuses reinitialization and app UID cannot replace controls or CA', { timeout: 60000 }, () => {
  const image = process.env.TLS_API_IMAGE; assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const volume = 'credspan-probe-bootstrap-' + randomUUID(), directory = mkdtempSync(join(tmpdir(), 'credspan-bootstrap-'));
  const generation = randomUUID(), script = new URL('./bootstrap.mjs', import.meta.url).pathname;
  const run = (code, uid = '0:0', selectedGeneration = generation) => docker(['run', '--rm', '--platform', 'linux/amd64', '--user', uid, '-e', 'CREDSPAN_HOSTED_SANDBOX=1', '-e', 'CONTROL_DIRECTORY=/data/control', '-e', 'CONTROL_GENERATION=' + selectedGeneration, '--mount', `type=volume,source=${volume},target=/data`, '--mount', `type=bind,source=${script},target=/bootstrap.mjs,readonly`, '--mount', `type=bind,source=${join(directory, 'ca.crt')},target=/ca.crt,readonly`, image, 'node', '--input-type=module', '-e', code]);
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-keyout', join(directory, 'key'), '-out', join(directory, 'ca.crt'), '-subj', '/CN=synthetic'], { stdio: 'ignore' });
    docker(['volume', 'create', volume]);
    const init = "import{readFileSync}from'node:fs';process.env.POSTGRES_CA_PEM=readFileSync('/ca.crt','utf8');process.argv=['node','bootstrap','init'];await import('/bootstrap.mjs');";
    assert.match(run(init), /Created fenced/); assert.throws(() => run(init));
    const activate = "process.argv=['node','bootstrap','activate'];await import('/bootstrap.mjs');";
    assert.throws(() => run(activate, '0:0', randomUUID())); assert.match(run(activate), /Activated/);
    assert.throws(() => run(activate));
    assert.match(run("import assert from'node:assert/strict';import{writeFileSync,renameSync,readFileSync}from'node:fs';for(const path of ['/data/control/generation.json','/data/supabase-ca.crt'])assert.throws(()=>writeFileSync(path,'forged'));assert.throws(()=>renameSync('/data/control','/data/stolen'));assert.equal(JSON.parse(readFileSync('/data/control/generation.json','utf8')).state,'active');console.log('immutable PASS');", '65532:65532'), /immutable PASS/);
  } finally { docker(['volume', 'rm', volume]); rmSync(directory, { recursive: true, force: true }); }
});
