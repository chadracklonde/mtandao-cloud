import { Controller, Get, Header, Param, ParseUUIDPipe, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { readBearerToken, SupabaseAuthGuard } from '../auth/auth.guard';
import { AuthenticatedRequest } from '../auth/auth.types';
import { Readiness, ReadinessService } from './readiness.service';

@Controller('sites/:siteId/readiness')
@UseGuards(SupabaseAuthGuard)
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  check(@Param('siteId', new ParseUUIDPipe()) siteId: string, @Req() request: AuthenticatedRequest): Promise<Readiness> {
    const token = readBearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Bearer token required');
    return this.readiness.check(siteId, token);
  }
}
