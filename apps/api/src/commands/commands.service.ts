import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { CreateGatewayCommandDto, CreateVoucherDto } from './commands.dto';

export const COMMAND_STATUSES = ['pending', 'delivered', 'succeeded', 'failed', 'expired', 'cancelled'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export interface GatewayCommand {
  command_id: string;
  site_id: string;
  gateway_id: string;
  router_id: string;
  operation: string;
  issued_at: string;
  expires_at: string;
  payload: Record<string, unknown>;
}

export interface CommandRecord {
  id: string;
  router_id: string;
  operation: string;
  payload: Record<string, unknown>;
  status: CommandStatus;
  issued_at: string;
  expires_at: string;
  delivered_at: string | null;
  completed_at: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

const LIST_SELECT =
  'id,router_id,operation,payload,status,issued_at,expires_at,delivered_at,completed_at,result,error';

@Injectable()
export class CommandsService {
  private config(): { url: string; anonKey: string } {
    const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new ServiceUnavailableException('Supabase is not configured');
    return { url, anonKey };
  }

  private async request(path: string, init: RequestInit, bearer: string): Promise<Response> {
    const { url, anonKey } = this.config();
    try {
      return await fetch(`${url}/rest/v1/${path}`, {
        ...init,
        headers: { apikey: anonKey, authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('Supabase is unavailable');
    }
  }

  private async rpc(name: string, body: unknown, bearer: string, gateway = false): Promise<unknown> {
    const response = await this.request(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) }, bearer);
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { code?: string };
      switch (error.code) {
        case '28000':
          throw new UnauthorizedException('Gateway credential is invalid, revoked, or suspended');
        case '42501':
          throw gateway
            ? new UnauthorizedException('Gateway credential is invalid, revoked, or suspended')
            : new ForbiddenException('Insufficient permission for this command');
        case 'P0002':
          throw new NotFoundException('Router or command not found');
        case '23505':
          throw new ConflictException('Idempotency key already used for a different command');
        case '53400':
          throw new ConflictException('Too many open commands for this router');
        case '22023':
          throw gateway ? new ConflictException('Command is not awaiting a result') : new BadRequestException('Invalid command or router state');
        default:
          throw new BadGatewayException('Command operation failed');
      }
    }
    try {
      return await response.json();
    } catch {
      throw new BadGatewayException('Supabase returned an invalid response');
    }
  }

  // ---- User side -----------------------------------------------------------

  async create(
    siteId: string,
    routerId: string,
    dto: CreateGatewayCommandDto,
    accessToken: string,
  ): Promise<{ commandId: string }> {
    const result = await this.rpc(
      'create_gateway_command',
      {
        p_site_id: siteId,
        p_router_id: routerId,
        p_operation: dto.operation,
        p_payload: dto.payload ?? {},
        p_ttl_seconds: dto.ttlSeconds ?? 300,
        p_idempotency_key: dto.idempotencyKey ?? null,
      },
      accessToken,
    );
    if (typeof result !== 'string') throw new BadGatewayException('Supabase returned an invalid command identifier');
    return { commandId: result };
  }

  /**
   * Creates a Hotspot ticket from the Cloud. The usage time limit is always a
   * deliberate choice: taken from the plan, given explicitly, or declared
   * unlimited. The ticket gets the app-compatible comment so that the router's
   * profile script logs its sale and arms its expiry like any app-made ticket.
   */
  async createVoucher(
    siteId: string,
    routerId: string,
    dto: CreateVoucherDto,
    accessToken: string,
  ): Promise<{ commandId: string; usageLimitMinutes: number | null; dataLimitMb: number | null; comment: string }> {
    if (dto.unlimited && dto.usageLimitMinutes !== undefined) {
      throw new BadRequestException('unlimited cannot be combined with usageLimitMinutes');
    }

    let plan: { duration_minutes: number; hotspot_profile: string | null; data_limit_mb: number | null } | undefined;
    if (dto.planId) {
      const rows = await this.readRows(
        `plans?${new URLSearchParams({
          select: 'duration_minutes,hotspot_profile,data_limit_mb',
          site_id: `eq.${siteId}`,
          id: `eq.${dto.planId}`,
        }).toString()}`,
        accessToken,
      );
      plan = rows[0] as typeof plan;
      if (!plan) throw new NotFoundException('Plan not found in this site');
    }

    const usageLimit = dto.unlimited ? null : dto.usageLimitMinutes ?? plan?.duration_minutes ?? null;
    if (usageLimit === null && !dto.unlimited) {
      throw new BadRequestException('Choose the usage time limit: planId, usageLimitMinutes or unlimited=true');
    }
    const dataLimit = dto.dataLimitMb ?? plan?.data_limit_mb ?? null;
    const profile = dto.profile ?? plan?.hotspot_profile ?? null;

    const sites = await this.readRows(
      `sites?${new URLSearchParams({ select: 'timezone', id: `eq.${siteId}` }).toString()}`,
      accessToken,
    );
    const timezone = (sites[0] as { timezone?: string } | undefined)?.timezone;
    if (!timezone) throw new NotFoundException('Site not found');

    const comment = ticketComment(new Date(), timezone, dto.note ?? 'cloud');
    const payload: Record<string, unknown> = { code: dto.code, comment };
    if (usageLimit !== null) payload.duration_minutes = usageLimit;
    if (dataLimit !== null) payload.data_limit_mb = dataLimit;
    if (profile) payload.profile = profile;

    const { commandId } = await this.create(
      siteId,
      routerId,
      { operation: 'hotspot.voucher.create', payload, idempotencyKey: `voucher-${routerId}-${dto.code}` },
      accessToken,
    );
    return { commandId, usageLimitMinutes: usageLimit, dataLimitMb: dataLimit, comment };
  }

  private async readRows(path: string, accessToken: string): Promise<unknown[]> {
    const response = await this.request(path, { method: 'GET' }, accessToken);
    if (!response.ok) throw new BadGatewayException('Unable to read the plan or site');
    const rows: unknown = await response.json().catch(() => null);
    if (!Array.isArray(rows)) throw new BadGatewayException('Supabase returned an invalid response');
    return rows;
  }

  async cancel(siteId: string, commandId: string, accessToken: string): Promise<{ commandId: string; status: 'cancelled' }> {
    const result = await this.rpc('cancel_gateway_command', { p_site_id: siteId, p_command_id: commandId }, accessToken);
    if (result !== 'cancelled') throw new BadGatewayException('Supabase returned an invalid cancellation result');
    return { commandId, status: 'cancelled' };
  }

  async list(
    siteId: string,
    accessToken: string,
    options: { routerId?: string; status?: string; limit?: number } = {},
  ): Promise<CommandRecord[]> {
    if (options.status !== undefined && !(COMMAND_STATUSES as readonly string[]).includes(options.status)) {
      throw new BadRequestException('status is invalid');
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 50, 1), 200);
    const query = new URLSearchParams({
      select: LIST_SELECT,
      site_id: `eq.${siteId}`,
      order: 'issued_at.desc,id.desc',
      limit: String(limit),
    });
    if (options.routerId) query.set('router_id', `eq.${options.routerId}`);
    if (options.status === 'pending' || options.status === 'expired') {
      // A pending row past its expiry is reported as expired: fetch both, then filter.
      query.set('status', 'in.(pending,expired)');
    } else if (options.status) {
      query.set('status', `eq.${options.status}`);
    }

    const response = await this.request(`gateway_commands?${query.toString()}`, { method: 'GET' }, accessToken);
    if (!response.ok) throw new BadGatewayException('Unable to list commands');
    const rows: unknown = await response.json().catch(() => null);
    if (!Array.isArray(rows)) throw new BadGatewayException('Supabase returned an invalid command list');

    // A pending command past its expiry is expired even if no sweep has run yet.
    const now = Date.now();
    const records = (rows as CommandRecord[]).map(row =>
      row.status === 'pending' && Date.parse(row.expires_at) <= now ? { ...row, status: 'expired' as const } : row,
    );
    return options.status
      ? records.filter(row => row.status === options.status)
      : records;
  }

  // ---- Gateway side --------------------------------------------------------

  private hash(gatewayToken: string): string {
    return createHash('sha256').update(gatewayToken).digest('hex');
  }

  async claim(gatewayToken: string, limit = 10): Promise<{ commands: GatewayCommand[] }> {
    const { anonKey } = this.config();
    const rows = await this.rpc(
      'claim_gateway_commands',
      { p_gateway_token_hash: this.hash(gatewayToken), p_limit: limit },
      anonKey,
      true,
    );
    if (!Array.isArray(rows)) throw new BadGatewayException('Supabase returned an invalid command batch');
    return { commands: rows as GatewayCommand[] };
  }

  async report(
    gatewayToken: string,
    commandId: string,
    success: boolean,
    result: Record<string, unknown> | undefined,
    error: string | undefined,
  ): Promise<{ commandId: string; status: 'succeeded' | 'failed' }> {
    const { anonKey } = this.config();
    const status = await this.rpc(
      'complete_gateway_command',
      {
        p_gateway_token_hash: this.hash(gatewayToken),
        p_command_id: commandId,
        p_success: success,
        p_result: result ?? {},
        p_error: error ?? null,
      },
      anonKey,
      true,
    );
    if (status !== 'succeeded' && status !== 'failed') {
      throw new BadGatewayException('Supabase returned an invalid result status');
    }
    return { commandId, status };
  }
}

/**
 * Ticket comment in the Mikhmon / Mtandao Ticket format: `vc-DDMMYY-HHMM <note>`,
 * with the date and time of the site's own time zone.
 */
export function ticketComment(now: Date, timeZone: string, note: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string): string => parts.find(part => part.type === type)?.value ?? '00';
  const cleaned = note.replace(/[^A-Za-z0-9 .'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  return `vc-${get('day')}${get('month')}${get('year')}-${get('hour')}${get('minute')}${cleaned ? ` ${cleaned}` : ''}`;
}
