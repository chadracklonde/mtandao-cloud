import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { readBearerToken, SupabaseAuthGuard } from '../auth/auth.guard';
import { AuthenticatedRequest } from '../auth/auth.types';
import { ClaimCommandsDto, CommandResultDto, CreateGatewayCommandDto, CreateVoucherDto } from './commands.dto';
import { CommandRecord, CommandsService } from './commands.service';

function bearer(request: AuthenticatedRequest): string {
  const token = readBearerToken(request.headers.authorization);
  if (!token) throw new UnauthorizedException('Bearer token required');
  return token;
}

@Controller('sites/:siteId')
@UseGuards(SupabaseAuthGuard)
export class CommandsController {
  constructor(private readonly commands: CommandsService) {}

  @Post('routers/:routerId/commands')
  create(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('routerId', new ParseUUIDPipe()) routerId: string,
    @Body() dto: CreateGatewayCommandDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.commands.create(siteId, routerId, dto, bearer(request));
  }

  @Post('routers/:routerId/vouchers')
  createVoucher(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('routerId', new ParseUUIDPipe()) routerId: string,
    @Body() dto: CreateVoucherDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.commands.createVoucher(siteId, routerId, dto, bearer(request));
  }

  @Get('commands')
  list(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Req() request: AuthenticatedRequest,
    @Query('routerId') routerId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ): Promise<CommandRecord[]> {
    if (routerId !== undefined && !/^[0-9a-f-]{36}$/i.test(routerId)) {
      throw new BadRequestException('routerId must be a UUID');
    }
    if (limit !== undefined && !/^\d{1,3}$/.test(limit)) throw new BadRequestException('limit is invalid');
    return this.commands.list(siteId, bearer(request), {
      routerId,
      status,
      limit: limit === undefined ? undefined : Number(limit),
    });
  }

  @Post('commands/:commandId/cancel')
  cancel(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('commandId', new ParseUUIDPipe()) commandId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.commands.cancel(siteId, commandId, bearer(request));
  }
}

function gatewayToken(authorization?: string): string {
  const match = authorization?.match(/^Bearer ([a-f0-9]{64})$/);
  if (!match) throw new UnauthorizedException('Gateway bearer credential required');
  return match[1];
}

@Controller('gateway/commands')
export class GatewayCommandsController {
  constructor(private readonly commands: CommandsService) {}

  @Post('claim')
  claim(@Headers('authorization') authorization?: string, @Body() body: ClaimCommandsDto = {}) {
    return this.commands.claim(gatewayToken(authorization), body.limit ?? 10);
  }

  @Post(':commandId/result')
  result(
    @Param('commandId', new ParseUUIDPipe()) commandId: string,
    @Body() body: CommandResultDto,
    @Headers('authorization') authorization?: string,
  ) {
    return this.commands.report(gatewayToken(authorization), commandId, body.success, body.result, body.error);
  }
}
