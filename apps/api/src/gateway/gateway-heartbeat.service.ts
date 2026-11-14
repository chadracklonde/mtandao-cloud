import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface GatewayHeartbeatResult {
  routerId: string;
  siteId: string;
  status: 'online';
  lastSeenAt: string;
}

@Injectable()
export class GatewayHeartbeatService {
  async heartbeat(gatewayToken: string): Promise<GatewayHeartbeatResult> {
    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      throw new ServiceUnavailableException('Supabase is not configured');
    }

    const tokenHash = createHash('sha256').update(gatewayToken).digest('hex');
    let response: Response;
    try {
      response = await fetch(`${supabaseUrl}/rest/v1/rpc/record_gateway_heartbeat`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${anonKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ p_gateway_token_hash: tokenHash }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('Supabase is unavailable');
    }

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new UnauthorizedException('Gateway credential is invalid, revoked, or suspended');
    }
    if (!response.ok) {
      throw new BadGatewayException('Gateway heartbeat could not be recorded');
    }

    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new BadGatewayException('Supabase returned an invalid heartbeat response');
    }
    const row = rows[0] as {
      router_id?: unknown;
      site_id?: unknown;
      status?: unknown;
      last_seen_at?: unknown;
    };
    if (
      typeof row.router_id !== 'string' ||
      typeof row.site_id !== 'string' ||
      row.status !== 'online' ||
      typeof row.last_seen_at !== 'string'
    ) {
      throw new BadGatewayException('Supabase returned invalid heartbeat data');
    }

    return {
      routerId: row.router_id,
      siteId: row.site_id,
      status: 'online',
      lastSeenAt: row.last_seen_at,
    };
  }
}
