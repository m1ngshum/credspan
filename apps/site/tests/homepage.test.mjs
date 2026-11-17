import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const output = new URL('../dist/', import.meta.url);
test('public artifact has only the homepage allowlist and resolving local links', async () => {
  assert.deepEqual((await readdir(output)).sort(), ['404.html', '_headers', 'apple-touch-icon.png', 'assets', 'favicon.svg', 'index.html', 'robots.txt', 'sitemap.xml', 'style.css']);
  assert.deepEqual((await readdir(new URL('assets/', output))).sort(), ['banner.png', 'console.png', 'lockup.svg', 'logo.svg']);
  const html = await readFile(new URL('index.html', output), 'utf8');
  for (const [, target] of html.matchAll(/(?:href|src)="(\/[^"#]*)"/g)) await readFile(new URL(target === '/' ? 'index.html' : target.slice(1), output));
  for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(html.includes(`id="${id}"`), `Missing anchor ${id}`);
  assert.doesNotMatch(html, /<script|<form|localhost|127\.0\.0\.1|repository is currently private/i);
  assert.match(html, /local and private hosted synthetic membership sandboxes/);
  assert.match(html, /href="https:\/\/github\.com\/m1ngshum\/credspan"[^>]*>View the source<\/a>/);
  const external = [...html.matchAll(/href="(https?:[^"\s]+)"/g)].map(([, url]) => url);
  assert.deepEqual([...new Set(external)].sort(), ['https://credspan.m1ngshum.com/', 'https://github.com/m1ngshum/credspan', 'https://m1ngshum.com/']);
  assert.match(await readFile(new URL('_headers', output), 'utf8'), /default-src 'none'/);
});
