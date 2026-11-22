import {
  Controller,
  Body,
  Get,
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
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ReconciliationReport, ReportsService, SalesReportRow, SyncConflict } from './reports.service';

export class ResolveConflictDto {
  @IsIn(['keep_cloud', 'dismissed'])
  resolution!: 'keep_cloud' | 'dismissed';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

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

  @Get('conflicts')
  conflicts(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Req() request: AuthenticatedRequest,
    @Query('status') status?: string,
  ): Promise<SyncConflict[]> {
    return this.reports.conflicts(siteId, bearer(request), status);
  }

  @Post('conflicts/:conflictId/resolve')
  resolveConflict(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('conflictId', new ParseUUIDPipe()) conflictId: string,
    @Body() dto: ResolveConflictDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.reports.resolveConflict(siteId, conflictId, dto.resolution, dto.note, bearer(request));
  }
}
