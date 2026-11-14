import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

export interface RedeemedGateway {
  routerId: string;
  siteId: string;
  gatewayToken: string;
}

@Injectable()
export class GatewayEnrollmentService {
  async redeem(enrollmentToken: string): Promise<RedeemedGateway> {
    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      throw new ServiceUnavailableException('Supabase is not configured');
    }

    const enrollmentHash = createHash('sha256').update(enrollmentToken).digest('hex');
    const gatewayToken = randomBytes(32).toString('hex');
    const gatewayTokenHash = createHash('sha256').update(gatewayToken).digest('hex');

    let response: Response;
    try {
      response = await fetch(`${supabaseUrl}/rest/v1/rpc/redeem_gateway_enrollment`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${anonKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          p_enrollment_token_hash: enrollmentHash,
          p_gateway_token_hash: gatewayTokenHash,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('Supabase is unavailable');
    }

    if (response.status === 401 || response.status === 403 || response.status === 400) {
      throw new UnauthorizedException('Enrollment token is invalid, expired, or already used');
    }
    if (!response.ok) {
      throw new BadGatewayException('Gateway enrollment could not be completed');
    }

    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new BadGatewayException('Supabase returned an invalid enrollment response');
    }
    const row = rows[0] as { router_id?: unknown; site_id?: unknown };
    if (typeof row.router_id !== 'string' || typeof row.site_id !== 'string') {
      throw new BadGatewayException('Supabase returned invalid Gateway identifiers');
    }

    // The permanent secret is returned once. Only its SHA-256 hash is persisted.
    return { routerId: row.router_id, siteId: row.site_id, gatewayToken };
  }
}
