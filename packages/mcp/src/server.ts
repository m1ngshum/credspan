import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Sandbox } from './sandbox.js';
import { cleanupStages, cleanupCodes } from './cleanup.js';
import { OperationError } from './process.js';
const cleanupFailureSchema = z.strictObject({ stage: z.enum(cleanupStages), code: z.enum(cleanupCodes) }).optional();
const result = <T extends Record<string, unknown>>(value: T, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError } : {}) });
export function createServer(sandbox: Sandbox) {
  const server = new McpServer({ name: 'credspan-local-mcp-server', version: '0.0.0' }, { capabilities: { tools: {} }, supportedProtocolVersions: ['2026-07-28', '2025-11-25'], maxToolInputElements: 16 });
  server.registerTool('diagnostics', {
    description: 'Read fixed nonsecret local prerequisites and sandbox capability state. Does not inspect active credentials or mutate deployments.',
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ scope: z.literal('local-synthetic'), nodeReady: z.boolean(), platformReady: z.boolean(), dockerReady: z.boolean(), imagesReady: z.boolean(), sandboxEnabled: z.boolean(), busy: z.boolean(), cleanupRequired: z.boolean(), cleanupFailure: cleanupFailureSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (_args, context) => result(await sandbox.diagnostics(context.mcpReq.signal)));
  server.registerTool('propose_config', {
    description: 'Validate a nonsecret loopback sandbox configuration proposal. Always applied:false; does not write files, reserve ports or deploy.',
    inputSchema: z.strictObject({ port: z.int().min(1024).max(65535), bind: z.literal('loopback') }),
    outputSchema: z.strictObject({ bind: z.literal('loopback'), port: z.int(), browserOrigin: z.string(), canonicalOrigin: z.string(), applied: z.literal(false), scope: z.literal('local-synthetic') }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ port, bind }) => result({ port, bind, browserOrigin: `http://127.0.0.1:${port}`, canonicalOrigin: `http://host.docker.internal:${port}`, applied: false as const, scope: 'local-synthetic' as const }));
  server.registerTool('run_sandbox_test', {
    description: 'Run one predefined isolated synthetic independent-wallet scenario, then remove exact owned resources. Requires startup --allow-sandbox-tests; never accesses an active deployment. Fixed deadline and one-run limit; cleanup failure is explicit.',
    inputSchema: z.strictObject({ scenario: z.enum(['membership-roundtrip', 'revocation']) }),
    outputSchema: z.strictObject({ scenario: z.enum(['membership-roundtrip', 'revocation']), passed: z.boolean(), checks: z.array(z.string()), cleanupComplete: z.boolean(), code: z.string(), stage: z.string(), cleanupFailure: cleanupFailureSchema, apiImage: z.string().optional(), apiSource: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ scenario }, context) => {
    try { const value = await sandbox.run(scenario, context.mcpReq.signal); return result(value, !value.passed); }
    catch (error) { return result({ scenario, passed: false, checks: [], cleanupComplete: error instanceof OperationError && error.code !== 'cleanup_required', code: error instanceof OperationError ? error.code : 'unavailable', stage: 'preflight' }, true); }
  });
  return server;
}
