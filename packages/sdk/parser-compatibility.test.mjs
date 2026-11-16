import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const generatorRequire = createRequire(import.meta.resolve('@hey-api/openapi-ts'));
const parserPackage = generatorRequire.resolve('@hey-api/json-schema-ref-parser/package.json');
const parserEntry = new URL('./dist/index.mjs', pathToFileURL(parserPackage));
const parserRequire = createRequire(parserPackage);
const yaml = parserRequire('js-yaml');
const { $RefParser } = await import(parserEntry.href);
test('qualified parser child patch preserves JSON, YAML merges, ordered maps and references', async () => {
  assert.equal(parserRequire('js-yaml/package.json').version, '4.3.2');
  const directory = await mkdtemp(join(tmpdir(), 'credspan-parser-'));
  try {
    const document = { type: 'object', properties: { id: { $ref: '#/$defs/id' } }, $defs: { id: { type: 'string' } } };
    await writeFile(join(directory, 'schema.json'), JSON.stringify(document));
    assert.deepEqual((await new $RefParser().parse({ pathOrUrlOrSchema: join(directory, 'schema.json') })).schema, document);
    const bundled = await new $RefParser().bundle({ pathOrUrlOrSchema: join(directory, 'schema.json') }); assert.deepEqual(bundled, document);
    await writeFile(join(directory, 'schema.yaml'), 'base: &base\n  type: string\nproperties:\n  id:\n    <<: *base\n    description: identifier\n');
    assert.deepEqual((await new $RefParser().parse({ pathOrUrlOrSchema: join(directory, 'schema.yaml') })).schema.properties.id, { type: 'string', description: 'identifier' });
    assert.deepEqual(yaml.load('!!omap\n- a: 1\n- b: 2\n'), [{ a: 1 }, { b: 2 }]);
    assert.throws(() => yaml.load('!!omap\n- a: 1\n- a: 2\n'));
    assert.throws(() => yaml.load('broken: [unterminated'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('patched YAML parser charges empty-source merge work rather than allowing unbounded chains', () => {
  const input = `base: &base {}\nmerged:\n  <<: [${Array(10001).fill('*base').join(', ')}]\n`;
  assert.throws(() => yaml.load(input), /maxTotalMergeKeys|abnormal merge sequence size/);
});
