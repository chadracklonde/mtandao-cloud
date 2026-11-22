import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { parseInstant } from '../commerce/commerce.service';

export type ReportGroup = 'day' | 'month';

export interface SalesReportRow {
  period: string;
  currency: string;
  sales_count: number;
  total_amount: number;
  cash_amount: number;
  mobile_money_amount: number;
}

export interface Discrepancy {
  kind: string;
  reference_id: string;
  occurred_at: string;
  details: Record<string, unknown>;
}

export interface ReconciliationReport {
  items: Discrepancy[];
  summary: Record<string, number>;
  truncated: boolean;
}

export const RECONCILIATION_LIMIT = 500;
export const CONFLICT_LIMIT = 200;
export type ConflictResolution = 'keep_cloud' | 'dismissed';

export interface SyncConflict {
  id: string;
  event_id: string;
  conflict_type: string;
  details: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
  resolution_note: string | null;
}

@Injectable()
export class ReportsService {
  private async rpc(
    name: string,
    body: Record<string, unknown>,
    accessToken: string,
  ): Promise<unknown[]> {
    const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new ServiceUnavailableException('Supabase is not configured');

    let response: Response;
    try {
      response = await fetch(`${url}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ServiceUnavailableException('Supabase is unavailable');
    }

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { code?: string };
      if (error.code === '42501') throw new ForbiddenException('Insufficient permission to read reports');
      if (error.code === '22023') throw new BadRequestException('Invalid report period or grouping');
      throw new BadGatewayException('Unable to build the report');
    }
    const rows: unknown = await response.json().catch(() => null);
    if (!Array.isArray(rows)) throw new BadGatewayException('Supabase returned an invalid report');
    return rows;
  }

  private period(from?: string, to?: string): { p_from: string | null; p_to: string | null } {
    return {
      p_from: from ? parseInstant(from, 'from') : null,
      p_to: to ? parseInstant(to, 'to') : null,
    };
  }

  async sales(
    siteId: string,
    accessToken: string,
    options: { from?: string; to?: string; group?: string } = {},
  ): Promise<SalesReportRow[]> {
    const group = options.group ?? 'day';
    if (group !== 'day' && group !== 'month') {
      throw new BadRequestException('group must be day or month');
    }
    const rows = await this.rpc(
      'sales_report',
      { p_site_id: siteId, ...this.period(options.from, options.to), p_group: group },
      accessToken,
    );
    return rows as SalesReportRow[];
  }

  async reconciliation(
    siteId: string,
    accessToken: string,
    options: { from?: string; to?: string } = {},
  ): Promise<ReconciliationReport> {
    const rows = (await this.rpc(
      'reconciliation_report',
      { p_site_id: siteId, ...this.period(options.from, options.to) },
      accessToken,
    )) as Discrepancy[];

    const summary: Record<string, number> = {};
    for (const row of rows) summary[row.kind] = (summary[row.kind] ?? 0) + 1;
    return { items: rows, summary, truncated: rows.length >= RECONCILIATION_LIMIT };
  }

  private config(): { url: string; anonKey: string } {
    const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new ServiceUnavailableException('Supabase is not configured');
    return { url, anonKey };
  }

  /** Synchronization conflicts, newest first. RLS restricts rows to the caller's sites. */
  async conflicts(siteId: string, accessToken: string, status: string | undefined): Promise<SyncConflict[]> {
    if (status !== undefined && status !== 'open' && status !== 'resolved' && status !== 'all') {
      throw new BadRequestException('status must be open, resolved or all');
    }
    const { url, anonKey } = this.config();
    const query = new URLSearchParams({
      select: 'id,event_id,conflict_type,details,created_at,resolved_at,resolution,resolution_note',
      site_id: `eq.${siteId}`,
      order: 'created_at.desc',
      limit: String(CONFLICT_LIMIT),
    });
    if ((status ?? 'open') === 'open') query.set('resolved_at', 'is.null');
    if (status === 'resolved') query.set('resolved_at', 'not.is.null');

    let response: Response;
    try {
      response = await fetch(`${url}/rest/v1/sync_conflicts?${query}`, {
        headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ServiceUnavailableException('Supabase is unavailable');
    }
    const rows: unknown = response.ok ? await response.json().catch(() => null) : null;
    if (!Array.isArray(rows)) throw new BadGatewayException('Unable to read synchronization conflicts');
    return rows as SyncConflict[];
  }

  async resolveConflict(
    siteId: string,
    conflictId: string,
    resolution: ConflictResolution,
    note: string | undefined,
    accessToken: string,
  ): Promise<unknown> {
    const { url, anonKey } = this.config();
    let response: Response;
    try {
      response = await fetch(`${url}/rest/v1/rpc/resolve_sync_conflict`, {
        method: 'POST',
        headers: { apikey: anonKey, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ p_site_id: siteId, p_conflict_id: conflictId, p_resolution: resolution, p_note: note ?? null }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ServiceUnavailableException('Supabase is unavailable');
    }
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { code?: string };
      if (error.code === '42501') throw new ForbiddenException('Insufficient permission to resolve conflicts');
      if (error.code === 'P0002') throw new NotFoundException('Conflict not found');
      if (error.code === '23505') throw new ConflictException('Conflict already resolved');
      if (error.code === '22023') throw new BadRequestException('Invalid resolution or note');
      throw new BadGatewayException('Unable to resolve the conflict');
    }
    return response.json().catch(() => ({}));
  }
}
