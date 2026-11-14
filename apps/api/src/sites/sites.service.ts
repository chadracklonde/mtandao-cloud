import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CreateSiteDto } from './create-site.dto';

export interface SiteSummary {
  id: string;
  name: string;
  default_currency: 'CDF' | 'USD';
  timezone: string;
  status: string;
  created_at: string;
  role: string;
}

@Injectable()
export class SitesService {
  async list(accessToken: string, userId: string): Promise<SiteSummary[]> {
    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) throw new ServiceUnavailableException('Supabase is not configured');

    const query = new URLSearchParams({
      select: 'id,name,default_currency,timezone,status,created_at,site_memberships!inner(role)',
      'site_memberships.user_id': `eq.${userId}`,
      'site_memberships.status': 'eq.active',
      order: 'created_at.desc',
    });
    let response: Response;
    try {
      response = await fetch(`${supabaseUrl}/rest/v1/sites?${query.toString()}`, {
        headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('Supabase is unavailable');
    }
    if (!response.ok) throw new BadGatewayException('Unable to list accessible sites');

    const rows = (await response.json()) as Array<Omit<SiteSummary, 'role'> & {
      site_memberships?: Array<{ role?: string }>;
    }>;
    return rows.map(({ site_memberships, ...site }) => ({
      ...site,
      role: site_memberships?.[0]?.role ?? 'viewer',
    }));
  }

  async create(dto: CreateSiteDto, accessToken: string): Promise<{ id: string }> {
    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      throw new ServiceUnavailableException('Supabase is not configured');
    }

    let response: Response;
    try {
      response = await fetch(`${supabaseUrl}/rest/v1/rpc/create_site_with_owner`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          p_name: dto.name.trim(),
          p_default_currency: dto.defaultCurrency,
          p_timezone: dto.timezone,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('Database service is unavailable');
    }

    if (response.status === 401 || response.status === 403) {
      throw new ServiceUnavailableException('Supabase rejected the authenticated request');
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new BadGatewayException(`Site creation failed: ${detail || response.statusText}`);
    }

    const id: unknown = await response.json();
    if (typeof id !== 'string') {
      throw new BadGatewayException('Supabase returned an invalid site identifier');
    }
    return { id };
  }
}
