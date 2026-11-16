import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const document = JSON.parse(await readFile(new URL('../packages/sdk/openapi.json', import.meta.url), 'utf8'));
function inspect(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref') assert.ok(typeof entry === 'string' && entry.startsWith('#/'), 'Generation accepts internal JSON references only');
    inspect(entry);
  }
}
inspect(document);
console.log('Code generation input is local JSON with no external references.');
