// Explicit operator/CI preparation; the MCP server never imports this script.
import { readFile } from 'node:fs/promises';
import { docker } from './local.mjs';
const images = JSON.parse(await readFile(new URL('./images.json', import.meta.url)));
for (const name of ['postgres', 'caddy']) {
  const reference = images[name];
  if (!/^[a-z0-9./:-]+@sha256:[a-f0-9]{64}$/.test(reference)) throw Error('Sandbox service image must have an immutable digest');
  docker(['pull', reference], { timeout: 180000 });
  console.log(`${name}: digest-pinned sandbox image cached`);
}
