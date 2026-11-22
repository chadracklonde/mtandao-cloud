import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { readBearerToken, SupabaseAuthGuard } from '../auth/auth.guard';
import { AuthenticatedRequest } from '../auth/auth.types';
import { CommerceService, LIST_MAX_LIMIT, Page } from '../commerce/commerce.service';
import { CreatePaymentDto } from './payments.dto';
import { PaymentsService } from './payments.service';
import { WebhookService } from './webhook.service';

function bearer(request: AuthenticatedRequest): string {
  const token = readBearerToken(request.headers.authorization);
  if (!token) throw new UnauthorizedException('Bearer token required');
  return token;
}

@Controller('sites/:siteId/payments')
@UseGuards(SupabaseAuthGuard)
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly commerce: CommerceService,
  ) {}

  @Post()
  create(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Body() dto: CreatePaymentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.payments.create(siteId, dto, bearer(request));
  }

  @Get()
  async list(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Req() request: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
  ): Promise<Page> {
    if (limit !== undefined && (!/^\d{1,6}$/.test(limit) || Number(limit) < 1 || Number(limit) > LIST_MAX_LIMIT)) {
      throw new BadRequestException(`limit must be between 1 and ${LIST_MAX_LIMIT}`);
    }
    const page = await this.commerce.list('payments', siteId, bearer(request), {
      limit: limit === undefined ? undefined : Number(limit),
      from,
      to,
      cursor,
    });
    // A pending payment past its deadline is expired even before the sweep runs.
    const now = Date.now();
    const items = page.items.map(item =>
      item.status === 'pending' && typeof item.expires_at === 'string' && Date.parse(item.expires_at) <= now
        ? { ...item, status: 'expired' }
        : item,
    );
    return { items, next_cursor: page.next_cursor };
  }

  @Post(':paymentId/retry-activation')
  retry(
    @Param('siteId', new ParseUUIDPipe()) siteId: string,
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.payments.retryActivation(siteId, paymentId, bearer(request));
  }
}

/** Public endpoint called by payment providers; authenticity comes from the signature. */
@Controller('webhooks/payments')
export class PaymentWebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  @Post(':provider')
  @HttpCode(200)
  receive(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest<{ headers: Record<string, string | string[] | undefined> }>,
  ) {
    return this.webhooks.handle(provider, request.rawBody, request.headers);
  }
}
