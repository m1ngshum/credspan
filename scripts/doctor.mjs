import { docker } from '../ops/local.mjs';
let failed = false;
function check(name, run) { try { console.log(`${name}: ${run()}`); } catch { failed = true; console.log(`${name}: unavailable; see docs/developer-experience.md`); } }
check('Node', () => { if (process.version !== 'v26.13.1') throw Error(); return process.version; });
check('Docker', () => docker(['version', '--format', '{{.Server.Version}}']));
check('Modified wallet peer', () => { const patch = docker(['image', 'inspect', 'credspan-wallet-peer:1.2.1-preauth', '--format', '{{index .Config.Labels "credspan.probe.patch.sha256"}}']); if (patch !== 'ed059fd9f91f8b371c2c35839ed5a350185ebea16d346054d286db83e05e73aa') throw Error(); return 'reviewed parser patch present'; });
try { const api = new URL(process.env.CREDSPAN_API_URL ?? 'http://127.0.0.1:3000'); if (!['http:', 'https:'].includes(api.protocol) || !['localhost', '127.0.0.1'].includes(api.hostname) || api.username || api.password || api.pathname !== '/' || api.search || api.hash) throw Error(); const response = await fetch(api.origin + '/openapi.json', { redirect: 'error', signal: AbortSignal.timeout(2000) }); if (!response.ok || (await response.json()).info.title !== 'Credspan local management API') throw Error(); console.log('Local API: management contract reachable'); } catch { failed = true; console.log('Local API: unavailable; set a valid loopback CREDSPAN_API_URL or start port 3000'); }
if (failed) process.exitCode = 1;
