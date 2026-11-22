import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { URLSearchParams } from 'node:url';

export interface AuditEntry {
  id: number;
  site_id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, unknown>;
  occurred_at: string;
}

export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;

@Injectable()
export class AuditService {
  /**
   * Lists audit entries newest first. Authorization is enforced by the
   * database (RLS): only owners and admins of the site can read rows.
   * `before` is the id of the last entry already received (keyset pagination).
   */
  async list(
    siteId: string,
    accessToken: string,
    limit: number = AUDIT_DEFAULT_LIMIT,
    before?: number,
  ): Promise<AuditEntry[]> {
    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) throw new ServiceUnavailableException('Supabase is not configured');

    const safeLimit = Math.min(Math.max(Math.trunc(limit) || AUDIT_DEFAULT_LIMIT, 1), AUDIT_MAX_LIMIT);
    const query = new URLSearchParams({
      select: 'id,site_id,actor_user_id,action,entity_type,entity_id,details,occurred_at',
      site_id: `eq.${siteId}`,
      order: 'id.desc',
      limit: String(safeLimit),
    });
    if (before !== undefined) query.set('id', `lt.${Math.trunc(before)}`);

    let response: Response;
    try {
      response = await fetch(`${supabaseUrl}/rest/v1/audit_log?${query.toString()}`, {
        headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('Supabase is unavailable');
    }
    if (!response.ok) throw new BadGatewayException('Unable to read the audit log');

    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new BadGatewayException('Supabase returned an invalid audit log');
    return rows as AuditEntry[];
  }
}
