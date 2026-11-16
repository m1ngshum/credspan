import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkEnv(text) {
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    assert.match(line, /^[A-Z][A-Z0-9_]*=(?:|<[^>]+>)$/, 'Sample environment values must be empty or explicit <placeholders>');
  }
}

export function checkOperatorMetadata(text) {
  assert.doesNotMatch(text, /\b[A-Z0-9._%+-]+@(?:gmail|googlemail|outlook|hotmail|icloud|yahoo)\.com\b/i, 'Use a placeholder instead of an operator email');
  assert.doesNotMatch(text, /\b[a-z0-9]{20}\.supabase\.co\b|\bcredspan_owner\.[a-z0-9]{20}\b/i, 'Keep actual Supabase project references private');
  assert.doesNotMatch(text, /(?:--site\s+|(?:project|site|team|zone|rule|entrypoint|deployment)[ _-]?id\s*[:=]\s*`?)(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/i, 'Keep actual provider identifiers private');
}

export function checkWorkflow(text) {
  assert.match(text, /permissions:\n  contents: read\n/);
  assert.match(text, /name: ci\n/);
  assert.doesNotMatch(text, /pull_request_target|secrets\.|write-all|contents: write/);
  for (const match of text.matchAll(/uses:\s*(\S+)/g)) {
    assert.match(match[1], /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/);
  }
}

export function checkPrivateArtifactWorkflow(text) {
  assert.match(text, /on:\n  workflow_dispatch:/);
  assert.match(text, /permissions:\n  contents: read\n/);
  assert.match(text, /environment: private-release/);
  for (const job of ['artifacts', 'sign']) {
    const block = text.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z]+:\n/)[0] ?? '';
    assert.match(block, /(?:^|\n)    if: github\.event\.repository\.private == true && github\.ref == 'refs\/heads\/main'\n/, `${job} must stay private and main-only`);
  }
  assert.doesNotMatch(text, /pull_request|packages: write|contents: write|id-token: write|docker push|gh release/);
  for (const match of text.matchAll(/uses:\s*(\S+)/g)) assert.match(match[1], /^actions\/[\w.-]+@[a-f0-9]{40}$/);
  for (const match of text.matchAll(/secrets\.([A-Z_]+)/g)) assert.ok(['COSIGN_PRIVATE_KEY', 'COSIGN_PASSWORD'].includes(match[1]));
}

export function checkPngHeader(data, width, height, colorType) {
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Invalid PNG signature');
  assert.equal(data.readUInt32BE(8), 13, 'Invalid IHDR length');
  assert.equal(data.subarray(12, 16).toString(), 'IHDR');
  assert.equal(data.readUInt32BE(16), width);
  assert.equal(data.readUInt32BE(20), height);
  assert.equal(data[24], 8, 'Expected 8-bit channels');
  assert.equal(data[25], colorType, 'Unexpected color/alpha channel type');
}

export function checkFoundation() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const read = (file) => readFileSync(file, 'utf8');
  for (const file of ['README.md', 'LICENSE', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'ROADMAP.md', 'docs/threat-model.md', 'docs/dependency-plan.md', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.github/dependabot.yml', '.env.example']) assert.ok(tracked.includes(file), `Required tracked file: ${file}`);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.packageManager, 'pnpm@12.18.0');
  assert.equal(pkg.engines.node, read('.node-version').trim());
  assert.equal(pkg.engines.pnpm, '12.18.0');
  assert.ok(!pkg.dependencies, 'Runtime dependencies belong to their consuming workspace');
  assert.match(read('LICENSE'), /Apache License\s+Version 2\.0, January 2004/);
  checkEnv(read('.env.example'));
  checkWorkflow(read('.github/workflows/ci.yml'));
  checkPrivateArtifactWorkflow(read('.github/workflows/release-artifacts.yml'));
  for (const file of tracked) {
    assert.ok(!/(^|\/)\.env(?:\.|$)/.test(file) || file === '.env.example', `Forbidden environment file: ${file}`);
    assert.ok(!/\.(?:pem|key|p12|pfx)$/i.test(file), `Forbidden key material: ${file}`);
    if (!/\.(?:png|jpg|jpeg|gif|ico)$/i.test(file)) {
      const text = read(file);
      try { checkOperatorMetadata(text); } catch { assert.fail(`Possible private operator metadata: ${file}; inspect privately without logging the value`); }
      assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}|\bAKIA[A-Z0-9]{16}\b/, `Possible secret: ${file}`);
      if (file.endsWith('.md')) for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (/^(?:https?:|#)/.test(target)) continue;
        assert.ok(tracked.includes(resolve(dirname(file), target.split('#')[0]).slice(process.cwd().length + 1)), `Untracked or broken link in ${file}: ${target}`);
      }
    }
  }
  for (const [file, width, height, colorType] of [
    ['docs/assets/brand/logo.png', 1254, 1254, 6],
    ['docs/assets/brand/banner.png', 1774, 887, 2],
  ]) {
    assert.ok(tracked.includes(file), `Missing tracked branding: ${file}`);
    checkPngHeader(readFileSync(file), width, height, colorType);
  }
  console.log('Foundation contracts passed (not a comprehensive secret scan or product test).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) checkFoundation();
