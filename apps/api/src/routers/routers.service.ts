import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { CreateRouterDto } from './create-router.dto';

@Injectable()
export class RoutersService {
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
