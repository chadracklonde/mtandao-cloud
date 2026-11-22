import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Headers, PaymentProvider, SandboxPaymentProvider, WebhookRejectedError } from './payment-provider';

export type WebhookOutcome =
  | 'paid' | 'failed' | 'duplicate' | 'already_paid' | 'amount_mismatch' | 'unmatched' | 'ignored';

@Injectable()
export class WebhookService {
  private readonly providers: Map<string, PaymentProvider>;

  constructor() {
    this.providers = new Map<string, PaymentProvider>([['sandbox', new SandboxPaymentProvider()]]);
  }

  /**
   * Verifies the provider signature, then applies the event through a database
   * function reachable only with the service role. Database failures surface as
   * errors so the provider retries; every other result is a final 200.
   */
  async handle(
    providerName: string,
    rawBody: Buffer | undefined,
    headers: Headers,
    now: Date = new Date(),
  ): Promise<{ outcome: WebhookOutcome }> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new NotFoundException('Unknown payment provider');
    if (!provider.isConfigured()) throw new ServiceUnavailableException('Payment provider is not configured');
    if (!rawBody) throw new BadRequestException('Request body is required');

    let event;
    try {
      event = provider.verifyAndParse(rawBody, headers, now);
    } catch (error) {
      if (error instanceof WebhookRejectedError) {
        if (error.reason === 'signature') throw new UnauthorizedException('Invalid webhook signature');
        throw new BadRequestException('Invalid webhook payload');
      }
      throw error;
    }

    const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw new ServiceUnavailableException('Payment processing is not configured');

    let response: Response;
    try {
      response = await fetch(`${url}/rest/v1/rpc/process_payment_webhook`, {
        method: 'POST',
        headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          p_provider: provider.name,
          p_event_id: event.eventId,
          p_provider_ref: event.providerRef,
          p_status: event.status,
          p_amount: event.amount,
          p_currency: event.currency,
          p_payload: event.payload,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ServiceUnavailableException('Payment storage is unavailable');
    }
    if (!response.ok) throw new BadGatewayException('Unable to record the payment event');

    const result: unknown = await response.json().catch(() => null);
    const outcome = (result as { outcome?: unknown } | null)?.outcome;
    if (typeof outcome !== 'string') throw new BadGatewayException('Payment storage returned an invalid result');
    return { outcome: outcome as WebhookOutcome };
  }
}
