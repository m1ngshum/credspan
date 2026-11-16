import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { checkEnv, checkWorkflow, checkPngHeader, checkOperatorMetadata } from './check-foundation.mjs';

test('privacy checks reject common operator metadata without recording actual values', () => {
  for (const text of ['operator@' + 'gmail.com', 'https://' + 'a'.repeat(20) + '.supabase.co', 'credspan_owner.' + 'a'.repeat(20), 'zone_id: `' + 'a'.repeat(32) + '`', '--site ' + 'a'.repeat(8) + ('-' + 'a'.repeat(4)).repeat(3) + '-' + 'a'.repeat(12)]) assert.throws(() => checkOperatorMetadata(text));
  checkOperatorMetadata('operator@example.invalid https://<project-ref>.supabase.co --site "$NETLIFY_SITE_ID" keyless@distroless.iam.gserviceaccount.com');
});

test('sample environment permits only comments, empty values, and placeholders', () => {
  checkEnv('# comment\nAPI_KEY=<sandbox-key>\nURL=\n');
  assert.throws(() => checkEnv('API_KEY=real-looking-value'));
  assert.throws(() => checkEnv('export API_KEY=<key>'));
});

test('brand PNG header checks dimensions and alpha channel type', () => {
  const logo = readFileSync(new URL('../docs/assets/brand/logo.png', import.meta.url));
  checkPngHeader(logo, 1254, 1254, 6);
  assert.throws(() => checkPngHeader(logo, 1024, 1024, 6));
  assert.throws(() => checkPngHeader(logo, 1254, 1254, 2));
  assert.throws(() => checkPngHeader(logo.subarray(0, 8), 1254, 1254, 6));
});

test('CI rejects mutable actions, elevated events, and secret references', () => {
  const valid = `permissions:\n  contents: read\nname: ci\nuses: actions/checkout@${'a'.repeat(40)}\n`;
  checkWorkflow(valid);
  assert.throws(() => checkWorkflow(valid.replace('a'.repeat(40), 'v4')));
  assert.throws(() => checkWorkflow(valid + 'pull_request_target:'));
  assert.throws(() => checkWorkflow(valid + '${{ secrets.TOKEN }}'));
});

test('private signing workflow stays manual, isolated and read-only', async () => {
  const { checkPrivateArtifactWorkflow } = await import('./check-foundation.mjs');
  const text = readFileSync(new URL('../.github/workflows/release-artifacts.yml', import.meta.url), 'utf8');
  checkPrivateArtifactWorkflow(text);
  assert.throws(() => checkPrivateArtifactWorkflow(text.replace('github.event.repository.private == true && ', '')));
  assert.throws(() => checkPrivateArtifactWorkflow(text.replace(/(sign:[\s\S]*?)github\.event\.repository\.private == true && /, '$1')));
  assert.throws(() => checkPrivateArtifactWorkflow(text.replace("github.ref == 'refs/heads/main'", 'true')));
  assert.throws(() => checkPrivateArtifactWorkflow(text.replace('workflow_dispatch:', 'pull_request:')));
  assert.throws(() => checkPrivateArtifactWorkflow(text.replace('contents: read', 'contents: write')));
  assert.throws(() => checkPrivateArtifactWorkflow(text.replace('secrets.COSIGN_PASSWORD', 'secrets.UNRELATED_SECRET')));
});
