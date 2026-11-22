import { createHmac, timingSafeEqual } from 'node:crypto';

export type PaymentCurrency = 'CDF' | 'USD';

export interface ParsedWebhook {
  eventId: string;
  providerRef: string;
  status: 'succeeded' | 'failed';
  amount: number;
  currency: PaymentCurrency;
  payload: Record<string, unknown>;
}

/** Thrown when a webhook cannot be trusted or understood. */
export class WebhookRejectedError extends Error {
  constructor(
    readonly reason: 'signature' | 'malformed',
    message: string,
  ) {
    super(message);
  }
}

export type Headers = Record<string, string | string[] | undefined>;

/**
 * A payment provider turns its signed callbacks into a normalized event.
 * Real Mobile Money providers are added by implementing this interface; the
 * rest of the pipeline (idempotency, fulfillment) does not change.
 */
export interface PaymentProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** Verifies authenticity first, then parses. Never returns unverified data. */
  verifyAndParse(rawBody: Buffer, headers: Headers, now: Date): ParsedWebhook;
}

export const MAX_WEBHOOK_BYTES = 16 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const MIN_SECRET_LENGTH = 32;

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Sandbox provider used for development and tests.
 *
 * Signature header `X-Mtandao-Signature: t=<unix seconds>,v1=<hex>` where
 * v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Requests older or newer than
 * five minutes are refused, which limits replay of captured requests.
 *
 * It confirms payments without real money: enable it only outside production.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'sandbox';

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private secret(): string | undefined {
    const secret = this.env.PAYMENT_SANDBOX_WEBHOOK_SECRET;
    return secret && secret.length >= MIN_SECRET_LENGTH ? secret : undefined;
  }

  isConfigured(): boolean {
    return this.secret() !== undefined;
  }

  verifyAndParse(rawBody: Buffer, headers: Headers, now: Date): ParsedWebhook {
    const secret = this.secret();
    if (!secret) throw new WebhookRejectedError('signature', 'provider is not configured');
    if (rawBody.length === 0 || rawBody.length > MAX_WEBHOOK_BYTES) {
      throw new WebhookRejectedError('malformed', 'invalid body size');
    }

    const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header(headers, 'x-mtandao-signature') ?? '');
    if (!match) throw new WebhookRejectedError('signature', 'missing or malformed signature');
    const timestamp = Number(match[1]);
    if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
      throw new WebhookRejectedError('signature', 'signature timestamp outside tolerance');
    }

    const expected = createHmac('sha256', secret).update(`${match[1]}.`).update(rawBody).digest();
    const received = Buffer.from(match[2], 'hex');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new WebhookRejectedError('signature', 'signature mismatch');
    }

    return this.parse(rawBody);
  }

  private parse(rawBody: Buffer): ParsedWebhook {
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new WebhookRejectedError('malformed', 'body is not JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new WebhookRejectedError('malformed', 'body must be an object');
    }
    const data = body as Record<string, unknown>;
    const { event_id: eventId, provider_ref: providerRef, status, amount, currency } = data;
    if (
      typeof eventId !== 'string' || eventId.length < 1 || eventId.length > 200 ||
      typeof providerRef !== 'string' || providerRef.length < 1 || providerRef.length > 100 ||
      (status !== 'succeeded' && status !== 'failed') ||
      typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 ||
      (currency !== 'CDF' && currency !== 'USD')
    ) {
      throw new WebhookRejectedError('malformed', 'unexpected webhook fields');
    }
    return { eventId, providerRef, status, amount, currency, payload: data };
  }
}
