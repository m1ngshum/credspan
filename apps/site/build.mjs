import { copyFile, mkdir, rm } from 'node:fs/promises';

const destination = new URL('./dist/', import.meta.url);
await rm(destination, { recursive: true, force: true });
await mkdir(new URL('assets/', destination), { recursive: true });
for (const file of ['index.html', 'style.css', '_headers', '404.html', 'robots.txt', 'sitemap.xml']) {
  await copyFile(new URL(file, import.meta.url), new URL(file, destination));
}
for (const file of ['lockup.svg', 'logo.svg', 'banner.png']) {
  await copyFile(new URL(`../../docs/assets/brand/${file}`, import.meta.url), new URL(`assets/${file}`, destination));
}
await copyFile(new URL('./console.png', import.meta.url), new URL('assets/console.png', destination));
await copyFile(new URL('../console/public/favicon.svg', import.meta.url), new URL('favicon.svg', destination));
await copyFile(new URL('../console/public/apple-touch-icon.png', import.meta.url), new URL('apple-touch-icon.png', destination));
console.log('Built the public homepage only; API, console code and private configuration are excluded.');
