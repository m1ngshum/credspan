import { RecordNotFoundError } from '@credo-ts/core';
import { Body, Controller, Get, Inject, Param, Post, BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Runtime } from './runtime.js';
import { schemas, response } from './schemas.js';

@ApiBearerAuth()
@Controller('api')
export class SandboxController {
  constructor(@Inject('RUNTIME') private readonly runtime: Runtime) {}
  @ApiExcludeEndpoint()
  @Post('roundtrips')
  create(@Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BadRequestException('Only an empty object is accepted; the sandbox profile is fixed');
    return this.runtime.createRoundtrip();
  }
  @ApiOperation({ operationId: 'createPresentation' })
  @ApiResponse({ status: 201, ...response(schemas.presentation) })
  @ApiResponse({ status: 401, ...response(schemas.unauthorized) })
  @ApiResponse({ status: 400, ...response(schemas.error) })
  @ApiResponse({ status: 500, ...response(schemas.error) })
  @ApiBody({ schema: schemas.empty })
  @Post('presentation-requests')
  presentation(@Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BadRequestException('Only the fixed memberId profile is supported');
    return this.runtime.createPresentation();
  }
  @ApiOperation({ operationId: 'getPresentationResult' })
  @ApiResponse({ status: 200, ...response(schemas.result) })
  @ApiResponse({ status: 401, ...response(schemas.unauthorized) })
  @ApiResponse({ status: 400, ...response(schemas.error) })
  @ApiResponse({ status: 500, ...response(schemas.error) })
  @ApiResponse({ status: 404, ...response(schemas.error) })
  @ApiResponse({ status: 503, ...response(schemas.error) })
  @ApiParam({ name: 'id', schema: { type: 'string', pattern: '^[a-f0-9-]{36}$' } })
  @Get('presentation-requests/:id/result')
  async result(@Param('id') id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new BadRequestException('Invalid session');
    try { return await this.runtime.presentationResult(id); } catch (error) {
      if (error instanceof RecordNotFoundError) throw new NotFoundException('Unknown presentation');
      throw new ServiceUnavailableException('Presentation result unavailable');
    }
  }
  @ApiOperation({ operationId: 'revokeCredential' })
  @ApiResponse({ status: 201, ...response(schemas.revocation) })
  @ApiResponse({ status: 401, ...response(schemas.unauthorized) })
  @ApiResponse({ status: 400, ...response(schemas.error) })
  @ApiResponse({ status: 500, ...response(schemas.error) })
  @ApiResponse({ status: 404, ...response(schemas.error) })
  @ApiResponse({ status: 503, ...response(schemas.error) })
  @ApiParam({ name: 'id', schema: { type: 'string', pattern: '^urn:uuid:[a-f0-9-]{36}$' } })
  @ApiBody({ schema: schemas.empty })
  @Post('credentials/:id/revoke')
  async revoke(@Param('id') id: string, @Body() body: unknown) {
    if (!/^urn:uuid:[a-f0-9-]{36}$/.test(id) || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BadRequestException('Expected credential ID and empty body');
    try { return await this.runtime.revoke(id); } catch (error) {
      if (error instanceof RecordNotFoundError) throw new NotFoundException('Unknown credential');
      throw new ServiceUnavailableException('Revocation unavailable');
    }
  }
  @ApiOperation({ operationId: 'createIssuance' })
  @ApiResponse({ status: 201, ...response(schemas.issuance) })
  @ApiResponse({ status: 401, ...response(schemas.unauthorized) })
  @ApiResponse({ status: 400, ...response(schemas.error) })
  @ApiResponse({ status: 500, ...response(schemas.error) })
  @ApiBody({ schema: schemas.membership })
  @Post('issuance-sessions')
  issue(@Body() body: unknown) { return this.runtime.createIssuance(body); }
  @ApiOperation({ operationId: 'getIssuanceStatus' })
  @ApiResponse({ status: 200, ...response(schemas.issuanceStatus) })
  @ApiResponse({ status: 401, ...response(schemas.unauthorized) })
  @ApiResponse({ status: 400, ...response(schemas.error) })
  @ApiResponse({ status: 500, ...response(schemas.error) })
  @ApiResponse({ status: 404, ...response(schemas.error) })
  @ApiResponse({ status: 503, ...response(schemas.error) })
  @ApiParam({ name: 'id', schema: { type: 'string', pattern: '^[a-f0-9-]{36}$' } })
  @Get('issuance-sessions/:id')
  async issuanceStatus(@Param('id') id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new BadRequestException('Invalid session');
    try { return await this.runtime.issuanceStatus(id); } catch (error) {
      if (error instanceof RecordNotFoundError) throw new NotFoundException('Unknown issuance session');
      throw new ServiceUnavailableException('Issuance status unavailable');
    }
  }
  @ApiExcludeEndpoint()
  @Get('roundtrips/:id')
  status(@Param('id') id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new BadRequestException('Invalid session');
    return this.runtime.status(id);
  }
}
