import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SyncEventsBatchDto } from './sync-event.dto';

export interface SyncAcknowledgement {
  site_id: string;
  received_count: number;
  inserted_count: number;
  acknowledged_event_ids: string[];
}

@Injectable()
export class SyncService {
  async ingest(
    siteId: string,
    batch: SyncEventsBatchDto,
    accessToken: string,
  ): Promise<SyncAcknowledgement> {
    if (batch.events.some((event) => event.site_id !== siteId)) {
      throw new BadGatewayException('Every event must belong to the requested site');
    }

    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      throw new ServiceUnavailableException('Supabase is not configured');
    }

    let response: Response;
    try {
      response = await fetch(`${supabaseUrl}/rest/v1/rpc/ingest_sync_events`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ p_site_id: siteId, p_events: batch.events }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ServiceUnavailableException('Sync storage is unavailable');
    }

    if (response.status === 401 || response.status === 403) {
      throw new BadGatewayException('Sync storage rejected the request');
    }
    if (!response.ok) {
      throw new BadGatewayException('Unable to persist synchronization events');
    }

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new BadGatewayException('Sync storage returned an invalid acknowledgement');
    }

    if (
      !result ||
      typeof result !== 'object' ||
      (result as Record<string, unknown>).site_id !== siteId ||
      (result as Record<string, unknown>).received_count !== batch.events.length ||
      !Array.isArray((result as Record<string, unknown>).acknowledged_event_ids)
    ) {
      throw new BadGatewayException('Sync storage returned an invalid acknowledgement');
    }

    const ack = result as SyncAcknowledgement;
    const acknowledged = new Set(ack.acknowledged_event_ids);
    if (batch.events.some((event) => !acknowledged.has(event.id))) {
      throw new BadGatewayException('Sync acknowledgement is incomplete');
    }
    return ack;
  }
}
