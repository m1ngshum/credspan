import { rm, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
// The upstream CLI can exit zero on invalid input; stale output must never hide a failed generation.
await rm(new URL('./src/generated/', import.meta.url), { recursive: true, force: true });
execFileSync('openapi-ts', [], { stdio: 'inherit' });
for (const file of ['sdk.gen.ts', 'types.gen.ts', 'client.gen.ts']) await access(new URL(`./src/generated/${file}`, import.meta.url));
