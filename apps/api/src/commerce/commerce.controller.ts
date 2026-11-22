import {
  BadRequestException,
  Body,
  Controller,
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
import { CreatePlanDto, ImportTicketStockDto, PRICING_TIERS, SetPlanActiveDto, SetTierPriceDto } from './commerce.dto';
import { CommerceResource, CommerceService, LIST_MAX_LIMIT, Page } from './commerce.service';

function bearer(request: AuthenticatedRequest): string {
  const token = readBearerToken(request.headers.authorization);
  if (!token) throw new UnauthorizedException('Bearer token required');
  return token;
}

function parseLimit(value?: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d{1,6}$/.test(value) || Number(value) < 1 || Number(value) > LIST_MAX_LIMIT) {
    throw new BadRequestException(`limit must be between 1 and ${LIST_MAX_LIMIT}`);
  }
  return Number(value);
}

@Controller('sites/:siteId')
@UseGuards(SupabaseAuthGuard)
export class CommerceController {
  constructor(private readonly commerce: CommerceService) {}

  private page(
    resource: CommerceResource,
    siteId: string,
    request: AuthenticatedRequest,
    limit?: string,
    from?: string,
    to?: string,
    cursor?: string,
  ): Promise<Page> {
    return this.commerce.list(resource, siteId, bearer(request), {
      limit: parseLimit(limit),
      from,
      to,
      cursor,
    });
  }

  @Get('sales')
  sales(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Req() request: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
  ): Promise<Page> {
    return this.page('sales', siteId, request, limit, from, to, cursor);
  }

  @Get('tickets')
  tickets(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Req() request: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
  ): Promise<Page> {
    return this.page('tickets', siteId, request, limit, from, to, cursor);
  }

  @Get('cash-entries')
  cashEntries(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Req() request: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
  ): Promise<Page> {
    return this.page('cash-entries', siteId, request, limit, from, to, cursor);
  }

  @Get('plans')
  plans(@Param('siteId', new ParseUUIDPipe()) siteId: string, @Req() request: AuthenticatedRequest) {
    return this.commerce.listPlans(siteId, bearer(request));
  }

  @Get('pricing')
  pricing(@Param('siteId', new ParseUUIDPipe()) siteId: string, @Req() request: AuthenticatedRequest) {
    return this.commerce.sitePricing(siteId, bearer(request));
  }

  @Post('pricing/:tier')
  setTierPrice(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('tier') tier: string,
    @Body() dto: SetTierPriceDto,
    @Req() request: AuthenticatedRequest,
  ) {
    if (!(PRICING_TIERS as readonly string[]).includes(tier)) {
      throw new BadRequestException(`tier must be one of ${PRICING_TIERS.join(', ')}`);
    }
    return this.commerce.setTierPrice(siteId, tier, dto, bearer(request));
  }

  @Post('plans')
  createPlan(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body() dto: CreatePlanDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.commerce.createPlan(siteId, dto, bearer(request));
  }

  @Post('plans/:planId/active')
  setPlanActive(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() dto: SetPlanActiveDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.commerce.setPlanActive(siteId, planId, dto.active, bearer(request));
  }

  @Post('plans/:planId/ticket-stock')
  importStock(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() dto: ImportTicketStockDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.commerce.importTicketStock(siteId, planId, dto.codes, bearer(request));
  }

  @Get('ticket-stock/summary')
  stockSummary(@Param('siteId', new ParseUUIDPipe()) siteId: string, @Req() request: AuthenticatedRequest) {
    return this.commerce.stockSummary(siteId, bearer(request));
  }
}
