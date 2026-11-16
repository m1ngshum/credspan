import type { SchemaObject } from '@nestjs/swagger';
const text = { type: 'string' } as const;
const date = { type: 'string', format: 'date-time' } as const;
const object = (properties: Record<string, SchemaObject>, required = Object.keys(properties)): SchemaObject => ({ type: 'object', additionalProperties: false, properties, required });
const historical = { id: text, accepted: { type: 'boolean', enum: [false] } as SchemaObject, checkedAt: date, verifiedAt: date, authorizationExpiresAt: date };
export const schemas = {
  empty: object({}),
  membership: object({ name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^(?=[\\s\\S]*\\S)[^\\u0000-\\u001f\\u007f]+$' }, memberId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', minLength: 1, maxLength: 64 } }),
  issuance: object({ id: text, offer: text, credentialId: text, expiresAt: date }),
  issuanceStatus: object({ id: text, state: text, credentialId: text, expiresAt: date, tokenConsumed: { type: 'boolean' }, credentialAttempted: { type: 'boolean' } }),
  presentation: object({ id: text, request: text, expiresAt: date }),
  revocation: object({ credentialId: text, revoked: { type: 'boolean', enum: [true] } }),
  result: { oneOf: [object({ id: text, accepted: { type: 'boolean', enum: [false] }, checkedAt: date }), object(historical), object({ ...historical, accepted: { type: 'boolean', enum: [true] }, credentialId: text, memberId: text, expiresAt: date })] } as SchemaObject,
  unauthorized: object({ error: { type: 'string', enum: ['unauthorized'] } }),
  error: object({ message: text, error: text, statusCode: { type: 'integer' } }, ['message', 'statusCode']),
};
export const response = (schema: SchemaObject) => ({ content: { 'application/json': { schema } } });
