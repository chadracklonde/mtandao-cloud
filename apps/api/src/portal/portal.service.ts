import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PortalCreatePaymentDto } from './portal.dto';

export interface PortalCreated {
  paymentId: string;
  providerRef: string;
  amount: number;
  currency: string;
  expiresAt: string;
  accessExpiresAt: string;
  /** Shown once. Only its SHA-256 hash is stored. */
  accessToken: string;
}

@Injectable()
export class PortalService {
  /** Portal data is read and written with the server-side service role only. */
  private async rpc(name: string, body: unknown): Promise<unknown> {
    const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new ServiceUnavailableException('The customer portal is not configured');

    let response: Response;
    try {
      response = await fetch(`${url}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('The customer portal is temporarily unavailable');
    }
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { code?: string };
      switch (error.code) {
        case 'P0002':
          throw new NotFoundException('Not found');
        case '22023':
          throw new BadRequestException('Invalid request');
        case '23505':
          throw new ConflictException('This request conflicts with an earlier one');
        case '53400':
          throw new HttpException('Too many pending payments, try again later', HttpStatus.TOO_MANY_REQUESTS);
        default:
          throw new BadGatewayException('The customer portal could not complete the request');
      }
    }
    try {
      return await response.json();
    } catch {
      throw new BadGatewayException('The customer portal returned an invalid response');
    }
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async catalog(siteId: string): Promise<unknown> {
    const result = await this.rpc('portal_catalog', { p_site_id: siteId });
    if (!result || typeof result !== 'object' || !Array.isArray((result as { plans?: unknown }).plans)) {
      throw new BadGatewayException('The customer portal returned an invalid catalog');
    }
    return result;
  }

  async createPayment(siteId: string, dto: PortalCreatePaymentDto): Promise<PortalCreated> {
    const accessToken = randomBytes(32).toString('hex');
    const result = (await this.rpc('portal_create_payment', {
      p_site_id: siteId,
      p_plan_id: dto.planId,
      p_router_id: dto.routerId,
      p_customer_phone: dto.customerPhone,
      p_idempotency_key: dto.idempotencyKey ?? null,
      p_token_hash: PortalService.hashToken(accessToken),
    })) as Record<string, unknown> | null;

    if (
      !result ||
      typeof result.payment_id !== 'string' ||
      typeof result.provider_ref !== 'string' ||
      typeof result.amount !== 'number' ||
      typeof result.currency !== 'string' ||
      typeof result.expires_at !== 'string' ||
      typeof result.access_expires_at !== 'string'
    ) {
      throw new BadGatewayException('The customer portal returned an invalid payment');
    }
    return {
      paymentId: result.payment_id,
      providerRef: result.provider_ref,
      amount: result.amount,
      currency: result.currency,
      expiresAt: result.expires_at,
      accessExpiresAt: result.access_expires_at,
      accessToken,
    };
  }

  async status(paymentId: string, accessToken: string): Promise<unknown> {
    const result = await this.rpc('portal_payment_status', {
      p_payment_id: paymentId,
      p_token_hash: PortalService.hashToken(accessToken),
    });
    if (!result || typeof result !== 'object') {
      throw new BadGatewayException('The customer portal returned an invalid status');
    }
    return result;
  }
}
