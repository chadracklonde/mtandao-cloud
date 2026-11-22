import {
  BadGatewayException,
  BadRequestException,
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
}
