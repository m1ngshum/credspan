import 'reflect-metadata';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { Module } from '@nestjs/common';
import { SandboxController } from './controller.js';
import { managementDocument } from './contract.js';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { createRuntime, type Runtime } from './runtime.js';
import type { Config } from './config.js';

@Module({})
class SandboxModule {}

export async function createApplication(config: Config) {
  const server = express();
  server.disable('x-powered-by');
  const canonical = new URL(config.publicUrl);
  const origins = new Set(config.hosted ? [config.publicUrl] : [config.publicUrl, `${canonical.protocol}//127.0.0.1:${canonical.port || (canonical.protocol === 'https:' ? '443' : '80')}`, `${canonical.protocol}//localhost:${canonical.port || (canonical.protocol === 'https:' ? '443' : '80')}`, `http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, ...(config.consoleDevOrigin ? [config.consoleDevOrigin] : [])]);
  const hosts = new Set([...origins].map(origin => new URL(origin).host));
  server.use((request, response, next) => {
    if (config.hosted && request.headers.host === 'healthcheck.railway.app' && request.method === 'GET' && request.originalUrl === '/health/ready' && request.headers.origin === undefined) { next(); return; }
    if (!request.headers.host || !hosts.has(request.headers.host.toLowerCase())) { response.status(421).json({ error: 'invalid_host' }); return; }
    if (request.headers.origin !== undefined && !origins.has(request.headers.origin)) { response.status(403).json({ error: 'invalid_origin' }); return; }
    next();
  });
  let checkFence: () => void = () => { throw Error('Not ready'); };
  const metrics = { requests: 0, errors: 0 };
  server.use((request, response, next) => {
    const guarded = /^\/(api|issuer|verifier|status-lists|\.well-known)(\/|$)/i.test(request.path);
    const started = performance.now();
    response.on('finish', () => {
      metrics.requests++; if (response.statusCode >= 400) metrics.errors++;
      if (process.env.CREDSPAN_TELEMETRY === '1') console.log(JSON.stringify({ event: 'http', operation: guarded ? 'credential-api' : 'other', method: ['GET', 'POST', 'HEAD'].includes(request.method) ? request.method : 'OTHER', status: response.statusCode, durationMs: Math.round(performance.now() - started) }));
    });
    if (!guarded) { next(); return; }
    try { checkFence(); } catch { response.status(503).json({ error: 'deployment_fenced' }); return; }
    const end = response.end.bind(response) as (...args: any[]) => typeof response;
    response.end = (...args: any[]) => {
      try { checkFence(); } catch {
        if (response.headersSent) { response.destroy(); return response; }
        for (const header of ['Content-Length', 'Location', 'WWW-Authenticate']) response.removeHeader(header);
        response.statusCode = 503; response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
        return end(JSON.stringify({ error: 'deployment_fenced' }));
      }
      return end(...args);
    };
    next();
  });
  server.use(express.json({ limit: '32kb' }), express.urlencoded({ extended: false, limit: '32kb' }));
  server.use(((error, _request, response, _next) => { response.status(error?.type === 'entity.too.large' ? 413 : 400).json({ error: 'invalid_body' }); }) as import('express').ErrorRequestHandler);
  server.use('/api', (request, response, next) => {
    const authorizationCount = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'authorization').length;
    if (authorizationCount !== 1) { response.status(401).json({ error: 'unauthorized' }); return; }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.slice(7).includes(' ')) { response.status(401).json({ error: 'unauthorized' }); return; }
    const supplied = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(config.apiKey);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.status(401).json({ error: 'unauthorized' }); return; }
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Reject legacy/plaintext submissions before any PEX path; generated requests use encrypted JARM.
  server.post('/verifier/:verifierId/authorize', (request, response, next) => {
    if (typeof request.query.session !== 'string' || !/^[a-f0-9-]{36}$/.test(request.query.session) || !request.body || Object.keys(request.body).length !== 1 || typeof request.body.response !== 'string') { response.status(400).json({ error: 'invalid_request' }); return; }
    next();
  });
  const runtime = await createRuntime(server, config);
  checkFence = runtime.fence.assert;
  server.get('/health/live', (_request, response) => response.json({ live: true }));
  server.get('/health/ready', async (_request, response) => {
    try { checkFence(); const record = await bounded(runtime.agent.genericRecords.findById('credspan:identity:v1'), 2000); if (!record || record.content.version !== 2 || record.content.generation !== runtime.fence.generation || record.content.cohortId !== runtime.identity.cohortId) throw Error('Invalid configuration'); checkFence(); response.json({ ready: true }); }
    catch { response.status(503).json({ ready: false }); }
  });
  server.get('/metrics', (_request, response) => response.type('text/plain').send(`credspan_http_requests_total ${metrics.requests}\ncredspan_http_errors_total ${metrics.errors}\n`));
  try {
    const app = await NestFactory.create({ module: SandboxModule, controllers: [SandboxController], providers: [{ provide: 'RUNTIME', useValue: runtime }] }, new ExpressAdapter(server), { bodyParser: false, logger: false });
    const document = managementDocument(app);
    server.get('/openapi.json', (_request, response) => response.json(document));
    server.use('/console', (_request, response, next) => {
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'no-store');
      next();
    }, express.static(fileURLToPath(new URL('../../../console/dist/', import.meta.url))));
    await app.init();
    return { app, runtime, async close() { await app.close(); await runtime.close(); } };
  } catch (error) { await runtime.close(); throw error; }
}

async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('Readiness timeout')), milliseconds); timer.unref(); })]); }
  finally { if (timer) clearTimeout(timer); }
}
