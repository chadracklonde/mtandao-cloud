import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CreatePaymentDto } from './payments.dto';

export interface PaymentCreated {
  payment_id: string;
  provider_ref: string;
  amount: number;
  currency: string;
  status: string;
  expires_at: string;
}

@Injectable()
export class PaymentsService {
  private async rpc(name: string, body: unknown, token: string): Promise<unknown> {
    const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new ServiceUnavailableException('Supabase is not configured');

    let response: Response;
    try {
      response = await fetch(`${url}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { apikey: anonKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('Supabase is unavailable');
    }
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { code?: string };
      switch (error.code) {
        case '42501':
          throw new ForbiddenException('Insufficient permission for this payment operation');
        case 'P0002':
          throw new NotFoundException('Plan, router or payment not found in this site');
        case '23505':
          throw new ConflictException('Idempotency key already used for a different payment');
        case '22023':
          throw new BadRequestException('Invalid payment request or state');
        default:
          throw new BadGatewayException('Payment operation failed');
      }
    }
    try {
      return await response.json();
    } catch {
      throw new BadGatewayException('Supabase returned an invalid response');
    }
  }

  async create(siteId: string, dto: CreatePaymentDto, token: string): Promise<PaymentCreated> {
    const result = (await this.rpc(
      'create_payment',
      {
        p_site_id: siteId,
        p_plan_id: dto.planId,
        p_router_id: dto.routerId,
        p_customer_phone: dto.customerPhone ?? null,
        p_idempotency_key: dto.idempotencyKey ?? null,
      },
      token,
    )) as Partial<PaymentCreated> | null;
    if (!result || typeof result.payment_id !== 'string' || typeof result.provider_ref !== 'string') {
      throw new BadGatewayException('Supabase returned an invalid payment');
    }
    return result as PaymentCreated;
  }

  async retryActivation(
    siteId: string,
    paymentId: string,
    token: string,
  ): Promise<{ paymentId: string; fulfillmentStatus: string }> {
    const status = await this.rpc('retry_payment_activation', { p_site_id: siteId, p_payment_id: paymentId }, token);
    if (typeof status !== 'string') throw new BadGatewayException('Supabase returned an invalid result');
    return { paymentId, fulfillmentStatus: status };
  }
}
