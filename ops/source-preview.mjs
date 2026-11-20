import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const [version, commit, directory] = process.argv.slice(2);
assert.match(version ?? '', /^v0\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-preview\.[1-9][0-9]*$/, 'Expected v0.MINOR.PATCH-preview.N');
assert.match(commit ?? '', /^[a-f0-9]{40}$/, 'Expected a full source commit SHA');
assert.ok(directory, 'Specify a new output directory');

const git = (...args) => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });
assert.equal(git('rev-parse', 'HEAD').toString().trim(), commit, 'Checked-out commit differs from the source revision');
const basename = `credspan-${version}`;
const archive = `${basename}.tar.gz`;
const bytes = gzipSync(git('archive', '--format=tar', `--prefix=${basename}/`, commit));
const sha256 = createHash('sha256').update(bytes).digest('hex');
const tree = git('rev-parse', `${commit}^{tree}`).toString().trim();
mkdirSync(directory, { mode: 0o700 });
writeFileSync(join(directory, archive), bytes);
writeFileSync(join(directory, 'source-preview.json'), JSON.stringify({ version, commit, tree, archive, sha256, bytes: bytes.length }, null, 2) + '\n');
console.log(`${archive} SHA-256 ${sha256}`);
