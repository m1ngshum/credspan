import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { writeFile } from 'node:fs/promises';
import { SandboxController } from './controller.js';
import { managementDocument } from './contract.js';
@Module({ controllers: [SandboxController], providers: [{ provide: 'RUNTIME', useValue: null }] })
class ContractModule {}
// Only scan controller metadata: no listener, agent, database or runtime methods.
const app = await NestFactory.create(ContractModule, { logger: false });
try { await writeFile(new URL('../../../../packages/sdk/openapi.json', import.meta.url), JSON.stringify(managementDocument(app), null, 2) + '\n'); }
finally { await app.close(); }
