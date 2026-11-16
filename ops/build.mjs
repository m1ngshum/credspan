import { execFileSync } from 'node:child_process';
import { docker } from './local.mjs';
const interim = process.argv.includes('--interim');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
if (dirty && !interim) throw Error('Commit a clean source tree before building release evidence');
await import('./fetch-native.mjs');
docker(['build', '--build-arg', `SOURCE_REVISION=${dirty ? 'interim-' : ''}${revision}`, '--tag', 'credspan-api:local', '.'], { timeout: 1200000 });
console.log(JSON.stringify({ image: docker(['image', 'inspect', 'credspan-api:local', '--format', '{{.Id}}']), source: revision, interim: !!dirty }));
