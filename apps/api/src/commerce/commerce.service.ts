import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { URLSearchParams } from 'node:url';
import { CreatePlanDto } from './commerce.dto';

export type CommerceResource = 'sales' | 'tickets' | 'cash-entries' | 'payments';

interface ResourceConfig {
  table: string;
  timeColumn: string;
  select: string;
}

const RESOURCES: Record<CommerceResource, ResourceConfig> = {
  sales: {
    table: 'sales',
    timeColumn: 'sold_at',
    select:
      'id,source_event_id,device_id,amount,currency,payment_method,plan_name,ticket_code,sold_at,created_at',
  },
  tickets: {
    table: 'tickets',
    timeColumn: 'created_at',
    select: 'id,code,sale_id,status,created_at',
  },
  payments: {
    table: 'payments',
    timeColumn: 'created_at',
    // The customer phone number is deliberately not listed.
    select:
      'id,plan_id,router_id,provider,provider_ref,amount,currency,status,fulfillment_status,ticket_code,sale_id,created_at,expires_at,paid_at',
  },
  'cash-entries': {
    table: 'cash_entries',
    timeColumn: 'occurred_at',
    select: 'id,sale_id,direction,amount,currency,occurred_at,created_at',
  },
};

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

export interface ListOptions {
  limit?: number;
  from?: string;
  to?: string;
  cursor?: string;
}

export interface Page<T = Record<string, unknown>> {
  items: T[];
  next_cursor: string | null;
}

const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function parseInstant(value: string, name: string): string {
  const time = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(time)) {
    throw new BadRequestException(`${name} must be an ISO 8601 date`);
  }
  return new Date(time).toISOString();
}

@Injectable()
export class CommerceService {
  private config(): { url: string; anonKey: string } {
    const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new ServiceUnavailableException('Supabase is not configured');
    return { url, anonKey };
  }

  private async call(path: string, init: RequestInit, token: string): Promise<Response> {
    const { url, anonKey } = this.config();
    try {
      return await fetch(`${url}/rest/v1/${path}`, {
        ...init,
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('Supabase is unavailable');
    }
  }

  /** Newest first, keyset-paginated on (time column, id). RLS limits rows to site members. */
  async list(
    resource: CommerceResource,
    siteId: string,
    accessToken: string,
    options: ListOptions = {},
  ): Promise<Page> {
    const cfg = RESOURCES[resource];
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? LIST_DEFAULT_LIMIT) || LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);

    const query = new URLSearchParams({
      select: `${cfg.select}`,
      site_id: `eq.${siteId}`,
      order: `${cfg.timeColumn}.desc,id.desc`,
      limit: String(limit),
    });
    if (options.from) query.append(cfg.timeColumn, `gte.${parseInstant(options.from, 'from')}`);
    if (options.to) query.append(cfg.timeColumn, `lt.${parseInstant(options.to, 'to')}`);
    if (options.cursor) {
      const match = CURSOR_PATTERN.exec(options.cursor);
      if (!match) throw new BadRequestException('cursor is invalid');
      const [, time, id] = match;
      query.set(
        'or',
        `(${cfg.timeColumn}.lt.${time},and(${cfg.timeColumn}.eq.${time},id.lt.${id}))`,
      );
    }

    const response = await this.call(`${cfg.table}?${query.toString()}`, { method: 'GET' }, accessToken);
    if (!response.ok) throw new BadGatewayException(`Unable to list ${resource}`);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new BadGatewayException(`Supabase returned an invalid ${resource} list`);

    const items = rows as Array<Record<string, unknown>>;
    const last = items[items.length - 1];
    const next =
      items.length === limit && last && typeof last[cfg.timeColumn] === 'string' && typeof last.id === 'string'
        ? `${String(last[cfg.timeColumn])}|${last.id}`
        : null;
    return { items, next_cursor: next };
  }

  async listPlans(siteId: string, accessToken: string): Promise<unknown[]> {
    const query = new URLSearchParams({
      select: 'id,name,price,currency,duration_minutes,data_limit_mb,active,created_at,updated_at',
      site_id: `eq.${siteId}`,
      order: 'name.asc',
    });
    const response = await this.call(`plans?${query.toString()}`, { method: 'GET' }, accessToken);
    if (!response.ok) throw new BadGatewayException('Unable to list plans');
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new BadGatewayException('Supabase returned an invalid plan list');
    return rows;
  }

  private async rpc(name: string, body: unknown, token: string, what: string): Promise<unknown> {
    const response = await this.call(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) }, token);
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { code?: string };
      if (error.code === '42501') throw new ForbiddenException(`Insufficient permission: ${what}`);
      if (error.code === 'P0002') throw new NotFoundException('Plan not found in this site');
      if (error.code === '23505') throw new BadRequestException('A plan with this name already exists');
      if (error.code === '22023') throw new BadRequestException(`Invalid request: ${what}`);
      throw new BadGatewayException(`Unable to ${what}`);
    }
    try {
      return await response.json();
    } catch {
      throw new BadGatewayException(`Supabase returned an invalid response: ${what}`);
    }
  }

  async createPlan(siteId: string, dto: CreatePlanDto, token: string): Promise<{ planId: string }> {
    const result = await this.rpc(
      'create_plan',
      {
        p_site_id: siteId,
        p_name: dto.name.trim(),
        p_price: dto.price,
        p_currency: dto.currency,
        p_duration_minutes: dto.durationMinutes,
        p_data_limit_mb: dto.dataLimitMb ?? null,
        p_hotspot_profile: dto.hotspotProfile ?? null,
      },
      token,
      'create plan',
    );
    if (typeof result !== 'string') throw new BadGatewayException('Supabase returned an invalid plan identifier');
    return { planId: result };
  }

  async setPlanActive(siteId: string, planId: string, active: boolean, token: string): Promise<{ planId: string; active: boolean }> {
    const result = await this.rpc(
      'set_plan_active',
      { p_site_id: siteId, p_plan_id: planId, p_active: active },
      token,
      'update plan',
    );
    if (result !== planId) throw new BadGatewayException('Supabase returned an invalid plan result');
    return { planId, active };
  }

  async importTicketStock(
    siteId: string,
    planId: string,
    codes: string[],
    token: string,
  ): Promise<{ submitted: number; inserted: number; skipped: number }> {
    const result = (await this.rpc(
      'import_ticket_stock',
      { p_site_id: siteId, p_plan_id: planId, p_codes: codes },
      token,
      'import ticket stock',
    )) as Record<string, unknown> | null;
    if (
      !result ||
      typeof result.submitted !== 'number' ||
      typeof result.inserted !== 'number' ||
      typeof result.skipped !== 'number'
    ) {
      throw new BadGatewayException('Supabase returned an invalid import result');
    }
    return { submitted: result.submitted, inserted: result.inserted, skipped: result.skipped };
  }

  async stockSummary(siteId: string, token: string): Promise<unknown[]> {
    const result = await this.rpc('ticket_stock_summary', { p_site_id: siteId }, token, 'read stock summary');
    if (!Array.isArray(result)) throw new BadGatewayException('Supabase returned an invalid stock summary');
    return result;
  }
}
