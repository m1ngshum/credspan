import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const documents = new Set(['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'ROADMAP.md', 'SECURITY.md', 'LICENSE']);
export function docsOnly(paths) {
  return paths.length > 0 && paths.every(path => documents.has(path) || /^docs\/(?:[\w-]+\/)*[\w.-]+\.md$/.test(path));
}

export function classify({ event, base, head }, git = args => execFileSync('git', args, { encoding: 'utf8' })) {
  if (event !== 'pull_request' || !/^[a-f0-9]{40}$/.test(base ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')) return false;
  try {
    const changes = git(['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`, '--']);
    if (!changes.endsWith('\0')) return false;
    return docsOnly(changes.slice(0, -1).split('\0'));
  } catch { return false; }
}

export function checkResults(needs) {
  assert.equal(needs.changes?.result, 'success', 'Classification/fast checks must succeed');
  const docs = needs.changes.outputs?.docs;
  assert.ok(docs === 'true' || docs === 'false', 'Missing or invalid classification');
  for (const job of ['native', 'integration', 'mcp']) assert.equal(needs[job]?.result, docs === 'true' ? 'skipped' : 'success', `Unexpected ${job} result`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'gate') checkResults(JSON.parse(process.env.CI_NEEDS));
  else {
    const docs = classify({ event: process.env.GITHUB_EVENT_NAME, base: process.env.PR_BASE, head: process.env.PR_HEAD });
    appendFileSync(process.env.GITHUB_OUTPUT, `docs=${docs}\n`);
    console.log(docs ? 'Documentation fast checks; runtime lanes are not required.' : 'Full verification required.');
  }
}
