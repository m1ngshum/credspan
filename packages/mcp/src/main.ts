import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { Sandbox } from './sandbox.js';
const args = process.argv.slice(2);
if (args.some(value => value !== '--allow-sandbox-tests') || args.length > 1) { console.error('mcp_invalid_startup_arguments'); process.exitCode = 1; }
else {
  // Discovery can launch a sibling and construct/discard factories. Startup never creates resources.
  const sandbox = new Sandbox(args.includes('--allow-sandbox-tests'));
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65536 });
  const handle = serveStdio(() => createServer(sandbox), { transport, onerror: () => { console.error('mcp_protocol_error'); void stop(); } });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => { try { await sandbox.shutdown(); } catch { console.error('mcp_cleanup_required'); process.exitCode = 1; } await handle.close(); process.stdin.destroy(); process.stdout.end(); })();
  const closed = transport.onclose; transport.onclose = () => { closed?.(); void stop(); };
  process.stdin.on('end', () => { void stop(); });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void stop(); });
}
