import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { PortalCreatePaymentDto } from './portal.dto';
import { PortalCreated, PortalService } from './portal.service';
import { RateLimiter } from './rate-limiter';

const MINUTE = 60_000;
const limiter = new RateLimiter();

function clientKey(request: { ip?: string }): string {
  return request.ip ?? 'unknown';
}

function enforce(scope: string, request: { ip?: string }, limit: number, windowMs: number): void {
  if (!limiter.allow(`${scope}:${clientKey(request)}`, limit, windowMs)) {
    throw new HttpException('Too many requests, slow down', HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * Public customer portal. No account is needed: a customer proves ownership of a
 * payment with the access token returned when it was created.
 */
@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('sites/:siteId')
  @Header('Cache-Control', 'no-store')
  catalog(@Param('siteId', new ParseUUIDPipe()) siteId: string, @Req() request: { ip?: string }) {
    enforce('catalog', request, 60, MINUTE);
    return this.portal.catalog(siteId);
  }

  @Post('sites/:siteId/payments')
  @Header('Cache-Control', 'no-store')
  create(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body() dto: PortalCreatePaymentDto,
    @Req() request: { ip?: string },
  ): Promise<PortalCreated> {
    enforce('create', request, 10, 10 * MINUTE);
    return this.portal.createPayment(siteId, dto);
  }

  @Get('payments/:paymentId')
  @Header('Cache-Control', 'no-store')
  status(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: { ip?: string },
  ) {
    enforce('status', request, 120, MINUTE);
    const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization ?? '');
    if (!match) throw new UnauthorizedException('Payment access token required');
    return this.portal.status(paymentId, match[1]);
  }
}
