import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { readBearerToken, SupabaseAuthGuard } from '../auth/auth.guard';
import { AuthenticatedRequest } from '../auth/auth.types';
import { AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT, AuditEntry, AuditService } from './audit.service';

function parsePositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d{1,15}$/.test(value)) throw new BadRequestException(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (parsed < 1) throw new BadRequestException(`${name} must be a positive integer`);
  return parsed;
}

@Controller('sites/:siteId/audit')
@UseGuards(SupabaseAuthGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  list(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Req() request: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ): Promise<AuditEntry[]> {
    const token = readBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Bearer token required');
    const parsedLimit = parsePositiveInt(limit, 'limit') ?? AUDIT_DEFAULT_LIMIT;
    if (parsedLimit > AUDIT_MAX_LIMIT) {
      throw new BadRequestException(`limit must be at most ${AUDIT_MAX_LIMIT}`);
    }
    return this.auditService.list(siteId, token, parsedLimit, parsePositiveInt(before, 'before'));
  }
}
