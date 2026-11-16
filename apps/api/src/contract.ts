import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
export function managementDocument(app: INestApplication) {
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Credspan local management API').setDescription('Synthetic local managed membership only. Historical verification never renews authentication.').setVersion('0.0.0').addBearerAuth().build());
  for (const path of Object.values(document.paths)) for (const operation of Object.values(path)) {
    if (!operation || typeof operation !== 'object' || !('responses' in operation)) continue;
    for (const [status, reason] of Object.entries({ 400: 'invalid_body', 403: 'invalid_origin', 413: 'invalid_body', 421: 'invalid_host', 503: 'deployment_fenced' })) {
      const schema = { type: 'object' as const, additionalProperties: false, required: ['error'], properties: { error: { type: 'string' as const, enum: [reason] } } };
      const existing = operation.responses[status] as import('@nestjs/swagger').ResponseObject | undefined;
      const prior = existing?.content?.['application/json']?.schema;
      operation.responses[status] = { description: existing?.description ?? 'Local deployment boundary rejection', content: { 'application/json': { schema: prior ? { oneOf: [prior, schema] } : schema } } };
    }
  }
  return document;
}
