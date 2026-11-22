import {
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
import { ReconciliationReport, ReportsService, SalesReportRow } from './reports.service';

function bearer(request: AuthenticatedRequest): string {
  const token = readBearerToken(request.headers.authorization);
  if (!token) throw new UnauthorizedException('Bearer token required');
  return token;
}

@Controller('sites/:siteId/reports')
@UseGuards(SupabaseAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  sales(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Req() request: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('group') group?: string,
  ): Promise<SalesReportRow[]> {
    return this.reports.sales(siteId, bearer(request), { from, to, group });
  }

  @Get('reconciliation')
  reconciliation(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Req() request: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<ReconciliationReport> {
    return this.reports.reconciliation(siteId, bearer(request), { from, to });
  }
}
