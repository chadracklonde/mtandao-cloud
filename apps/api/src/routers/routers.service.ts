import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { CreateRouterDto } from './create-router.dto';

export interface RouterSummary {
  id: string;
  name: string;\n  router_identity: string;\n  gateway_kind: 'android' | 'linux';\n  status: string;\n  last_seen_at: string | null;\n  created_at: string;\n}\n\nexport class RoutersService {\n  async list(siteId: string, accessToken: string): Promise<RouterSummary[]> {\n    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\\/$/, '');\n    const anonKey = process.env.SUPABASE_ANON_KEY;\n    if (!supabaseUrl || !anonKey) throw new ServiceUnavailableException('Supabase is not configured');\n    const query = new URLSearchParams({\n      select: 'id,name,router_identity,gateway_kind,status,last_seen_at,created_at',\n      site_id: `eq.${siteId}`,\n      order: 'created_at.desc',\n    });\n    let response: Response;\n    try {\n      response = await fetch(`${supabaseUrl}/rest/v1/routers?${query.toString()}`, {\n        headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` },\n        signal: AbortSignal.timeout(10000),\n      });\n    } catch { throw new ServiceUnavailableException('Supabase is unavailable'); }\n    if (!response.ok) throw new BadGatewayException('Unable to list routers for this site');\n    return (await response.json()) as RouterSummary[];\n  }

  async register(
    siteId: string,
    dto: CreateRouterDto,
    accessToken: string,
  ): Promise<{ routerId: string; enrollmentToken: string; expiresInSeconds: number }> {
    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      throw new ServiceUnavailableException('Supabase is not configured');
    }

    const enrollmentToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(enrollmentToken).digest('hex');

    let response: Response;
    try {
      response = await fetch(`${supabaseUrl}/rest/v1/rpc/register_router`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          p_site_id: siteId,
          p_name: dto.name.trim(),
          p_router_identity: dto.routerIdentity.trim(),
          p_gateway_kind: dto.gatewayKind,
          p_enrollment_token_hash: tokenHash,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('Supabase is unavailable');
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      if (response.status === 401 || response.status === 403) {
        throw new BadGatewayException('Supabase rejected router registration');
      }
      throw new BadGatewayException(`Router registration failed: ${detail || response.statusText}`);
    }

    const routerId: unknown = await response.json();
    if (typeof routerId !== 'string') {
      throw new BadGatewayException('Supabase returned an invalid router identifier');
    }

    // The plaintext token is returned once and is never stored in the database.
    return { routerId, enrollmentToken, expiresInSeconds: 900 };
  }
}
